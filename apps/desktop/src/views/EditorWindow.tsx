import { useCallback, useEffect, useState } from "react";
import {
  getPendingShots,
  onShotsUpdated,
  type PendingShots,
} from "../lib/capture";

// The editor window. Phase 4 wires the staging hand-off: a cropped/window PNG
// is stashed Rust-side by `open_editor_with` and this view pulls it on mount
// (and on `editor://shots-updated`, when a re-capture appends to the session),
// mirroring the extension's editor reading chrome.storage pendingShots on load.
//
// The full annotation canvas (rect/arrow/numbered markers/pen/text/mosaic/crop)
// + file-as-issue drawer land in the editor-reuse-upload phase; this view shows
// the staged shots so the capture -> stage -> editor contract is exercised.
export default function EditorWindow() {
  const [pending, setPending] = useState<PendingShots | null>(null);

  const load = useCallback(async () => {
    try {
      setPending(await getPendingShots());
    } catch {
      setPending(null);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    const p = onShotsUpdated(() => void load());
    return () => {
      void p.then((f) => f());
    };
  }, [load]);

  const shots = pending?.attachments ?? [];

  return (
    <div className="editor-stage">
      <div className="editor-toolbar" data-tauri-drag-region>
        <span className="hud-hint">
          {shots.length > 0
            ? `${shots.length} screenshot${shots.length > 1 ? "s" : ""} staged · annotation tools land next`
            : "No staged screenshot."}
        </span>
      </div>
      <div className="editor-shots">
        {shots.map((a) => (
          <figure key={a.id} className="editor-shot">
            <img src={a.dataUrl} alt={a.id} />
          </figure>
        ))}
      </div>
    </div>
  );
}
