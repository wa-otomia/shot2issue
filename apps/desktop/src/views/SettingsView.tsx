import { useEffect, useState } from "react";
import { getHotkey, setHotkey } from "../lib/api";

// Minimal stub. Phase 4 adds accounts (GitHub/GitLab/YouTrack), capture mode,
// AI title/transcribe settings, and a real hotkey recorder.
export default function SettingsView() {
  const [hotkey, setHotkeyState] = useState("");
  const [recording, setRecording] = useState(false);

  useEffect(() => {
    getHotkey()
      .then(setHotkeyState)
      .catch(() => {});
  }, []);

  // Placeholder recorder: clicking arms it; Phase 4 captures the real chord
  // and persists it via setHotkey.
  const onPill = () => {
    setRecording((r) => !r);
    if (recording) {
      setHotkey(hotkey).catch(() => {});
    }
  };

  return (
    <div className="card">
      <h2>Settings</h2>
      <div className="field">
        <label>Global capture hotkey</label>
        <button
          className={`hotkey-pill${recording ? " recording" : ""}`}
          onClick={onPill}
        >
          {recording ? "Press keys…" : hotkey || "Not set"}
        </button>
      </div>
      <p className="empty">Accounts, capture mode, and AI options land in Phase 4.</p>
    </div>
  );
}
