// The home / landing screen. Capture is Rust-driven: the global hotkey OR the
// "Capture now" button calls trigger_capture, which grabs the monitor under the cursor and opens
// the crop overlay (or, on native Wayland, an in-app crop window). A captured + cropped shot
// opens the dedicated `editor` window. This view shows the bound hotkey, a primary capture
// action, and a short how-it-works hint.

import { useEffect, useState } from "react";
import { getHotkey, onNeedsScreenRecording, triggerCapture } from "../lib/api";

export default function HomeView() {
  const [busy, setBusy] = useState(false);
  const [hotkey, setHotkey] = useState("");
  const [needsScreenRec, setNeedsScreenRec] = useState(false);

  useEffect(() => {
    getHotkey().then(setHotkey).catch(() => {});
  }, []);

  // macOS: Rust emits this when a capture came back black (Screen Recording denied).
  useEffect(() => {
    const p = onNeedsScreenRecording(() => setNeedsScreenRec(true));
    return () => {
      void p.then((f) => f());
    };
  }, []);

  const captureNow = async (): Promise<void> => {
    setBusy(true);
    try {
      await triggerCapture();
    } catch {
      /* surfaced in the status bar */
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <h2>Capture</h2>
      <div className="card s2i-home-hero">
        <div className="s2i-home-copy">
          <p>
            Capture the screen under your cursor, annotate it, and file it straight to GitHub,
            GitLab, or YouTrack.
          </p>
          <p className="empty" style={{ textAlign: "left", padding: 0 }}>
            Press <span className="hotkey-pill">{hotkey || "the global hotkey"}</span> from
            anywhere, or use the button below. Drag a region, or press Tab to pick a window.
          </p>
        </div>
        <div className="row">
          <button className="primary" disabled={busy} onClick={() => void captureNow()}>
            {busy ? "Capturing…" : "Capture now"}
          </button>
        </div>
      </div>

      {needsScreenRec && (
        <div className="card">
          <p className="s2i-set-error" role="alert">
            shot2issue needs Screen Recording permission. Grant it in System Settings → Privacy &amp;
            Security → Screen Recording, then restart the app.
          </p>
        </div>
      )}
    </>
  );
}
