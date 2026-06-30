import type { CaptureResult } from "../lib/api";

// Minimal stub. Phase 4 mounts the reused canvas editor (rect / arrow /
// numbered markers / pen / text / mosaic / crop) and the file-as-issue drawer.
export default function AnnotateView({
  shot,
  onDone,
}: {
  shot: CaptureResult | null;
  onDone: () => void;
}) {
  if (!shot) {
    return (
      <div className="card">
        <h2>Annotate</h2>
        <p className="empty">No capture yet. Capture a screenshot to start.</p>
        <div className="row">
          <button onClick={onDone}>Back</button>
        </div>
      </div>
    );
  }

  return (
    <div className="annotate-stage">
      <div className="annotate-toolbar">
        <span className="hud-hint">
          {shot.width}×{shot.height} · annotate tools land in Phase 4
        </span>
        <span className="sep" />
        <button onClick={onDone}>Discard</button>
      </div>
      <div className="annotate-canvas-wrap">
        <img src={shot.pngDataUrl} alt="capture" />
      </div>
    </div>
  );
}
