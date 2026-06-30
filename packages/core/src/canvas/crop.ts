// Off-screen rasterization helpers used by the crop / export / AI-context paths. Lifted
// verbatim from the extension's editor.ts (renderAttachmentToDataUrl + downscaleDataUrl).
// Pure aside from creating an off-screen <canvas>; no DOM-id, event, storage, or chrome
// coupling. Split out of canvas/engine.ts to keep each file under the size budget.

import type { Op } from '../types.js';
import { renderOps } from './engine.js';

/** Render a base image (data URL) plus a list of ops to a fresh PNG data URL, off-screen. */
export function renderAttachmentToDataUrl(dataUrl: string, ops: Op[]): Promise<string> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const off = document.createElement('canvas');
      off.width = img.naturalWidth;
      off.height = img.naturalHeight;
      const c = off.getContext('2d');
      if (!c) {
        resolve(dataUrl);
        return;
      }
      renderOps(c, img, off.width, off.height, ops);
      resolve(off.toDataURL('image/png'));
    };
    img.onerror = () => resolve(dataUrl); // fall back to the raw screenshot
    img.src = dataUrl;
  });
}

/** Downscale a data URL to a JPEG (max longest side) for sending to the AI as context. */
export function downscaleDataUrl(src: string, max = 1536): Promise<string> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
      const off = document.createElement('canvas');
      off.width = Math.max(1, Math.round(img.naturalWidth * scale));
      off.height = Math.max(1, Math.round(img.naturalHeight * scale));
      const c = off.getContext('2d');
      if (!c) {
        resolve(src);
        return;
      }
      c.drawImage(img, 0, 0, off.width, off.height);
      resolve(off.toDataURL('image/jpeg', 0.85));
    };
    img.onerror = () => resolve(src);
    img.src = src;
  });
}
