import { useEffect, useState } from 'react';
import { fmt, fmtAgo, fmtSize, mediaUrl } from './format.js';

const api = window.api;

function Card({ file, onOpen }) {
  const [info, setInfo] = useState(null);

  useEffect(() => {
    let alive = true;
    api.thumb(file.path).then((r) => alive && setInfo(r)).catch(() => alive && setInfo({}));
    return () => { alive = false; };
  }, [file.path, file.mtime]);

  return (
    <button className="card" onClick={() => onOpen(file.path)} title={file.path}>
      <div className="thumb">
        {info?.thumb && <img src={mediaUrl(info.thumb)} alt="" draggable={false} />}
        {info?.duration > 0 && <span className="badge">{fmt(info.duration).replace(/\.\d$/, '')}</span>}
      </div>
      <span className="card-name">{file.name}</span>
      <span className="card-meta">{fmtAgo(file.mtime)} · {fmtSize(file.size)}</span>
    </button>
  );
}

export default function Gallery({ onOpen }) {
  const [data, setData] = useState(null);

  useEffect(() => {
    const refresh = () => api.listRecent().then(setData).catch(() => setData({ dir: '', files: [] }));
    refresh();
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, []);

  if (!data) return null;
  return (
    <section className="gallery">
      <div className="gallery-head">
        <span className="label">Recent videos</span>
        <span className="muted gallery-dir">{data.dir}</span>
      </div>
      {data.files.length ? (
        <div className="grid">
          {data.files.map((f) => <Card key={f.path} file={f} onOpen={onOpen} />)}
        </div>
      ) : (
        <div className="muted">No videos found in this folder.</div>
      )}
    </section>
  );
}
