import { useEffect, useState } from "react";
import { getHotkey, setCaptureHotkey } from "../lib/api";

// Build a tauri-plugin-global-shortcut accelerator string ("CmdOrCtrl+Shift+2")
// from a keydown event. Returns null until a non-modifier key is pressed.
function accelFromEvent(e: KeyboardEvent): string | null {
  const parts: string[] = [];
  // CommandOrControl maps to ⌘ on macOS, Ctrl elsewhere — the portable token.
  if (e.metaKey || e.ctrlKey) parts.push("CommandOrControl");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  const key = e.key;
  if (["Control", "Meta", "Alt", "Shift"].includes(key)) return null;
  let token = key.length === 1 ? key.toUpperCase() : key;
  if (key === " ") token = "Space";
  parts.push(token);
  return parts.join("+");
}

export default function SettingsView() {
  const [hotkey, setHotkeyState] = useState("");
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    getHotkey()
      .then(setHotkeyState)
      .catch(() => {});
  }, []);

  // While armed, capture the next chord, persist it via setCaptureHotkey, and
  // surface any rejection (Wayland / chord-in-use / invalid).
  useEffect(() => {
    if (!recording) return;
    const onKey = async (e: KeyboardEvent) => {
      e.preventDefault();
      const accel = accelFromEvent(e);
      if (!accel) return; // modifier-only; wait for a real key
      setRecording(false);
      try {
        await setCaptureHotkey(accel);
        setHotkeyState(accel);
        setError("");
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [recording]);

  return (
    <div className="card">
      <h2>Settings</h2>
      <div className="field">
        <label>Global capture hotkey</label>
        <button
          className={`hotkey-pill${recording ? " recording" : ""}`}
          onClick={() => {
            setError("");
            setRecording((r) => !r);
          }}
        >
          {recording ? "Press keys…" : hotkey || "Not set"}
        </button>
        {error && <p className="empty" role="alert">{error}</p>}
      </div>
      <p className="empty">Accounts, capture mode, and AI options land later.</p>
    </div>
  );
}
