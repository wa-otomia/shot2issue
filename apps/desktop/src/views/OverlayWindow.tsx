import { useCallback, useEffect, useRef, useState } from "react";
import {
  cancelCapture,
  confirmRegion,
  getOverlayShot,
  onOverlayRefresh,
  type MonitorShot,
} from "../lib/capture";
import WindowPicker from "./WindowPicker";

type Mode = "region" | "window";
interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

// The capture overlay. On Win/macOS/X11 it renders inside a frameless,
// transparent, always-on-top window positioned exactly over the captured
// monitor; on the Wayland degrade path the same component renders in a normal
// decorated window. Either way it paints the frozen MonitorShot full-bleed and
// the user either rubber-bands a region (default) or Tab-toggles to pick a
// window. Because the overlay is sized 1:1 to the monitor's LOGICAL px, a
// mouse clientX/clientY already equals the crop-rect coords Rust expects.
export default function OverlayWindow() {
  const [shot, setShot] = useState<MonitorShot | null>(null);
  const [mode, setMode] = useState<Mode>("region");
  const [rect, setRect] = useState<Rect | null>(null);
  const drag = useRef<{ x: number; y: number } | null>(null);

  // Tag <html> so overlay.css can paint a transparent page + crosshair cursor
  // without affecting the other windows that share this bundle.
  useEffect(() => {
    document.documentElement.classList.add("overlay-active");
    return () => document.documentElement.classList.remove("overlay-active");
  }, []);

  const load = useCallback(async () => {
    try {
      const s = await getOverlayShot();
      setShot(s);
      setRect(null);
      setMode("region");
    } catch {
      // No shot staged — fall back to a no-op; Esc still closes the window.
    }
  }, []);

  // Initial mount + reuse refresh (the same overlay window is repositioned and
  // re-emitted when a fresh hotkey fires on another monitor).
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    const p = onOverlayRefresh(() => void load());
    return () => {
      void p.then((f) => f());
    };
  }, [load]);

  const toggleMode = useCallback(() => {
    setMode((m) => (m === "region" ? "window" : "region"));
    setRect(null);
  }, []);

  // Keyboard: Esc cancels, Enter confirms a non-trivial region, Tab toggles.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        void cancelCapture();
      } else if (e.key === "Enter" && rect && rect.w > 2 && rect.h > 2) {
        void confirmRegion(rect);
      } else if (e.key === "Tab") {
        e.preventDefault();
        toggleMode();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [rect, toggleMode]);

  // --- region rubber-band ---
  const onMouseDown = (e: React.MouseEvent) => {
    if (mode !== "region") return;
    drag.current = { x: e.clientX, y: e.clientY };
    setRect({ x: e.clientX, y: e.clientY, w: 0, h: 0 });
  };
  const onMouseMove = (e: React.MouseEvent) => {
    if (mode !== "region" || !drag.current) return;
    const s = drag.current;
    setRect({
      x: Math.min(s.x, e.clientX),
      y: Math.min(s.y, e.clientY),
      w: Math.abs(e.clientX - s.x),
      h: Math.abs(e.clientY - s.y),
    });
  };
  const onMouseUp = () => {
    drag.current = null;
  };

  if (!shot) {
    // Nothing to crop (e.g. capture failed); keep a transparent canvas so Esc
    // still closes the window.
    return <div className="overlay-root" onClick={() => void cancelCapture()} />;
  }

  const img = `data:image/png;base64,${shot.pngBase64}`;

  if (mode === "window") {
    return (
      <WindowPicker
        shot={shot}
        imgSrc={img}
        onToggleMode={toggleMode}
        onCancel={() => void cancelCapture()}
      />
    );
  }

  return (
    <div
      className="overlay-root"
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
    >
      <img className="overlay-frame" src={img} draggable={false} alt="" />
      <div className="overlay-dim" />
      {rect && (
        <div
          className="overlay-sel"
          style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}
        >
          <span className="overlay-size">
            {Math.round(rect.w)} × {Math.round(rect.h)}
          </span>
        </div>
      )}
      <div className="overlay-hint">
        Drag to select · Enter to confirm · Tab for window pick · Esc to cancel
      </div>
    </div>
  );
}
