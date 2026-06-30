import { useEffect, useState } from "react";
import {
  getHotkey,
  onNeedsScreenRecording,
  triggerCapture,
} from "../lib/api";

// The home screen. Capture is Rust-driven: pressing the global hotkey OR the
// "Capture now" button calls `trigger_capture`, which grabs the monitor under
// the cursor and opens the crop overlay (Win/macOS/X11) — or, on native
// Wayland, a normal in-app crop window (the degrade path lives entirely in
// Rust's overlay::present, so the frontend calls the same command either way).
export default function HomeView() {
  const [busy, setBusy] = useState(false);
  const [hotkey, setHotkeyState] = useState("");
  const [needsScreenRec, setNeedsScreenRec] = useState(false);

  useEffect(() => {
    getHotkey()
      .then(setHotkeyState)
      .catch(() => {});
  }, []);

  // macOS: Rust emits this when a capture came back black (Screen Recording
  // denied). Guide the user to grant + restart.
  useEffect(() => {
    const p = onNeedsScreenRecording(() => setNeedsScreenRec(true));
    return () => {
      void p.then((f) => f());
    };
  }, []);

  const captureNow = async () => {
    setBusy(true);
    try {
      await triggerCapture();
    } catch {
      // surfaced in the status bar / a later toast
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <h2>Capture</h2>
      <p className="empty">
        Press <strong>{hotkey || "the global hotkey"}</strong> from anywhere, or
        capture the screen under the cursor now. Drag a region or press Tab to
        pick a window.
      </p>
      <div className="row">
        <button className="primary" disabled={busy} onClick={captureNow}>
          {busy ? "Capturing…" : "Capture now"}
        </button>
      </div>
      {needsScreenRec && (
        <p className="empty" role="alert">
          shot2issue needs Screen Recording permission. Grant it in System
          Settings → Privacy &amp; Security → Screen Recording, then restart the
          app.
        </p>
      )}
    </div>
  );
}
