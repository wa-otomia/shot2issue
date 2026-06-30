// The in-app annotate tab. Captured shots now open in a dedicated `editor`
// window (see services/editor_stage.rs), so this sidebar view is an
// informational placeholder until the editor-reuse phase optionally embeds the
// canvas here too.
export default function AnnotateView({ onDone }: { onDone: () => void }) {
  return (
    <div className="card">
      <h2>Annotate</h2>
      <p className="empty">
        Captured screenshots open in their own annotate window. Press the
        capture hotkey or use “Capture now” on the Home tab to start.
      </p>
      <div className="row">
        <button onClick={onDone}>Back</button>
      </div>
    </div>
  );
}
