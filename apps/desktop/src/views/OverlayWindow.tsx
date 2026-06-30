import { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { emit, listen } from "@tauri-apps/api/event";
import { listWindows, type WindowInfo, type CaptureResult } from "../lib/api";

type Mode = "region" | "window";
interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export default function OverlayWindow() {
  const [mode, setMode] = useState<Mode>("region");
  const [frame, setFrame] = useState<string>(""); // data URL of the frozen screen
  const [sel, setSel] = useState<Rect | null>(null);
  const [windows, setWindows] = useState<WindowInfo[]>([]);
  const [hover, setHover] = useState<WindowInfo | null>(null);
  const drag = useRef<{ x: number; y: number } | null>(null);

  // Frameless transparent window -> transparent page bg (curvault pattern).
  // The frozen frame is pushed by Rust via overlay://seed once it opens this
  // window after the hotkey (Phase 4 wires the payload).
  useEffect(() => {
    document.documentElement.style.background = "transparent";
    document.body.style.background = "transparent";
    const un = listen<string>("overlay://seed", (e) => setFrame(e.payload));
    return () => {
      un.then((f) => f());
    };
  }, []);

  useEffect(() => {
    if (mode === "window") listWindows().then(setWindows).catch(() => {});
  }, [mode]);

  const onMouseDown = (e: React.MouseEvent) => {
    if (mode !== "region") return;
    drag.current = { x: e.clientX, y: e.clientY };
    setSel({ x: e.clientX, y: e.clientY, w: 0, h: 0 });
  };
  const onMouseMove = (e: React.MouseEvent) => {
    if (mode === "window") {
      setHover(pickWindow(windows, e.clientX, e.clientY));
      return;
    }
    if (!drag.current) return;
    const { x, y } = drag.current;
    setSel({
      x: Math.min(x, e.clientX),
      y: Math.min(y, e.clientY),
      w: Math.abs(e.clientX - x),
      h: Math.abs(e.clientY - y),
    });
  };
  const onMouseUp = () => {
    drag.current = null;
  };

  // Crop + hand off to the annotate stage (selection-math is finished in
  // Phase 4; this is the confirm chokepoint).
  const confirm = async (result: CaptureResult) => {
    await emit("capture://annotate", result);
    await getCurrentWindow().close();
  };
  void confirm; // wired by the capture-flow subsystem (Phase 4)

  // Esc cancels; Enter / dbl-click confirms (handlers wired in full impl).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") getCurrentWindow().close().catch(() => {});
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div
      className="hud-root"
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
    >
      {frame && <img className="hud-frame" src={frame} alt="" />}
      <div className="hud-scrim" />
      {mode === "region" && sel && (
        <div
          className="hud-selection"
          style={{ left: sel.x, top: sel.y, width: sel.w, height: sel.h }}
        >
          {/* 8 .hud-handle nodes + a .hud-readout pill rendered here in full impl */}
        </div>
      )}
      {mode === "window" && hover && (
        <div
          className="hud-window-hint"
          style={{
            left: hover.x,
            top: hover.y,
            width: hover.width,
            height: hover.height,
          }}
        />
      )}
      <div className="hud-modebar">
        <button
          className={`icon-btn ${mode === "region" ? "active" : ""}`}
          onClick={() => setMode("region")}
          title="Region"
        >
          ⬚
        </button>
        <button
          className={`icon-btn ${mode === "window" ? "active" : ""}`}
          onClick={() => setMode("window")}
          title="Window"
        >
          ▤
        </button>
        <span className="hud-hint">
          Drag to select · Enter to confirm · Esc to cancel
        </span>
      </div>
    </div>
  );
}

function pickWindow(ws: WindowInfo[], x: number, y: number): WindowInfo | null {
  // Topmost window whose bounds contain the cursor (list is z-ordered).
  return (
    ws.find(
      (w) => x >= w.x && y >= w.y && x <= w.x + w.width && y <= w.y + w.height,
    ) ?? null
  );
}
