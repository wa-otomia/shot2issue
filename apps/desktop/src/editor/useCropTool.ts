// Crop-tool geometry + state, split out of useAnnotator to keep each file small.
//
// A crop session holds a pending rectangle (canvas px) that the user drags out, then moves /
// resizes via handles, and finally applies (re-bases the image + offsets the ops) or cancels.
// All geometry is delegated to @shot2issue/core/canvas (boxHandles / clamp / HANDLE) so this
// module owns only the mutable crop rectangle and the apply transform.

import { canvas as eng } from "@shot2issue/core";
import type { Op } from "@shot2issue/core";

export type Rect = { x: number; y: number; w: number; h: number };

/** The mutable crop state shared with the annotator (held in a ref). */
export interface CropState {
  rect: Rect | null; // the pending crop rectangle, or null when not cropping
  orig: Rect | null; // snapshot at drag start (for move/resize)
}

export function newCropState(): CropState {
  return { rect: null, orig: null };
}

/** Handle name under the pointer for the current crop rect (or '' if none). */
export function cropHandleAt(crop: CropState, p: eng.Pt, scale: number): string {
  if (!crop.rect) return "";
  const tol = eng.HANDLE * scale;
  for (const h of eng.boxHandles(crop.rect)) {
    if (Math.abs(p.x - h.x) <= tol && Math.abs(p.y - h.y) <= tol) return h.name;
  }
  return "";
}

/** Resize the crop rect by dragging one handle, clamped to the canvas. */
export function resizeCrop(
  crop: CropState,
  handle: string,
  p: eng.Pt,
  canvasW: number,
  canvasH: number,
): void {
  if (!crop.orig || !crop.rect) return;
  let l = crop.orig.x;
  let t = crop.orig.y;
  let r = crop.orig.x + crop.orig.w;
  let b = crop.orig.y + crop.orig.h;
  if (handle.includes("w")) l = eng.clamp(p.x, 0, r - 10);
  if (handle.includes("e")) r = eng.clamp(p.x, l + 10, canvasW);
  if (handle.includes("n")) t = eng.clamp(p.y, 0, b - 10);
  if (handle.includes("s")) b = eng.clamp(p.y, t + 10, canvasH);
  crop.rect.x = l;
  crop.rect.y = t;
  crop.rect.w = r - l;
  crop.rect.h = b - t;
}

/** Move the crop rect, clamped so it stays inside the canvas. */
export function moveCrop(
  crop: CropState,
  p: eng.Pt,
  dragStart: eng.Pt,
  canvasW: number,
  canvasH: number,
): void {
  if (!crop.orig || !crop.rect) return;
  crop.rect.x = eng.clamp(crop.orig.x + (p.x - dragStart.x), 0, canvasW - crop.rect.w);
  crop.rect.y = eng.clamp(crop.orig.y + (p.y - dragStart.y), 0, canvasH - crop.rect.h);
}

/** Build a preview rect from an in-progress crop-drag op. */
export function cropRectFromDrawing(d: Op): Rect {
  const x = Math.min(d.x0 ?? 0, d.x1 ?? 0);
  const y = Math.min(d.y0 ?? 0, d.y1 ?? 0);
  return { x, y, w: Math.abs((d.x1 ?? 0) - (d.x0 ?? 0)), h: Math.abs((d.y1 ?? 0) - (d.y0 ?? 0)) };
}

/**
 * Apply the crop to a base image + ops: returns the new PNG data URL and the offset/clipped
 * ops. Mirrors the extension's applyCrop (off-screen canvas, ops kept editable).
 */
export function applyCrop(
  base: HTMLImageElement,
  rect: Rect,
  ops: Op[],
  canvasW: number,
  canvasH: number,
  ctx: CanvasRenderingContext2D,
): { dataUrl: string; ops: Op[] } | null {
  const x = eng.clamp(Math.round(rect.x), 0, canvasW - 1);
  const y = eng.clamp(Math.round(rect.y), 0, canvasH - 1);
  const w = eng.clamp(Math.round(rect.w), 1, canvasW - x);
  const h = eng.clamp(Math.round(rect.h), 1, canvasH - y);
  const off = document.createElement("canvas");
  off.width = w;
  off.height = h;
  const c = off.getContext("2d");
  if (!c) return null;
  c.drawImage(base, x, y, w, h, 0, 0, w, h); // base image only; ops are kept editable
  const dataUrl = off.toDataURL("image/png");
  const nextOps = ops
    .map((op) => eng.offsetOp(op, -x, -y))
    .filter((op) => eng.opIntersects(ctx, op, w, h));
  return { dataUrl, ops: nextOps };
}
