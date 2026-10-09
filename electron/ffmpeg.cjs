// ffmpeg helpers shared by the Electron app and the command-line tool.
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

// Bundled ffmpeg binary (unpacked from asar in production builds), system ffmpeg as fallback.
let ffmpegPath = 'ffmpeg';
try {
  const p = require('ffmpeg-static').replace('app.asar', 'app.asar.unpacked');
  if (fs.existsSync(p)) ffmpegPath = p;
} catch {}

let current = null; // running ffmpeg process
let cancelled = false;

function cancel() {
  if (current) { cancelled = true; current.kill('SIGKILL'); }
}

function run(args, { duration = 0, onProgress } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, ['-hide_banner', '-y', '-nostats', '-progress', 'pipe:1', ...args]);
    current = proc;
    let stderr = '';
    let buf = '';
    proc.stdout.on('data', (d) => {
      buf += d.toString();
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        const m = /^out_time_us=(\d+)/.exec(line);
        if (m && duration > 0 && onProgress) onProgress(Math.min(1, parseInt(m[1], 10) / 1e6 / duration));
      }
    });
    proc.stderr.on('data', (d) => { stderr = (stderr + d.toString()).slice(-4000); });
    proc.on('error', reject);
    proc.on('close', (code) => {
      current = null;
      if (cancelled) return reject(new Error('Cancelled'));
      if (code === 0) resolve();
      else reject(new Error(stderr.trim().split('\n').slice(-3).join('\n') || `ffmpeg exited with ${code}`));
    });
  });
}

// Reads duration and audio presence from `ffmpeg -i` output (avoids shipping ffprobe).
function probe(file) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, ['-hide_banner', '-i', file]);
    let out = '';
    proc.stderr.on('data', (d) => { out += d.toString(); });
    proc.on('error', reject);
    proc.on('close', () => {
      const d = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(out);
      if (!d) return reject(new Error('Could not read video file'));
      // Display size: coded size, swapped when the stream carries a 90° rotation.
      const v = /Stream #.*Video:.*?, (\d{2,5})x(\d{2,5})/.exec(out);
      const rot = /rotation of (-?[\d.]+) degrees/.exec(out);
      let width = v ? +v[1] : 0, height = v ? +v[2] : 0;
      if (rot && Math.abs(Math.round(parseFloat(rot[1]))) % 180 === 90) [width, height] = [height, width];
      resolve({
        width,
        height,
        duration: +d[1] * 3600 + +d[2] * 60 + parseFloat(d[3]),
        hasAudio: /Stream #.*Audio:/.test(out),
        hasVideo: /Stream #.*Video:/.test(out),
      });
    });
  });
}

// Keep ranges = [start, end] minus the cut-out segments.
function keepSegments(start, end, cuts) {
  const sorted = cuts
    .map((c) => ({ start: Math.max(start, c.start), end: Math.min(end, c.end) }))
    .filter((c) => c.end > c.start)
    .sort((a, b) => a.start - b.start);
  const keep = [];
  let pos = start;
  for (const c of sorted) {
    if (c.start > pos) keep.push({ start: pos, end: c.start });
    pos = Math.max(pos, c.end);
  }
  if (end > pos) keep.push({ start: pos, end });
  return keep.filter((k) => k.end - k.start > 0.05);
}

const f = (n) => n.toFixed(3);

