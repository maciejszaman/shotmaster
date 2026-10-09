import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Timeline, { HOME_ROW, KeyRow } from './Timeline.jsx';
import Gallery from './Gallery.jsx';
import { fmt, fmtSize, mediaUrl } from './format.js';

const api = window.api;
const PRESETS = [5, 8, 10];

function keepSegments(start, end, cuts) {
  const sorted = [...cuts].sort((a, b) => a.start - b.start);
  const keep = [];
  let pos = start;
  for (const c of sorted) {
    const cs = Math.max(start, c.start), ce = Math.min(end, c.end);
    if (ce <= cs) continue;
    if (cs > pos) keep.push({ start: pos, end: cs });
    pos = Math.max(pos, ce);
  }
  if (end > pos) keep.push({ start: pos, end });
  return keep;
}

const baseName = (p) => p.split(/[\\/]/).pop();

export default function App() {
  const [file, setFile] = useState(null);
  const [start, setStart] = useState(0);
  const [end, setEnd] = useState(0);
  const [cuts, setCuts] = useState([]);
  const [pendingCut, setPendingCut] = useState(null);
  const [zoom, setZoom] = useState({ scale: 1, x: 0.5, y: 0.5 });
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [busy, setBusy] = useState(null);
  const [exported, setExported] = useState(null);
  const [compressed, setCompressed] = useState(null);
  const [targetMB, setTargetMB] = useState('8');
  const [error, setError] = useState('');
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [pressedKey, setPressedKey] = useState(null);

  const videoRef = useRef(null);
  const stageRef = useRef(null);
  const dragRef = useRef(null);
  const pressTimer = useRef(null);
  const exportRef = useRef(null);
  const state = useRef({});
  state.current = { start, end, cuts };

  const duration = file?.duration || 0;
  const outDuration = useMemo(
    () => keepSegments(start, end, cuts).reduce((s, k) => s + k.end - k.start, 0),
    [start, end, cuts],
  );

  useEffect(() => api.onProgress(({ stage, value }) => setBusy({ stage, value })), []);

  const load = useCallback(async (path) => {
    if (!path) return;
    setError('');
    try {
      const info = await api.probe(path);
      setFile({ path, name: baseName(path), url: mediaUrl(path), ...info });
      setStart(0);
      setEnd(info.duration);
      setCuts([]);
      setPendingCut(null);
      setZoom({ scale: 1, x: 0.5, y: 0.5 });
      setExported(null);
      setCompressed(null);
      setTime(0);
    } catch (e) {
      setError(e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
    }
  }, []);

  const open = async () => load(await api.openVideo());

  // Drag & drop a file anywhere in the window.
  useEffect(() => {
    const over = (e) => e.preventDefault();
    const drop = (e) => {
      e.preventDefault();
      const f = e.dataTransfer.files[0];
      if (f) load(api.pathForFile(f));
    };
    window.addEventListener('dragover', over);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragover', over);
      window.removeEventListener('drop', drop);
    };
  }, [load]);

  // Fit the video box into the stage while keeping its aspect ratio.
  const fitBox = useCallback(() => {
    const v = videoRef.current, s = stageRef.current;
    if (!v || !s || !v.videoWidth) return;
    const ar = v.videoWidth / v.videoHeight;
    const sw = s.clientWidth, sh = s.clientHeight;
    setBox(sw / sh > ar ? { w: sh * ar, h: sh } : { w: sw, h: sw / ar });
  }, []);

  useEffect(() => {
    if (!stageRef.current) return;
    const ro = new ResizeObserver(fitBox);
    ro.observe(stageRef.current);
    return () => ro.disconnect();
  }, [file, fitBox]);

  // Preview playback skips cut-out parts and stops at the end point.
  useEffect(() => {
    if (!playing) return;
    let raf;
    const tick = () => {
      const v = videoRef.current;
      if (!v) return;
      const { start, end, cuts } = state.current;
      let t = v.currentTime;
      if (t < start - 0.05) v.currentTime = t = start;
      for (const c of cuts) if (t >= c.start && t < c.end - 0.02) v.currentTime = t = c.end;
      if (t >= end) {
        v.pause();
        v.currentTime = end;
      }
      setTime(v.currentTime);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing]);

  const seek = useCallback((t) => {
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = Math.max(0, Math.min(duration, t));
    setTime(v.currentTime);
  }, [duration]);

  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) {
      if (v.currentTime >= state.current.end - 0.05 || v.currentTime < state.current.start) {
        v.currentTime = state.current.start;
      }
      v.play();
    } else v.pause();
  }, []);

  const markStart = useCallback(() => setStart(Math.min(time, end - 0.1)), [time, end]);
  const markEnd = useCallback(() => setEnd(Math.max(time, start + 0.1)), [time, start]);
  const markCut = useCallback(() => {
    if (pendingCut == null) return setPendingCut(time);
    const a = Math.min(pendingCut, time), b = Math.max(pendingCut, time);
    if (b - a > 0.05) setCuts((c) => [...c, { start: a, end: b }].sort((x, y) => x.start - y.start));
    setPendingCut(null);
  }, [pendingCut, time]);

  const jumpTo = useCallback((i) => {
    seek((duration * i) / (HOME_ROW.length - 1));
    setPressedKey(i);
    clearTimeout(pressTimer.current);
    pressTimer.current = setTimeout(() => setPressedKey(null), 180);
  }, [duration, seek]);

  useEffect(() => {
    const onKey = (e) => {
      if (!file || busy) return;
      if ((e.ctrlKey || e.metaKey) && e.code === 'KeyS') {
        e.preventDefault();
        if (outDuration > 0) exportRef.current();
        return;
      }
      if (e.target.tagName === 'INPUT' || e.ctrlKey || e.metaKey || e.altKey) return;
      const row = HOME_ROW.findIndex((k) => k.code === e.code);
      if (row >= 0) { e.preventDefault(); jumpTo(row); }
      else if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
      else if (e.code === 'KeyZ') markStart();
      else if (e.code === 'KeyX') markEnd();
      else if (e.code === 'KeyC') markCut();
      else if (e.code === 'Escape') setPendingCut(null);
      else if (e.code === 'ArrowLeft') seek(time - (e.shiftKey ? 1 / 30 : 1));
      else if (e.code === 'ArrowRight') seek(time + (e.shiftKey ? 1 / 30 : 1));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [file, busy, outDuration, togglePlay, markStart, markEnd, markCut, seek, jumpTo, time]);

  // Drag on the video to pan while zoomed; a click without movement toggles play.
  const onStageDown = (e) => {
    dragRef.current = { x: e.clientX, y: e.clientY, zx: zoom.x, zy: zoom.y, moved: false };
    const move = (ev) => {
      const d = dragRef.current;
      const dx = ev.clientX - d.x, dy = ev.clientY - d.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true;
      if (!d.moved || zoom.scale <= 1) return;
      const clamp = (n) => Math.max(0, Math.min(1, n));
      setZoom((z) => ({
        ...z,
        x: clamp(d.zx - dx / (box.w * (z.scale - 1))),
        y: clamp(d.zy - dy / (box.h * (z.scale - 1))),
      }));
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      if (!dragRef.current.moved) togglePlay();
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  const errMsg = (e) => e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

  const doExport = async () => {
    videoRef.current?.pause();
    setError('');
    try {
      const res = await api.exportVideo({ input: file.path, start, end, cuts, zoom });
      if (res) {
        setExported(res);
        setCompressed(null);
      }
    } catch (e) {
      if (errMsg(e) !== 'Cancelled') setError(errMsg(e));
    }
    setBusy(null);
  };
  exportRef.current = doExport;

  const doCompress = async () => {
    const mb = parseFloat(targetMB);
    if (!(mb > 0)) return setError('Enter a valid size in MB');
    setError('');
    try {
      setCompressed(await api.compress({ input: exported.path, targetMB: mb }));
    } catch (e) {
      if (errMsg(e) !== 'Cancelled') setError(errMsg(e));
    }
    setBusy(null);
  };

  if (!file) {
    return (
      <div className="empty">
        <button className="drop" onClick={open}>
          <span className="drop-title">Open a video</span>
          <span className="muted">or drop a file anywhere</span>
        </button>
        {error && <div className="error">{error}</div>}
        <Gallery onOpen={load} />
      </div>
    );
  }

  return (
    <div className="app">
      <header>
        <button className="ghost" onClick={() => setFile(null)} disabled={!!busy}>← Videos</button>
        <span className="name" title={file.path}>{file.name}</span>
        <span className="spacer" />
        <button className="ghost" onClick={open} disabled={!!busy}>Open another</button>
      </header>

      <div className="stage" ref={stageRef}>
        <div
          className={`frame ${zoom.scale > 1 ? 'pannable' : ''}`}
          style={{ width: box.w, height: box.h }}
          onMouseDown={onStageDown}
        >
          <video
            ref={videoRef}
            src={file.url}
            onLoadedMetadata={fitBox}
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onSeeked={(e) => setTime(e.target.currentTime)}
            onError={() => setError('Preview not supported for this codec (export still works).')}
            style={{
              transform: `scale(${zoom.scale})`,
              transformOrigin: `${zoom.x * 100}% ${zoom.y * 100}%`,
            }}
          />
        </div>
      </div>

      <div className="controls">
        <div className="timeline-panel">
          <Timeline
            duration={duration}
            time={time}
            start={start}
            end={end}
            cuts={cuts}
            pendingCut={pendingCut}
            onSeek={seek}
            onStart={setStart}
            onEnd={setEnd}
          />
          <KeyRow pressed={pressedKey} onJump={jumpTo} />
          <div className="row transport">
            <button className="play" onClick={togglePlay} title={playing ? 'Pause' : 'Play'}>
              <svg viewBox="0 0 12 12">
                {playing
                  ? <path d="M2 1h3v10H2zM7 1h3v10H7z" />
                  : <path d="M2.5 1v10l9-5z" />}
              </svg>
            </button>
            <span className="time">{fmt(time)} / {fmt(duration)}</span>
            <span className="spacer" />
            <span className="muted">Output: {fmt(outDuration)}</span>
          </div>
        </div>

        <div className="row tools">
          <div className="group">
            <span className="label">Trim</span>
            <button onClick={markStart} title="Shortcut: Z">Set start <kbd>Z</kbd></button>
            <button onClick={markEnd} title="Shortcut: X">Set end <kbd>X</kbd></button>
          </div>
          <div className="group">
            <span className="label">Cut out</span>
            <button className={pendingCut != null ? 'active' : ''} onClick={markCut} title="Shortcut: C">
              {pendingCut != null ? `End cut (from ${fmt(pendingCut)})` : 'Start cut'} <kbd>C</kbd>
            </button>
          </div>
          <div className="group zoom">
            <span className="label">Zoom</span>
            <input
              type="range" min="1" max="4" step="0.05" value={zoom.scale}
              onChange={(e) => setZoom((z) => ({ ...z, scale: parseFloat(e.target.value) }))}
            />
            <span className="zoom-val">{zoom.scale.toFixed(2)}×</span>
            {zoom.scale > 1 && (
              <button className="ghost" onClick={() => setZoom({ scale: 1, x: 0.5, y: 0.5 })}>Reset</button>
            )}
          </div>
        </div>
        {zoom.scale > 1 && <div className="hint">Drag the video to choose the zoomed area.</div>}

        {cuts.length > 0 && (
          <div className="cuts">
            {cuts.map((c, i) => (
              <span key={i} className="chip">
                <button className="chip-seek" onClick={() => seek(c.start)}>{fmt(c.start)} – {fmt(c.end)}</button>
                <button className="chip-x" onClick={() => setCuts(cuts.filter((_, j) => j !== i))}>×</button>
              </span>
            ))}
          </div>
        )}

        <div className="row actions">
          <button className="primary" onClick={doExport} disabled={!!busy || outDuration <= 0} title="Shortcut: Ctrl+S">
            Export <kbd className="on-primary">Ctrl</kbd><kbd className="on-primary">S</kbd>
          </button>
          {exported && (
            <span className="result">
              {baseName(exported.path)} · {fmtSize(exported.size)}
              <button className="link" onClick={() => api.showInFolder(exported.path)}>Show</button>
            </span>
          )}
        </div>

        {exported && (
          <div className="row compress">
            <span className="label">Compress to</span>
            {PRESETS.map((mb) => (
              <button
                key={mb}
                className={parseFloat(targetMB) === mb ? 'active' : ''}
                onClick={() => setTargetMB(String(mb))}
              >
                {mb} MB
              </button>
            ))}
            <span className="custom">
              <input
                type="number" min="0.5" step="0.5" value={targetMB}
                onChange={(e) => setTargetMB(e.target.value)}
              />
              MB
            </span>
            <button className="primary" onClick={doCompress} disabled={!!busy}>Compress</button>
            {compressed && (
              <span className="result">
                {baseName(compressed.path)} · {fmtSize(compressed.size)}
                <button className="link" onClick={() => api.showInFolder(compressed.path)}>Show</button>
              </span>
            )}
          </div>
        )}

        {error && <div className="error">{error}</div>}
      </div>

      {busy && (
        <div className="busy">
          <span>{busy.stage === 'export' ? 'Exporting' : 'Compressing'} {Math.round(busy.value * 100)}%</span>
          <div className="bar"><div style={{ width: `${busy.value * 100}%` }} /></div>
          <button className="ghost" onClick={() => api.cancel()}>Cancel</button>
        </div>
      )}
    </div>
  );
}
