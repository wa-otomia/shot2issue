import { useCallback, useEffect, useRef, useState } from "react";
import {
  cancelCapture,
  confirmRegion,
  confirmWindowPick,
  getOverlayShot,
  listWindows,
  onOverlayRefresh,
  type MonitorShot,
  type WindowInfo,
} from "../lib/capture";
import WindowPicker from "./WindowPicker";

type Mode = "region" | "window";
interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

// A press that moves less than this is a CLICK (grab the window under it); more
// is a region DRAG. Keeps single-click window-pick and rubber-band select from
// fighting each other.
const DRAG_THRESHOLD = 4;

// The capture overlay. On Win/macOS/X11 it renders inside a frameless,
// transparent, always-on-top window positioned exactly over the captured
// monitor; on the Wayland degrade path the same component renders in a normal
// decorated window. It paints the frozen MonitorShot full-bleed, then offers a
// UNIFIED interaction (macOS-screenshot / Snipaste style): move the mouse to
// highlight the window underneath, CLICK to grab that whole window, or DRAG to
// rubber-band a custom region. Tab still toggles a dedicated window-list picker.
// Because the overlay is sized 1:1 to the monitor's LOGICAL px, a mouse
// clientX/clientY already equals the crop-rect coords Rust expects; window
// bounds are in virtual-desktop space, so we offset by (shot.x, shot.y).
export default function OverlayWindow() {
  const [shot, setShot] = useState<MonitorShot | null>(null);
  const [mode, setMode] = useState<Mode>("region");
  const [rect, setRect] = useState<Rect | null>(null);
  const [windows, setWindows] = useState<WindowInfo[]>([]);
  const [hoveredWin, setHoveredWin] = useState<WindowInfo | null>(null);
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  // Refs so the hit-test reads fresh shot/windows without re-subscribing handlers.
  const shotRef = useRef<MonitorShot | null>(null);
  shotRef.current = shot;
  const winsRef = useRef<WindowInfo[]>([]);
  winsRef.current = windows;

  // Tag <html> so overlay.css paints a transparent page + crosshair cursor
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
      setHoveredWin(null);
      setMode("region");
    } catch {
      // No shot staged — fall back to a no-op; Esc still closes the window.
    }
    // Window metadata drives the hover-to-pick assistance in the default mode.
    // Best-effort: if enumeration fails, region drag still works.
    listWindows()
      .then(setWindows)
      .catch(() => setWindows([]));
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
    setHoveredWin(null);
  }, []);

  // Topmost non-minimized window under an overlay-local point (list is z-ordered,
  // topmost first, so the first hit wins).
  const windowAt = useCallback((clientX: number, clientY: number): WindowInfo | null => {
    const s = shotRef.current;
    if (!s) return null;
    const px = clientX + s.x;
    const py = clientY + s.y;
    return (
      winsRef.current.find(
        (w) => !w.isMinimized && px >= w.x && px <= w.x + w.width && py >= w.y && py <= w.y + w.height,
      ) ?? null
    );
  }, []);

  // Keyboard: Esc cancels, Enter confirms a non-trivial region, Tab toggles.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        void cancelCapture();
      } else if (e.key === "Enter" && rect && rect.w > 2 && rect.h > 2) {
        void confirmRegion(rect, shotRef.current?.token ?? 0);
      } else if (e.key === "Tab") {
        e.preventDefault();
        toggleMode();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [rect, toggleMode]);

  // --- unified press: click = window, drag = region ---
  const onMouseDown = (e: React.MouseEvent) => {
    if (mode !== "region") return;
    drag.current = { x: e.clientX, y: e.clientY, moved: false };
    setHoveredWin(null);
    setRect(null);
  };
  const onMouseMove = (e: React.MouseEvent) => {
    if (mode !== "region") return;
    const d = drag.current;
    if (d) {
      if (!d.moved && Math.abs(e.clientX - d.x) < DRAG_THRESHOLD && Math.abs(e.clientY - d.y) < DRAG_THRESHOLD) {
        return; // still within click slop — not a region yet
      }
      d.moved = true;
      setRect({
        x: Math.min(d.x, e.clientX),
        y: Math.min(d.y, e.clientY),
        w: Math.abs(e.clientX - d.x),
        h: Math.abs(e.clientY - d.y),
      });
    } else {
      // Not pressing: highlight the window under the cursor (hover-to-pick).
      setHoveredWin(windowAt(e.clientX, e.clientY));
    }
  };
  const onMouseUp = (e: React.MouseEvent) => {
    if (mode !== "region") return;
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    // Recompute from the down/up points so we don't race the rect state.
    const r = {
      x: Math.min(d.x, e.clientX),
      y: Math.min(d.y, e.clientY),
      w: Math.abs(e.clientX - d.x),
      h: Math.abs(e.clientY - d.y),
    };
    if (d.moved && r.w > 2 && r.h > 2) {
      void confirmRegion(r, shotRef.current?.token ?? 0);
    } else {
      // A click, OR a shaky drag too small to crop (d.moved flips at 4px but a
      // crop needs w>2 && h>2, so e.g. dx=6,dy=1 leaves no usable region): treat
      // it as a window pick so the gesture isn't dead.
      const win = windowAt(e.clientX, e.clientY);
      if (win) void confirmWindowPick(win, shotRef.current);
    }
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

  // Highlight the hovered window only while not dragging a region.
  const winHi =
    hoveredWin && !drag.current
      ? {
          left: hoveredWin.x - shot.x,
          top: hoveredWin.y - shot.y,
          width: hoveredWin.width,
          height: hoveredWin.height,
        }
      : null;

  return (
    <div
      className="overlay-root"
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
    >
      <img className="overlay-frame" src={img} draggable={false} alt="" />
      <div className="overlay-dim" />
      {winHi && (
        <div className="overlay-winhi" style={winHi as React.CSSProperties}>
          <span className="overlay-winhi-label">
            {hoveredWin && hoveredWin.appName ? `${hoveredWin.appName} — ` : ""}
            {hoveredWin?.title}
          </span>
        </div>
      )}
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
        Click a window · drag to select a region · Tab for the window list · Esc to cancel
      </div>
    </div>
  );
}
