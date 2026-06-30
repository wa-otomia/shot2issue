// On-canvas interaction chrome: the dashed selection box + handles around the selected op,
// and the dimmed crop overlay. Lifted from the extension's drawSelectionChrome /
// drawCropOverlay; geometry comes from @shot2issue/core/canvas. Pure drawing onto the passed
// context (sizes stay constant on screen via the scale factor).

import { canvas as eng } from "@shot2issue/core";
import type { Op } from "@shot2issue/core";
import type { Rect } from "./useCropTool";

const ACCENT = "#36c5ff"; // brand cyan (desktop palette), replacing the extension's #1f6feb

/** Dashed bounding box + square handles around the selected op. */
export function drawSelectionChrome(
  ctx: CanvasRenderingContext2D,
  op: Op,
  scale: number,
): void {
  ctx.save();
  ctx.strokeStyle = ACCENT;
  ctx.lineWidth = 1.5 * scale;
  ctx.setLineDash([5 * scale, 4 * scale]);
  if (op.tool === "arrow") {
    ctx.beginPath();
    ctx.moveTo(op.x0 ?? 0, op.y0 ?? 0);
    ctx.lineTo(op.x1 ?? 0, op.y1 ?? 0);
    ctx.stroke();
  } else {
    const b = eng.bboxOf(ctx, op);
    ctx.strokeRect(b.x, b.y, b.w, b.h);
  }
  ctx.setLineDash([]);
  const r = eng.HANDLE * scale * 0.7;
  for (const h of eng.handlesOf(ctx, op)) {
    ctx.fillStyle = "#fff";
    ctx.strokeStyle = ACCENT;
    ctx.lineWidth = 1.5 * scale;
    ctx.beginPath();
    ctx.rect(h.x - r, h.y - r, r * 2, r * 2);
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();
}

/** Darken everything outside the crop rect and draw its frame + handles. */
export function drawCropOverlay(
  ctx: CanvasRenderingContext2D,
  r: Rect,
  canvasW: number,
  canvasH: number,
  scale: number,
): void {
  ctx.save();
  ctx.fillStyle = "rgba(0,0,0,0.5)";
  ctx.fillRect(0, 0, canvasW, r.y);
  ctx.fillRect(0, r.y + r.h, canvasW, canvasH - (r.y + r.h));
  ctx.fillRect(0, r.y, r.x, r.h);
  ctx.fillRect(r.x + r.w, r.y, canvasW - (r.x + r.w), r.h);
  ctx.strokeStyle = "#fff";
  ctx.lineWidth = 1.5 * scale;
  ctx.setLineDash([6 * scale, 4 * scale]);
  ctx.strokeRect(r.x, r.y, r.w, r.h);
  ctx.setLineDash([]);
  const hr = eng.HANDLE * scale * 0.7;
  for (const h of eng.boxHandles(r)) {
    ctx.fillStyle = "#fff";
    ctx.strokeStyle = ACCENT;
    ctx.lineWidth = 1.5 * scale;
    ctx.beginPath();
    ctx.rect(h.x - hr, h.y - hr, hr * 2, hr * 2);
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();
}

/** Resize cursor for a handle name (move for arrow endpoints / body). */
export function cursorForHandle(h: string): string {
  if (h === "p0" || h === "p1") return "move";
  if (h === "nw" || h === "se") return "nwse-resize";
  if (h === "ne" || h === "sw") return "nesw-resize";
  if (h === "n" || h === "s") return "ns-resize";
  return "ew-resize";
}
