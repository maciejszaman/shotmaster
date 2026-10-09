import { useRef } from "react";

// Home row of the keyboard: A = 0% … ' = 100% of the clip, in 10% steps.
export const HOME_ROW = [
  ["A", "KeyA"],
  ["S", "KeyS"],
  ["D", "KeyD"],
  ["F", "KeyF"],
  ["G", "KeyG"],
  ["H", "KeyH"],
  ["J", "KeyJ"],
  ["K", "KeyK"],
  ["L", "KeyL"],
  [";", "Semicolon"],
  ["'", "Quote"],
].map(([label, code]) => ({ label, code }));

export function KeyRow({ pressed, onJump }) {
  return (
    <div className="keyrow">
      {HOME_ROW.map((k, i) => {
        // Exact position for the tick; the cap slides inward so the end keys
        // stay inside the timeline frame (left-aligned at 0%, right at 100%).
        const p = i / (HOME_ROW.length - 1);
        return (
          <div
            key={k.code}
            className="key-slot"
            style={{ left: `${p * 100}%` }}
          >
            <span className="tick" />
            <kbd
              className={`key ${pressed === i ? "pressed" : ""}`}
              style={{ "--shift": `${-p * 100}%` }}
              title={`Jump to ${i * 10}%`}
              onMouseDown={(e) => {
                e.preventDefault();
                onJump(i);
              }}
            >
              {k.label}
            </kbd>
          </div>
        );
      })}
    </div>
  );
}

export default function Timeline({
  duration,
  time,
  start,
  end,
  cuts,
  pendingCut,
  onSeek,
  onStart,
  onEnd,
}) {
  const ref = useRef(null);
  const pct = (t) => `${(duration ? t / duration : 0) * 100}%`;

  const timeAt = (clientX) => {
    const r = ref.current.getBoundingClientRect();
    return Math.max(0, Math.min(1, (clientX - r.left) / r.width)) * duration;
  };

  // Drag helper: calls fn with the time under the cursor until mouseup.
  const drag = (fn) => (e) => {
    e.preventDefault();
    e.stopPropagation();
    fn(timeAt(e.clientX));
    const move = (ev) => fn(timeAt(ev.clientX));
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  return (
    <div className="timeline" ref={ref} onMouseDown={drag(onSeek)}>
      <div className="track" />
      <div
        className="kept"
        style={{ left: pct(start), width: pct(end - start) }}
      />
      {cuts.map((c, i) => (
        <div
          key={i}
          className="cut"
          style={{ left: pct(c.start), width: pct(c.end - c.start) }}
        />
      ))}
      {pendingCut != null && (
        <div
          className="cut pending"
          style={{
            left: pct(Math.min(pendingCut, time)),
            width: pct(Math.abs(time - pendingCut)),
          }}
        />
      )}
      <div
        className="handle start"
        style={{ left: pct(start) }}
        onMouseDown={drag((t) => onStart(Math.min(t, end - 0.1)))}
        title="Drag to set start"
      />
      <div
        className="handle end"
        style={{ left: pct(end) }}
        onMouseDown={drag((t) => onEnd(Math.max(t, start + 0.1)))}
        title="Drag to set end"
      />
      <div className="playhead" style={{ left: pct(time) }} />
    </div>
  );
}
