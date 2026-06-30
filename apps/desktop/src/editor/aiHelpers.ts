// Small AI-flow helpers shared by EditorView: rendering each attachment (with annotations) to a
// downscaled JPEG for visual context, building the {dataUrl, filename} submit list, and abort
// detection. Rendering/downscaling delegate to @shot2issue/core/canvas.

import { canvas as eng, type Attachment } from "@shot2issue/core";

export const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export const wasAborted = (c: AbortController | null, e: unknown): boolean =>
  !!c?.signal.aborted || (e instanceof Error && e.name === "AbortError");

/** Render every attachment to a { dataUrl, filename } for submission, in order. */
export async function buildSubmitImages(
  attachments: Attachment[],
): Promise<Array<{ dataUrl: string; filename: string }>> {
  const stamp = Date.now();
  const out: Array<{ dataUrl: string; filename: string }> = [];
  for (let i = 0; i < attachments.length; i++) {
    const dataUrl = await eng.renderAttachmentToDataUrl(attachments[i].dataUrl, attachments[i].ops);
    out.push({ dataUrl, filename: `shot-${i + 1}-${stamp}.png` });
  }
  return out;
}

/** Render every attachment (with annotations) and downscale each for AI visual context. */
export async function aiImages(attachments: Attachment[]): Promise<string[]> {
  const rendered = await buildSubmitImages(attachments);
  const out: string[] = [];
  for (const r of rendered) out.push(await eng.downscaleDataUrl(r.dataUrl));
  return out;
}
