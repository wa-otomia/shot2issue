// Pure canvas annotation engine. Lifted verbatim from the extension's editor.ts (the
// drawing + geometry + crop functions). No DOM-id, event, storage, or chrome coupling —
// callers pass the rendering context, the base image, and the ops.
//
// Function bodies are unchanged from editor.ts. The only structural change: functions that
// read editor.ts's module-global `ctx` now take an explicit CanvasRenderingContext2D, and
// those that read `scaleFactor()` take an explicit `scale` argument (canvas px per screen px).

import type { Op } from '../types.js';

export type Img = HTMLImageElement | HTMLCanvasElement;
export type Pt = { x: number; y: number };
export type Rect = { x: number; y: number; w: number; h: number };

/** Resize-handle hit/half-size, in screen px. */
export const HANDLE = 9;
export const clamp = (v: number, a: number, b: number): number => Math.max(a, Math.min(v, b));

// ---- Selection / manipulation -----------------------------------------------
export function cloneOp(op: Op): Op {
  return JSON.parse(JSON.stringify(op)) as Op;
}

/** Which ops can be selected and manipulated after drawing (pen commits immediately). */
export function isSelectable(tool: string): boolean {
  return tool === 'rect' || tool === 'numrect' || tool === 'arrow' || tool === 'mosaic' || tool === 'text';
}

/** Measured bounding box (canvas px) of any selectable op. */
export function bboxOf(ctx: CanvasRenderingContext2D, op: Op): Rect {
  if (op.tool === 'text') {
    const size = op.size || 20;
    ctx.save();
    ctx.font = `bold ${size}px system-ui, sans-serif`;
    const lines = wrapText(ctx, op.text || '', op.w);
    let maxw = 10;
    for (const l of lines) maxw = Math.max(maxw, ctx.measureText(l).width);
    ctx.restore();
    return { x: op.x ?? 0, y: op.y ?? 0, w: op.w || maxw, h: Math.max(size * 1.2, lines.length * size * 1.2) };
  }
  const x = Math.min(op.x0 ?? 0, op.x1 ?? 0);
  const y = Math.min(op.y0 ?? 0, op.y1 ?? 0);
  return { x, y, w: Math.abs((op.x1 ?? 0) - (op.x0 ?? 0)), h: Math.abs((op.y1 ?? 0) - (op.y0 ?? 0)) };
}

export function boxHandles(b: Rect): Array<{ name: string; x: number; y: number }> {
  const { x, y, w, h } = b;
  return [
    { name: 'nw', x, y }, { name: 'n', x: x + w / 2, y }, { name: 'ne', x: x + w, y },
    { name: 'e', x: x + w, y: y + h / 2 }, { name: 'se', x: x + w, y: y + h }, { name: 's', x: x + w / 2, y: y + h },
    { name: 'sw', x, y: y + h }, { name: 'w', x, y: y + h / 2 },
  ];
}

export function handlesOf(ctx: CanvasRenderingContext2D, op: Op): Array<{ name: string; x: number; y: number }> {
  if (op.tool === 'arrow') return [{ name: 'p0', x: op.x0 ?? 0, y: op.y0 ?? 0 }, { name: 'p1', x: op.x1 ?? 0, y: op.y1 ?? 0 }];
  const b = bboxOf(ctx, op);
  if (op.tool === 'text') return [{ name: 'w', x: b.x, y: b.y + b.h / 2 }, { name: 'e', x: b.x + b.w, y: b.y + b.h / 2 }];
  return boxHandles(b);
}

export function handleAt(ctx: CanvasRenderingContext2D, op: Op, p: Pt, scale: number): string {
  const tol = HANDLE * scale;
  for (const h of handlesOf(ctx, op)) if (Math.abs(p.x - h.x) <= tol && Math.abs(p.y - h.y) <= tol) return h.name;
  return '';
}

export function distToSeg(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x, dy = b.y - a.y, len2 = dx * dx + dy * dy;
  if (!len2) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / len2, 0, 1);
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

export function pointInOp(ctx: CanvasRenderingContext2D, op: Op, p: Pt, scale: number): boolean {
  if (op.tool === 'arrow') return distToSeg(p, { x: op.x0 ?? 0, y: op.y0 ?? 0 }, { x: op.x1 ?? 0, y: op.y1 ?? 0 }) <= 8 * scale;
  const b = bboxOf(ctx, op), m = 3;
  return p.x >= b.x - m && p.x <= b.x + b.w + m && p.y >= b.y - m && p.y <= b.y + b.h + m;
}

