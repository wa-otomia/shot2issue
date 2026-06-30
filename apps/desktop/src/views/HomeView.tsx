import { useState } from "react";
import { captureScreenUnderCursor } from "../lib/api";
import type { CaptureResult } from "../lib/api";

// Minimal stub for the shell. Phase 4 fleshes out the live capture flow,
// recent-shots strip, and the prominent hotkey hint.
export default function HomeView({
  onCaptureDone,
}: {
  onCaptureDone: (shot: CaptureResult) => void;
}) {
  const [busy, setBusy] = useState(false);

  const captureNow = async () => {
    setBusy(true);
    try {
      const shot = await captureScreenUnderCursor();
      onCaptureDone(shot);
    } catch {
      // surfaced in the status bar / Phase 4 toast
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <h2>Capture</h2>
      <p className="empty">
        Press the global hotkey from anywhere, or capture the screen under the
        cursor now.
      </p>
      <div className="row">
        <button className="primary" disabled={busy} onClick={captureNow}>
          {busy ? "Capturing…" : "Capture now"}
        </button>
      </div>
    </div>
  );
}
