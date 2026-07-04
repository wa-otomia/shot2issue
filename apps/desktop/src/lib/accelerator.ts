// Human-readable rendering of a tauri global-shortcut accelerator ("CommandOrControl+Shift+2").
//
// The stored/registered value is a platform-neutral token string the backend understands. Showing
// that raw string in the UI reads as untranslated English ("CommandOrControl+Shift+2") to any user
// — so for DISPLAY only we map it to the platform's conventional keys: macOS uses the modifier
// glyphs joined without separators (⌘⇧2); other platforms keep readable words joined with "+"
// (Ctrl+Shift+2). The raw accelerator is never mutated — recording/registration still uses it.

const isMac = typeof navigator !== "undefined" && navigator.platform.toUpperCase().includes("MAC");

const MAC_SYMBOL: Record<string, string> = {
  commandorcontrol: "⌘",
  command: "⌘",
  cmd: "⌘",
  super: "⌘",
  control: "⌃",
  ctrl: "⌃",
  alt: "⌥",
  option: "⌥",
  shift: "⇧",
};

const WORD: Record<string, string> = {
  commandorcontrol: "Ctrl",
  command: "Cmd",
  cmd: "Cmd",
  super: "Super",
  control: "Ctrl",
  ctrl: "Ctrl",
  alt: "Alt",
  option: "Alt",
  shift: "Shift",
};

/** Format a tauri accelerator for display. Empty/whitespace input returns "" so callers can fall
 *  back to their own "not set" label. */
export function formatAccelerator(accel: string): string {
  const raw = (accel || "").trim();
  if (!raw) return "";
  const parts = raw.split("+").map((p) => p.trim()).filter(Boolean);
  if (isMac) {
    return parts.map((p) => MAC_SYMBOL[p.toLowerCase()] ?? p).join("");
  }
  return parts.map((p) => WORD[p.toLowerCase()] ?? p).join("+");
}