export function pointInRect(p: Pt, r: Rect): boolean {
  return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
}

export function moveOpBy(op: Op, orig: Op, dx: number, dy: number): void {
  if (op.tool === 'text') {
    op.x = (orig.x ?? 0) + dx;
    op.y = (orig.y ?? 0) + dy;
    return;
  }
  op.x0 = (orig.x0 ?? 0) + dx;
  op.y0 = (orig.y0 ?? 0) + dy;
  op.x1 = (orig.x1 ?? 0) + dx;
  op.y1 = (orig.y1 ?? 0) + dy;
}

export function resizeOp(op: Op, orig: Op, handle: string, p: Pt): void {
  if (op.tool === 'arrow') {
    if (handle === 'p0') { op.x0 = p.x; op.y0 = p.y; } else { op.x1 = p.x; op.y1 = p.y; }
    return;
  }
  if (op.tool === 'text') {
    const right = (orig.x ?? 0) + (orig.w ?? 0);
    if (handle === 'e') op.w = Math.max(24, p.x - (op.x ?? 0));
    else if (handle === 'w') { const nx = Math.min(p.x, right - 24); op.x = nx; op.w = right - nx; }
    return;
  }
  let l = Math.min(orig.x0 ?? 0, orig.x1 ?? 0), t = Math.min(orig.y0 ?? 0, orig.y1 ?? 0);
  let r = Math.max(orig.x0 ?? 0, orig.x1 ?? 0), b = Math.max(orig.y0 ?? 0, orig.y1 ?? 0);
  if (handle.includes('w')) l = p.x;
  if (handle.includes('e')) r = p.x;
  if (handle.includes('n')) t = p.y;
  if (handle.includes('s')) b = p.y;
  op.x0 = l; op.y0 = t; op.x1 = r; op.y1 = b;
}

// ---- Crop -------------------------------------------------------------------
export function offsetOp(op: Op, dx: number, dy: number): Op {
  const o = cloneOp(op);
  if (o.x0 != null) o.x0 += dx;
  if (o.x1 != null) o.x1 += dx;
  if (o.y0 != null) o.y0 += dy;
  if (o.y1 != null) o.y1 += dy;
  if (o.x != null) o.x += dx;
  if (o.y != null) o.y += dy;
  if (o.points) o.points = o.points.map((pt) => ({ x: pt.x + dx, y: pt.y + dy }));
  return o;
}

export function opIntersects(ctx: CanvasRenderingContext2D, op: Op, w: number, h: number): boolean {
  const b = bboxOf(ctx, op);
  return b.x < w && b.y < h && b.x + b.w > 0 && b.y + b.h > 0;
}

// ---- Rendering --------------------------------------------------------------
/** Render a base image plus a list of ops onto an arbitrary context (used for export). */
export function renderOps(c: CanvasRenderingContext2D, base: Img, w: number, h: number, opsList: Op[]): void {
  c.clearRect(0, 0, w, h);
  c.drawImage(base, 0, 0, w, h);
  for (const op of opsList) drawOne(c, base, op);
}

/** Halo line width: the colored line width plus the outline thickness on each side. */
export function haloWidth(width: number, sw: number): number {
  return width + 2 * sw;
}

/** Stroke a rectangle with a contrasting outline (halo) under the main color; sw=0 → no outline. */
export function strokeRectHalo(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, color: string, stroke: string, width: number, sw: number): void {
  c.lineJoin = 'round';
  if (sw > 0) {
    c.strokeStyle = stroke;
    c.lineWidth = haloWidth(width, sw);
    c.strokeRect(x, y, w, h);
  }
  c.strokeStyle = color;
  c.lineWidth = width;
  c.strokeRect(x, y, w, h);
}

/** Outline thickness for an op (older ops without the field default to 3; 0 = no outline). */
export function outlineWidth(op: Op): number {
  return op.strokeWidth ?? 3;
}

