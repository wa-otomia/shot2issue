import { useEffect, useRef, useState } from "react";
import {
  confirmWindow,
  listWindows,
  type MonitorShot,
  type WindowInfo,
} from "../lib/capture";

// Window-pick mode of the capture overlay. Lists top-level windows (bounds in
// virtual-desktop LOGICAL px), highlights the topmost one under the cursor, and
// confirms on click. Rendered by OverlayWindow when the user presses Tab.
//
// Coordinate note: the overlay covers ONE monitor whose top-left is
// (shot.x, shot.y) in the virtual desktop, while window bounds are in that same
// virtual-desktop space. So a window's overlay-local position is
// (w.x - shot.x, w.y - shot.y), and a cursor at clientX/clientY maps to the
// global point (clientX + shot.x, clientY + shot.y) for the hit-test.
export default function WindowPicker({
  shot,
  imgSrc,
  onToggleMode,
  onCancel,
}: {
  shot: MonitorShot;
  imgSrc: string;
  onToggleMode: () => void;
  onCancel: () => void;
}) {
  const [windows, setWindows] = useState<WindowInfo[]>([]);
  const [hovered, setHovered] = useState<WindowInfo | null>(null);
  const hoveredRef = useRef<WindowInfo | null>(null);
  hoveredRef.current = hovered;

  useEffect(() => {
    let alive = true;
    listWindows()
      .then((ws) => {
        if (alive) setWindows(ws);
      })
      .catch(() => {
        /* enumeration failed — region mode still works via Tab */
      });
    return () => {
      alive = false;
    };
  }, []);

  // Esc cancels, Tab returns to region mode, Enter confirms the hovered window.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
      else if (e.key === "Tab") {
        e.preventDefault();
        onToggleMode();
      } else if (e.key === "Enter" && hoveredRef.current) {
        void confirmWindow(hoveredRef.current.id);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel, onToggleMode]);

  const onMouseMove = (e: React.MouseEvent) => {
    const px = e.clientX + shot.x;
    const py = e.clientY + shot.y;
    // The list is z-ordered (topmost first), so the first hit wins.
    const hit =
      windows.find(
        (w) => px >= w.x && px <= w.x + w.width && py >= w.y && py <= w.y + w.height,
      ) ?? null;
    setHovered(hit);
  };

  const onClick = () => {
    if (hovered) void confirmWindow(hovered.id);
  };

  const hi = hovered
    ? {
        left: hovered.x - shot.x,
        top: hovered.y - shot.y,
        width: hovered.width,
        height: hovered.height,
      }
    : null;

  return (
    <div className="overlay-root" onMouseMove={onMouseMove} onClick={onClick}>
      <img className="overlay-frame" src={imgSrc} draggable={false} alt="" />
      <div className="overlay-dim" />
      {hi && (
        <div className="overlay-winhi" style={hi as React.CSSProperties}>
          {hovered && (
            <span className="overlay-winhi-label">
              {hovered.appName ? `${hovered.appName} — ` : ""}
              {hovered.title}
            </span>
          )}
        </div>
      )}
      <div className="overlay-hint">
        Click a window · Enter to confirm · Tab for region · Esc to cancel
      </div>
    </div>
  );
}