// Trim to [start, end], drop the cuts, apply zoom, and encode to H.264 MP4.
async function exportEdit({ input, output, start, end, cuts = [], zoom, onProgress }) {
  const { hasAudio, width, height } = await probe(input);
  const keep = keepSegments(start, end, cuts);
  if (!keep.length) throw new Error('Nothing left to export');
  const total = keep.reduce((s, k) => s + k.end - k.start, 0);

  const parts = [];
  let concatIn = '';
  keep.forEach((k, i) => {
    parts.push(`[0:v]trim=start=${f(k.start)}:end=${f(k.end)},setpts=PTS-STARTPTS[v${i}]`);
    concatIn += `[v${i}]`;
    if (hasAudio) {
      parts.push(`[0:a]atrim=start=${f(k.start)}:end=${f(k.end)},asetpts=PTS-STARTPTS[a${i}]`);
      concatIn += `[a${i}]`;
    }
  });
  parts.push(`${concatIn}concat=n=${keep.length}:v=1:a=${hasAudio ? 1 : 0}[vc]${hasAudio ? '[ac]' : ''}`);

  // Zoom: crop a 1/scale window positioned by (x, y) in 0..1, then scale back to the original size.
  const z = zoom && zoom.scale > 1.001 ? zoom : null;
  const outW = width ? width - (width % 2) : 'trunc(iw/2)*2';
  const outH = height ? height - (height % 2) : 'trunc(ih/2)*2';
  const post = z
    ? `crop=w=iw/${z.scale}:h=ih/${z.scale}:x=(iw-ow)*${z.x}:y=(ih-oh)*${z.y},` +
      `scale=${outW}:${outH}:flags=lanczos,setsar=1`
    : `scale=${outW}:${outH},setsar=1`;
  parts.push(`[vc]${post}[vout]`);

  cancelled = false;
  onProgress?.(0);
  await run(
    [
      '-i', input,
      '-filter_complex', parts.join(';'),
      '-map', '[vout]', ...(hasAudio ? ['-map', '[ac]', '-c:a', 'aac', '-b:a', '192k'] : []),
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p',
      '-fps_mode', 'passthrough', '-movflags', '+faststart',
      output,
    ],
    { duration: total, onProgress },
  );
  return { path: output, size: fs.statSync(output).size, duration: total };
}

// Two-pass encode to fit targetMB, optionally starting `start` seconds in.
async function compress({ input, output, targetMB, start = 0, onProgress }) {
  const info = await probe(input);
  const { hasAudio } = info;
  const duration = info.duration - start;
  if (duration <= 0.05) throw new Error('Nothing left to compress');
  const passlog = path.join(os.tmpdir(), `shotmaster-${process.pid}-${Date.now()}`);
  const seek = start > 0 ? ['-ss', f(start)] : [];

  // Bit budget with ~4% headroom for container overhead.
  const targetBytes = targetMB * 1000 * 1000;
  const totalKbps = (targetBytes * 8 * 0.96) / duration / 1000;
  let audioKbps = hasAudio ? 128 : 0;
  if (hasAudio && totalKbps < 600) audioKbps = 64;
  if (hasAudio && totalKbps < 200) audioKbps = 32;

  cancelled = false;
  let factor = 1;
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const videoKbps = Math.floor((totalKbps - audioKbps) * factor);
      if (videoKbps < 40) throw new Error(`${targetMB} MB is too small for a ${duration.toFixed(1)}s video`);

      // Lower the resolution when the bitrate can't sustain it.
      const maxH = videoKbps < 400 ? 360 : videoKbps < 900 ? 480 : videoKbps < 2000 ? 720 : videoKbps < 4500 ? 1080 : 0;
      const vf = maxH ? ['-vf', `scale=-2:'min(ih,${maxH})',setsar=1`] : [];
      const common = [...seek, '-i', input, ...vf, '-c:v', 'libx264', '-preset', 'medium', '-b:v', `${videoKbps}k`,
        '-pix_fmt', 'yuv420p', '-passlogfile', passlog];

      onProgress?.(0);
      await run([...common, '-pass', '1', '-an', '-f', 'null', '-'], {
        duration, onProgress: (p) => onProgress?.(p / 2),
      });
      await run(
        [...common, '-pass', '2', ...(hasAudio ? ['-c:a', 'aac', '-b:a', `${audioKbps}k`] : ['-an']),
          '-movflags', '+faststart', output],
        { duration, onProgress: (p) => onProgress?.(0.5 + p / 2) },
      );
      const size = fs.statSync(output).size;
      if (size <= targetBytes) return { path: output, size };
      factor *= (targetBytes / size) * 0.95; // overshot: retry with a lower bitrate
    }
    const size = fs.statSync(output).size;
    return { path: output, size };
  } finally {
    for (const ext of ['-0.log', '-0.log.mbtree', '-0.log.temp', '-0.log.mbtree.temp']) {
      fs.rm(passlog + ext, { force: true }, () => {});
    }
  }
}

module.exports = { ffmpegPath, run, probe, cancel, keepSegments, exportEdit, compress };