export function drawOne(c: CanvasRenderingContext2D, base: Img, op: Op): void {
  c.save();
  c.lineJoin = 'round';
  c.lineCap = 'round';
  const stroke = op.strokeColor || '#ffffff'; // contrasting halo color
  const sw = outlineWidth(op);
  const width = op.width || 4;

  if (op.tool === 'rect') {
    const x = Math.min(op.x0 ?? 0, op.x1 ?? 0);
    const y = Math.min(op.y0 ?? 0, op.y1 ?? 0);
    strokeRectHalo(c, x, y, Math.abs((op.x1 ?? 0) - (op.x0 ?? 0)), Math.abs((op.y1 ?? 0) - (op.y0 ?? 0)), op.color, stroke, width, sw);
  } else if (op.tool === 'numrect') {
    drawNumRect(c, op, stroke, sw);
  } else if (op.tool === 'arrow') {
    drawArrow(c, op, stroke, sw);
  } else if (op.tool === 'pen') {
    drawPen(c, op, stroke, sw);
  } else if (op.tool === 'mosaic') {
    drawMosaic(c, base, op);
  } else if (op.tool === 'textbox' || op.tool === 'crop') {
    // In-progress region preview (never committed).
    const x = Math.min(op.x0 ?? 0, op.x1 ?? 0);
    const y = Math.min(op.y0 ?? 0, op.y1 ?? 0);
    c.strokeStyle = op.color || '#1f6feb';
    c.setLineDash([6, 4]);
    c.lineWidth = 1.5;
    c.strokeRect(x, y, Math.abs((op.x1 ?? 0) - (op.x0 ?? 0)), Math.abs((op.y1 ?? 0) - (op.y0 ?? 0)));
  } else if (op.tool === 'text') {
    const size = op.size || 20;
    c.font = `bold ${size}px system-ui, sans-serif`;
    c.textBaseline = 'top';
    c.lineJoin = 'round';
    const lineHeight = size * 1.2;
    wrapText(c, op.text || '', op.w).forEach((line, i) => {
      const ly = (op.y ?? 0) + i * lineHeight;
      if (sw > 0) {
        c.lineWidth = Math.max(1, sw * 2);
        c.strokeStyle = stroke;
        c.strokeText(line, op.x ?? 0, ly);
      }
      c.fillStyle = op.color;
      c.fillText(line, op.x ?? 0, ly);
    });
  }
  c.restore();
}

/**
 * Wrap text to a maximum width (canvas pixels), honoring explicit newlines. Long single
 * tokens (e.g. CJK runs) are broken per character. Assumes c.font is already set.
 */
export function wrapText(c: CanvasRenderingContext2D, text: string, maxW?: number): string[] {
  const paragraphs = text.split('\n');
  if (!maxW || maxW <= 0) return paragraphs;
  const out: string[] = [];
  for (const para of paragraphs) {
    if (para === '') {
      out.push('');
      continue;
    }
    let line = '';
    for (const token of para.split(/(\s+)/)) {
      if (line === '') line = token;
      else if (c.measureText(line + token).width <= maxW) line += token;
      else {
        out.push(line.replace(/\s+$/, ''));
        line = token.replace(/^\s+/, '');
      }
      while (c.measureText(line).width > maxW && line.length > 1) {
        let i = line.length;
        while (i > 1 && c.measureText(line.slice(0, i)).width > maxW) i--;
        out.push(line.slice(0, i));
        line = line.slice(i);
      }
    }
    out.push(line);
  }
  return out;
}

/** Stroke a freehand pen path with a contrasting halo under the main color (sw=0 → no halo). */
function drawPen(c: CanvasRenderingContext2D, op: Op, stroke: string, sw: number): void {
  const pts = op.points || [];
  if (pts.length < 2) return;
  const width = op.width || 4;
  const trace = (): void => {
    c.beginPath();
    c.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) c.lineTo(pts[i].x, pts[i].y);
  };
  if (sw > 0) {
    c.strokeStyle = stroke;
    c.lineWidth = haloWidth(width, sw);
    trace();
    c.stroke();
  }
  c.strokeStyle = op.color;
  c.lineWidth = width;
  trace();
  c.stroke();
}

