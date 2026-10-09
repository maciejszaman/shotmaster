#!/usr/bin/env node
// Command-line front end: shotmaster -s <source> -o <output> [-t <percent>] [-c <MB>]
const path = require('path');
const os = require('os');
const fs = require('fs');
const { probe, cancel, exportEdit, compress } = require('../electron/ffmpeg.cjs');

const USAGE = `Usage: shotmaster -s <source> [-o <output>] [-t <percent>] [-c <MB>]

  -s, --source    input video
  -o, --output    output .mp4 (default: <source>_edit.mp4, or <source>_<MB>MB.mp4 with -c)
  -t, --timeline  start the clip at this percent of the video, 0-100 (default: 0)
  -c, --compress  compress the result to fit this many MB
  -h, --help      show this help

Example: shotmaster -s ~/Videos/clip.mp4 -o ~/Videos/out.mp4 -t 90 -c 8`;

const FLAGS = {
  '-s': 'source', '--source': 'source',
  '-o': 'output', '--output': 'output',
  '-t': 'timeline', '--timeline': 'timeline',
  '-c': 'compress', '--compress': 'compress',
};

function fail(msg) {
  console.error(`shotmaster: ${msg}`);
  process.exit(1);
}

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') { console.log(USAGE); process.exit(0); }
    const key = FLAGS[a];
    if (!key) fail(`unknown option '${a}'\n\n${USAGE}`);
    if (i + 1 >= argv.length) fail(`${a} needs a value`);
    opts[key] = argv[++i];
  }
  return opts;
}

// Expand a leading ~ in case the path was quoted and the shell didn't.
const resolvePath = (p) => path.resolve(p.replace(/^~(?=$|[\\/])/, os.homedir()));

const fmtSize = (b) => (b >= 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.round(b / 1e3)} KB`);

function progress(label) {
  if (!process.stderr.isTTY) return () => {};
  const width = 30;
  return (p) => {
    const n = Math.round(p * width);
    process.stderr.write(`\r${label} [${'#'.repeat(n)}${' '.repeat(width - n)}] ${String(Math.round(p * 100)).padStart(3)}%`);
  };
}

async function main(argv) {
  const opts = parseArgs(argv);
  if (!opts.source) fail(`missing -s <source>\n\n${USAGE}`);

  const input = resolvePath(opts.source);
  if (!fs.existsSync(input)) fail(`no such file: ${input}`);

  const pct = opts.timeline == null ? 0 : Number(opts.timeline);
  if (!Number.isFinite(pct) || pct < 0 || pct >= 100) fail('-t must be a percent from 0 up to (not including) 100');

  const targetMB = opts.compress == null ? null : Number(opts.compress);
  if (targetMB != null && !(targetMB > 0)) fail('-c must be a size in MB greater than 0');

  const parsed = path.parse(input);
  let output = opts.output
    ? resolvePath(opts.output)
    : path.join(parsed.dir, `${parsed.name}_${targetMB != null ? `${targetMB}MB` : 'edit'}.mp4`);
  if (!output.toLowerCase().endsWith('.mp4')) output += '.mp4';
  if (output === input) fail('output would overwrite the source; pick a different -o');

  const { duration } = await probe(input);
  const start = (duration * pct) / 100;

  process.on('SIGINT', () => { cancel(); process.stderr.write('\n'); process.exit(130); });

  // With -c, trim and compress in one encode; otherwise a single high-quality trim.
  const res = targetMB != null
    ? await compress({ input, output, targetMB, start, onProgress: progress('Compressing') })
    : await exportEdit({ input, output, start, end: duration, onProgress: progress('Exporting  ') });

  if (process.stderr.isTTY) process.stderr.write('\n');
  console.log(`${res.path} · ${fmtSize(res.size)}`);
}

// Runs the CLI and exits the process when done (also used by the packaged app).
function cli(argv) {
  main(argv).then(
    () => process.exit(0),
    (e) => {
      if (process.stderr.isTTY) process.stderr.write('\n');
      fail(e.message);
    },
  );
}

// True when the arguments ask for the CLI rather than the window.
const isCliArgs = (argv) => argv.some((a) => a in FLAGS || a === '-h' || a === '--help');

module.exports = { cli, isCliArgs };

if (require.main === module) cli(process.argv.slice(2));
