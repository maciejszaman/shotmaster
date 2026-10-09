const { app, BrowserWindow, ipcMain, dialog, protocol, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');

const { ffmpegPath, probe, cancel, exportEdit, compress } = require('./ffmpeg.cjs');

const { cli, isCliArgs } = require('../cli/shotmaster.cjs');

const isDev = process.argv.includes('--dev');

// `Shotmaster -s video.mp4 ...` runs the command-line tool instead of opening a window.
const cliArgs = process.argv.slice(app.isPackaged ? 1 : 2);
const cliMode = isCliArgs(cliArgs);
if (cliMode) {
  app.disableHardwareAcceleration();
  cli(cliArgs);
}

protocol.registerSchemesAsPrivileged([
  { scheme: 'media', privileges: { standard: true, stream: true, supportFetchAPI: true, secure: true, bypassCSP: true } },
]);

const MIME = {
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm',
  '.mkv': 'video/x-matroska', '.ogv': 'video/ogg', '.avi': 'video/x-msvideo',
  '.jpg': 'image/jpeg',
};

// Pull-based stream over a byte range of a file; stops reading as soon as the request is aborted.
function fileStream(filePath, start, end) {
  let fh;
  let pos = start;
  return new ReadableStream({
    async start() { fh = await fs.promises.open(filePath, 'r'); },
    async pull(controller) {
      const len = Math.min(256 * 1024, end - pos + 1);
      if (len <= 0) { await fh.close(); return controller.close(); }
      const buf = Buffer.alloc(len);
      const { bytesRead } = await fh.read(buf, 0, len, pos);
      if (!bytesRead) { await fh.close(); return controller.close(); }
      pos += bytesRead;
      controller.enqueue(new Uint8Array(buf.buffer, buf.byteOffset, bytesRead));
    },
    async cancel() { await fh?.close(); },
  });
}

// Serves local files to the <video> element with HTTP range support so seeking works.
async function handleMedia(req) {
  const filePath = new URL(req.url).searchParams.get('p');
  const { size } = await fs.promises.stat(filePath);
  const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
  const m = /bytes=(\d*)-(\d*)/.exec(req.headers.get('range') || '');
  let start = 0, end = size - 1;
  if (m) {
    if (m[1]) start = parseInt(m[1], 10);
    if (m[2]) end = m[1] ? parseInt(m[2], 10) : size - 1;
    if (!m[1] && m[2]) start = Math.max(0, size - parseInt(m[2], 10));
    end = Math.min(end, size - 1);
  }
  const headers = { 'Content-Type': type, 'Content-Length': String(end - start + 1), 'Accept-Ranges': 'bytes' };
  if (m) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  return new Response(fileStream(filePath, start, end), { status: m ? 206 : 200, headers });
}

let win;
function createWindow() {
  win = new BrowserWindow({
    width: 1100,
    height: 820,
    minWidth: 760,
    minHeight: 600,
    backgroundColor: '#111113',
    autoHideMenuBar: true,
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  if (isDev) win.loadURL('http://localhost:5173');
  else win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
}

if (!cliMode) app.whenReady().then(() => {
  protocol.handle('media', handleMedia);
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

const send = (stage, value) => win && win.webContents.send('progress', { stage, value });

// ---------- IPC ----------

ipcMain.handle('open-video', async () => {
  const res = await dialog.showOpenDialog(win, {
    properties: ['openFile'],
    filters: [{ name: 'Video', extensions: ['mp4', 'mov', 'm4v', 'webm', 'mkv', 'avi', 'ogv'] }],
  });
  return res.canceled ? null : res.filePaths[0];
});

ipcMain.handle('probe', (_e, file) => probe(file));

ipcMain.handle('cancel', () => cancel());

// ---------- Recent videos gallery ----------

const VIDEO_EXT = new Set(['.mp4', '.mov', '.m4v', '.webm', '.mkv', '.avi', '.ogv']);

// Newest videos in the OS Videos folder (and its subfolders, e.g. Screencasts).
ipcMain.handle('list-recent', async (_e, limit = 40) => {
  const root = app.getPath('videos');
  const found = [];
  async function walk(dir, depth) {
    let entries;
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      if (ent.name.startsWith('.')) continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) { if (depth < 3) await walk(full, depth + 1); }
      else if (ent.isFile() && VIDEO_EXT.has(path.extname(ent.name).toLowerCase())) {
        try {
          const st = await fs.promises.stat(full);
          found.push({ path: full, name: ent.name, size: st.size, mtime: st.mtimeMs });
        } catch {}
      }
    }
  }
  await walk(root, 0);
  found.sort((a, b) => b.mtime - a.mtime);
  const home = os.homedir();
  const dir = root.startsWith(home) ? `~${root.slice(home.length)}` : root;
  return { dir, files: found.slice(0, limit) };
});

// Thumbnail + duration, cached in userData by path/size/mtime. Max 3 ffmpeg jobs at once.
const thumbDir = () => path.join(app.getPath('userData'), 'thumbs');
let thumbJobs = 0;
const thumbQueue = [];
const withThumbSlot = (fn) => new Promise((resolve, reject) => {
  const go = () => {
    thumbJobs++;
    fn().then(resolve, reject).finally(() => { thumbJobs--; thumbQueue.shift()?.(); });
  };
  thumbJobs < 3 ? go() : thumbQueue.push(go);
});

function grabFrame(file, out, seek) {
  return new Promise((resolve) => {
    const proc = spawn(ffmpegPath, ['-hide_banner', '-y', '-ss', String(seek), '-i', file,
      '-frames:v', '1', '-vf', 'scale=360:-2', '-q:v', '5', out]);
    let err = '';
    proc.stderr.on('data', (d) => { err += d.toString(); });
    proc.on('error', () => resolve(err));
    proc.on('close', () => resolve(err));
  });
}

ipcMain.handle('thumb', async (_e, file) => {
  const st = await fs.promises.stat(file);
  const key = crypto.createHash('sha1').update(`${file}|${st.size}|${st.mtimeMs}`).digest('hex');
  const dir = thumbDir();
  const jpg = path.join(dir, `${key}.jpg`), meta = path.join(dir, `${key}.json`);
  try { return { thumb: fs.existsSync(jpg) ? jpg : null, ...JSON.parse(await fs.promises.readFile(meta, 'utf8')) }; } catch {}

  return withThumbSlot(async () => {
    await fs.promises.mkdir(dir, { recursive: true });
    let out = await grabFrame(file, jpg, 1);
    if (!fs.existsSync(jpg)) out = await grabFrame(file, jpg, 0); // clips shorter than 1s
    const d = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(out);
    const info = { duration: d ? +d[1] * 3600 + +d[2] * 60 + parseFloat(d[3]) : 0 };
    await fs.promises.writeFile(meta, JSON.stringify(info));
    return { thumb: fs.existsSync(jpg) ? jpg : null, ...info };
  });
});

ipcMain.handle('show-in-folder', (_e, file) => shell.showItemInFolder(file));

ipcMain.handle('export', async (_e, { input, start, end, cuts, zoom }) => {
  const parsed = path.parse(input);
  const res = await dialog.showSaveDialog(win, {
    defaultPath: path.join(parsed.dir, `${parsed.name}_edit.mp4`),
    filters: [{ name: 'MP4 video', extensions: ['mp4'] }],
  });
  if (res.canceled) return null;
  const output = res.filePath.toLowerCase().endsWith('.mp4') ? res.filePath : `${res.filePath}.mp4`;
  return exportEdit({ input, output, start, end, cuts, zoom, onProgress: (p) => send('export', p) });
});

ipcMain.handle('compress', (_e, { input, targetMB }) => {
  const parsed = path.parse(input);
  const output = path.join(parsed.dir, `${parsed.name}_${targetMB}MB.mp4`);
  return compress({ input, output, targetMB, onProgress: (p) => send('compress', p) });
});
