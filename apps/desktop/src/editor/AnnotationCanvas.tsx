// The canvas surface: the <canvas> the annotator paints, a hidden <textarea> for the text tool
// (absolutely positioned over the canvas by useAnnotator), the empty-state message, and the
// floating crop confirm bar. Pure presentation — all interaction is wired by useAnnotator via
// the refs passed down from EditorView.

import type { RefObject } from "react";

export default function AnnotationCanvas({
  canvasRef,
  textRef,
  wrapRef,
  empty,
  emptyText,
  cropActive,
  onCropApply,
  onCropCancel,
  cropApplyLabel,
  cropCancelLabel,
}: {
  canvasRef: RefObject<HTMLCanvasElement>;
  textRef: RefObject<HTMLTextAreaElement>;
  wrapRef: RefObject<HTMLDivElement>;
  empty: boolean;
  emptyText: string;
  cropActive: boolean;
  onCropApply: () => void;
  onCropCancel: () => void;
  cropApplyLabel: string;
  cropCancelLabel: string;
}) {
  return (
    <div className="s2i-canvas-wrap" ref={wrapRef}>
      <canvas ref={canvasRef} className={empty ? "hidden" : ""} />
      <textarea ref={textRef} className="s2i-text-input" wrap="off" rows={1} spellCheck={false} />
      {empty && <div className="s2i-canvas-empty">{emptyText}</div>}
      {cropActive && (
        <div className="s2i-crop-bar">
          <button className="primary" onClick={onCropApply}>
            {cropApplyLabel}
          </button>
          <button className="ghost" onClick={onCropCancel}>
            {cropCancelLabel}
          </button>
        </div>
      )}
    </div>
  );
}