/** Draw a rectangle with a numbered circular badge (outlined in the contrasting color). */
function drawNumRect(c: CanvasRenderingContext2D, op: Op, stroke: string, sw: number): void {
  const x = Math.min(op.x0 ?? 0, op.x1 ?? 0);
  const y = Math.min(op.y0 ?? 0, op.y1 ?? 0);
  const width = op.width || 4;
  strokeRectHalo(c, x, y, Math.abs((op.x1 ?? 0) - (op.x0 ?? 0)), Math.abs((op.y1 ?? 0) - (op.y0 ?? 0)), op.color, stroke, width, sw);

  const r = Math.max(11, width * 2.4);
  c.beginPath();
  c.arc(x, y, r, 0, Math.PI * 2);
  c.fillStyle = op.color;
  c.fill();
  c.lineWidth = Math.max(2, r / 6);
  c.strokeStyle = stroke;
  c.stroke();

  c.fillStyle = stroke;
  c.font = `bold ${Math.round(r * 1.2)}px system-ui, sans-serif`;
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  c.fillText(String(op.num ?? '?'), x, y + r * 0.04);
  c.textAlign = 'start'; // reset for subsequent text ops
}

function drawArrow(c: CanvasRenderingContext2D, op: Op, stroke: string, sw: number): void {
  const x0 = op.x0 ?? 0;
  const y0 = op.y0 ?? 0;
  const x1 = op.x1 ?? 0;
  const y1 = op.y1 ?? 0;
  const width = op.width || 4;
  const head = Math.max(10, width * 3);
  const angle = Math.atan2(y1 - y0, x1 - x0);
  const shaft = (): void => {
    c.beginPath();
    c.moveTo(x0, y0);
    c.lineTo(x1, y1);
  };
  const headPath = (): void => {
    c.beginPath();
    c.moveTo(x1, y1);
    c.lineTo(x1 - head * Math.cos(angle - Math.PI / 6), y1 - head * Math.sin(angle - Math.PI / 6));
    c.lineTo(x1 - head * Math.cos(angle + Math.PI / 6), y1 - head * Math.sin(angle + Math.PI / 6));
    c.closePath();
  };
  // Halo first (shaft + head outline), then the colored arrow on top (sw=0 → no halo).
  if (sw > 0) {
    c.strokeStyle = stroke;
    c.lineWidth = haloWidth(width, sw);
    shaft();
    c.stroke();
    headPath();
    c.lineJoin = 'round';
    c.lineWidth = Math.max(2, sw * 2);
    c.stroke();
    c.fillStyle = stroke;
    c.fill();
  }
  c.strokeStyle = op.color;
  c.lineWidth = width;
  shaft();
  c.stroke();
  c.fillStyle = op.color;
  headPath();
  c.fill();
}

/**
 * Mosaic / redaction: sample the region from the base image, downscale it, then draw it
 * back enlarged with smoothing off to produce hard pixel blocks. Sampling the base image
 * (not the current canvas) keeps redaction of the original content stable.
 */
function drawMosaic(c: CanvasRenderingContext2D, base: Img, op: Op): void {
  const x = Math.round(Math.min(op.x0 ?? 0, op.x1 ?? 0));
  const y = Math.round(Math.min(op.y0 ?? 0, op.y1 ?? 0));
  const w = Math.round(Math.abs((op.x1 ?? 0) - (op.x0 ?? 0)));
  const h = Math.round(Math.abs((op.y1 ?? 0) - (op.y0 ?? 0)));
  if (w < 2 || h < 2) return;
  const block = 12;
  const sw = Math.max(1, Math.floor(w / block));
  const sh = Math.max(1, Math.floor(h / block));
  const tmp = document.createElement('canvas');
  tmp.width = sw;
  tmp.height = sh;
  const tctx = tmp.getContext('2d') as CanvasRenderingContext2D;
  tctx.drawImage(base, x, y, w, h, 0, 0, sw, sh);
  c.save();
  c.imageSmoothingEnabled = false;
  c.drawImage(tmp, 0, 0, sw, sh, x, y, w, h);
  c.restore();
}

// ---- Off-screen export ------------------------------------------------------
// The off-screen rasterization helpers (renderAttachmentToDataUrl / downscaleDataUrl) live in
// ./crop.ts to keep this module focused on rendering + geometry; they are re-exported here so
// the single `@shot2issue/core/canvas` entry point exposes the full engine surface.
export { renderAttachmentToDataUrl, downscaleDataUrl } from './crop.js';
