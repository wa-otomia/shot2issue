// The annotation interaction engine, ported from the extension's editor.ts (pointer / keyboard
// / text / crop handling) into a React hook. It keeps the extension's synchronous-redraw model
// by holding ALL mutable interaction state in a single ref (never useState), so a pointer move
// mutates state and repaints in the same tick. ALL geometry + drawing is delegated to
// @shot2issue/core/canvas; crop transforms live in ./useCropTool; selection/crop chrome in
// ./chrome.
//
// The hook owns the *active* attachment's op list (passed in via a ref) and the base image; the
// view owns the attachment array (for the thumbnail strip) and calls loadImage() on switch.

import { useCallback, useEffect, useRef } from "react";
import { canvas as eng, type EditorPrefs, type Op } from "@shot2issue/core";
import {
  applyCrop as applyCropTransform,
  cropHandleAt,
  cropRectFromDrawing,
  moveCrop,
  newCropState,
  resizeCrop,
  type CropState,
  type Rect,
} from "./useCropTool";
import { cursorForHandle, drawCropOverlay, drawSelectionChrome } from "./chrome";

type DragMode = "move" | "resize" | "crop-move" | "crop-resize" | null;
const DRAWING_TOOLS = ["rect", "numrect", "arrow", "pen", "text", "mosaic"];

/** Everything the hook mutates between renders. Held in one ref (synchronous redraw model). */
interface Interaction {
  tool: string;
  ops: Op[]; // the active attachment's ops (a live reference)
  drawing: Op | null;
  pendingTextOp: Op | null;
  selected: Op | null;
  dragMode: DragMode;
  dragHandle: string;
  dragStart: eng.Pt;
  dragOrig: Op | null;
  crop: CropState;
  hasImage: boolean;
  /** Ops popped by undo(), most-recent last. Cleared whenever a new op is committed. */
  redoStack: Op[];
  /** Deletions (op + its index in ops) awaiting undo, most-recent last. */
  deleted: { op: Op; index: number }[];
}

export interface AnnotatorOptions {
  canvasRef: React.RefObject<HTMLCanvasElement>;
  textRef: React.RefObject<HTMLTextAreaElement>;
  wrapRef: React.RefObject<HTMLDivElement>;
  prefsRef: React.MutableRefObject<EditorPrefs>;
  /** Persist the active ops back to the view (fire-and-forget). */
  onPersist: () => void;
  /** After a crop applies: hand back the new base PNG + offset ops for the active attachment. */
  onCropApplied: (dataUrl: string, ops: Op[]) => void;
  /** Show a transient toast (copy result, esc-to-close hint). */
  onToast: (msg: string) => void;
  /** True while an AI generation streams (locks canvas editing). */
  isAiBusy: () => boolean;
  /** Reflect the crop bar's visibility + active state to the view. */
  onCropChange: (active: boolean) => void;
  /** Reflect the current tool to the view (toolbar highlight + font/width control swap). */
  onToolChange: (tool: string) => void;
  /** Persist a remembered editor pref (tool, etc.). */
  patchPrefs: (patch: Partial<EditorPrefs>) => void;
}

export function useAnnotator(opts: AnnotatorOptions) {
  const st = useRef<Interaction>({
    tool: "rect",
    ops: [],
    drawing: null,
    pendingTextOp: null,
    selected: null,
    dragMode: null,
    dragHandle: "",
    dragStart: { x: 0, y: 0 },
    dragOrig: null,
    crop: newCropState(),
    hasImage: false,
    redoStack: [],
    deleted: [],
  });
  const baseImage = useRef<HTMLImageElement>(new Image());

  const ctx = useCallback((): CanvasRenderingContext2D | null => {
    return opts.canvasRef.current?.getContext("2d") ?? null;
  }, [opts.canvasRef]);

  /** Canvas pixels per screen pixel (the canvas element is CSS-scaled to fit). */
  const scaleFactor = useCallback((): number => {
    const cv = opts.canvasRef.current;
    if (!cv) return 1;
    const r = cv.getBoundingClientRect();
    return r.width ? cv.width / r.width : 1;
  }, [opts.canvasRef]);

  // ---- redraw ----------------------------------------------------------------
  const redraw = useCallback((): void => {
    const cv = opts.canvasRef.current;
    const c = ctx();
    if (!cv || !c || !cv.width) return;
    const s = st.current;
    c.clearRect(0, 0, cv.width, cv.height);
    c.drawImage(baseImage.current, 0, 0, cv.width, cv.height);
    for (const op of s.ops) eng.drawOne(c, baseImage.current, op);
    if (s.drawing && s.drawing.tool !== "crop") eng.drawOne(c, baseImage.current, s.drawing);
    if (s.selected) drawSelectionChrome(c, s.selected, scaleFactor());
    const liveCrop: Rect | null =
      s.crop.rect ||
      (s.drawing && s.drawing.tool === "crop" ? cropRectFromDrawing(s.drawing) : null);
    if (liveCrop) drawCropOverlay(c, liveCrop, cv.width, cv.height, scaleFactor());
  }, [ctx, opts.canvasRef, scaleFactor]);

  const deselect = useCallback((): void => {
    if (!st.current.selected) return;
    st.current.selected = null;
    redraw();
  }, [redraw]);

  // ---- text tool -------------------------------------------------------------
  const commitText = useCallback((): void => {
    const ta = opts.textRef.current;
    const cv = opts.canvasRef.current;
    const s = st.current;
    let committed: Op | null = null;
    if (ta && cv && ta.style.display !== "none" && ta.value.trim() && s.pendingTextOp) {
      const scale = cv.width ? cv.getBoundingClientRect().width / cv.width : 1;
      const w = scale ? ta.offsetWidth / scale : s.pendingTextOp.w;
      committed = { ...s.pendingTextOp, w, text: ta.value.replace(/\n+$/, "") };
      s.ops.push(committed);
      s.redoStack.length = 0; // a fresh commit invalidates the redo stack
      s.deleted.length = 0;
    }
    if (ta) {
      ta.style.display = "none";
      ta.blur();
    }
    s.pendingTextOp = null;
    if (committed) s.selected = committed;
    redraw();
    if (committed) opts.onPersist();
  }, [opts, redraw]);

  const openTextBox = useCallback(
    (bx: number, by: number, bw: number, bh: number, size: number, color: string, strokeColor: string): void => {
      const cv = opts.canvasRef.current;
      const ta = opts.textRef.current;
      const wrap = opts.wrapRef.current;
      if (!cv || !ta || !wrap) return;
      const cRect = cv.getBoundingClientRect();
      const wRect = wrap.getBoundingClientRect();
      const scale = cv.width ? cRect.width / cv.width : 1;
      ta.style.left = cRect.left - wRect.left + bx * scale + "px";
      ta.style.top = cRect.top - wRect.top + by * scale + "px";
      ta.style.width = bw * scale + "px";
      ta.style.height = bh * scale + "px";
      ta.style.fontSize = size * scale + "px";
      ta.style.color = color;
      ta.style.display = "block";
      ta.value = "";
      st.current.pendingTextOp = {
        tool: "text",
        color,
        strokeColor,
        strokeWidth: opts.prefsRef.current.strokeWidth,
        size,
        x: bx,
        y: by,
        w: bw,
      };
      setTimeout(() => ta.focus(), 0);
    },
    [opts],
  );

  // ---- tool selection --------------------------------------------------------
  const cancelCrop = useCallback((): void => {
    st.current.crop = newCropState();
    opts.onCropChange(false);
    redraw();
  }, [opts, redraw]);

  const setTool = useCallback(
    (tool: string, persist = true): void => {
      const s = st.current;
      if (tool === s.tool) return;
      commitText();
      if (s.tool === "crop") cancelCrop();
      deselect();
      s.tool = tool;
      opts.onToolChange(tool);
      if (persist && tool !== "crop") opts.patchPrefs({ tool });
    },
    [cancelCrop, commitText, deselect, opts],
  );

  // ---- crop apply ------------------------------------------------------------
  const applyCrop = useCallback((): void => {
    const cv = opts.canvasRef.current;
    const c = ctx();
    const s = st.current;
    if (!s.crop.rect || !cv || !cv.width || !c) return;
    const result = applyCropTransform(baseImage.current, s.crop.rect, s.ops, cv.width, cv.height, c);
    if (!result) return;
    s.crop = newCropState();
    s.selected = null;
    opts.onCropChange(false);
    // setTool('rect', false) — internal reset out of crop mode, must NOT clobber the remembered tool.
    if (s.tool === "crop") {
      s.tool = "rect";
      opts.onToolChange("rect");
    }
    opts.onCropApplied(result.dataUrl, result.ops); // the view re-bases the attachment + calls loadImage
  }, [ctx, opts]);

  // ---- load the active image -------------------------------------------------
  const loadImage = useCallback(
    (dataUrl: string, ops: Op[]): void => {
      const cv = opts.canvasRef.current;
      const s = st.current;
      s.ops = ops;
      s.selected = null;
      s.drawing = null;
      s.pendingTextOp = null;
      s.redoStack.length = 0;
      s.deleted.length = 0;
      s.crop = newCropState();
      opts.onCropChange(false);
      const img = baseImage.current;
      img.onload = () => {
        if (cv) {
          cv.width = img.naturalWidth;
          cv.height = img.naturalHeight;
        }
        s.hasImage = true;
        redraw();
      };
      img.onerror = () => {
        s.hasImage = false;
      };
      img.src = dataUrl;
    },
    [opts, redraw],
  );

  // ---- undo / redo / delete / clear ------------------------------------------
  const undo = useCallback((): void => {
    commitText();
    deselect();
    const s = st.current;
    // Any op-adding action (draw commit / redo) clears s.deleted, so a pending deletion is
    // only ever the single most-recent action when it exists — undo it by re-inserting the
    // op at its original index. Otherwise undo the last draw by popping it onto the redo stack.
    const lastDel = s.deleted.pop();
    if (lastDel) {
      s.ops.splice(Math.min(lastDel.index, s.ops.length), 0, lastDel.op);
    } else {
      const popped = s.ops.pop();
      if (popped) s.redoStack.push(popped);
    }
    redraw();
    opts.onPersist();
  }, [commitText, deselect, opts, redraw]);

  const redo = useCallback((): void => {
    commitText();
    deselect();
    const s = st.current;
    const op = s.redoStack.pop();
    if (!op) return;
    s.ops.push(op);
    s.deleted.length = 0; // re-adding a draw makes it the most-recent action
    redraw();
    opts.onPersist();
  }, [commitText, deselect, opts, redraw]);

  const deleteSelected = useCallback((): void => {
    const s = st.current;
    const sel = s.selected;
    if (!sel) return;
    const index = s.ops.indexOf(sel);
    if (index === -1) return;
    s.ops.splice(index, 1);
    s.selected = null;
    s.deleted.push({ op: sel, index }); // undoable: undo() re-inserts it at `index`
    s.redoStack.length = 0; // a delete diverges history, so drop any redoable ops
    redraw();
    opts.onPersist();
  }, [opts, redraw]);

  const clear = useCallback((): void => {
    commitText();
    deselect();
    const s = st.current;
    s.ops.length = 0; // clear in place so the attachment's ops array identity is kept
    s.redoStack.length = 0;
    s.deleted.length = 0;
    redraw();
    opts.onPersist();
  }, [commitText, deselect, opts, redraw]);

  // ---- export / clipboard ----------------------------------------------------
  const clearChrome = useCallback((): void => {
    if (st.current.crop.rect) cancelCrop();
    deselect();
    redraw();
  }, [cancelCrop, deselect, redraw]);

  const download = useCallback((): void => {
    const cv = opts.canvasRef.current;
    if (!cv) return;
    commitText();
    clearChrome();
    const a = document.createElement("a");
    a.href = cv.toDataURL("image/png");
    a.download = `shot-${Date.now()}.png`;
    a.click();
  }, [clearChrome, commitText, opts.canvasRef]);

  const copy = useCallback(async (): Promise<void> => {
    const cv = opts.canvasRef.current;
    if (!cv || !st.current.hasImage) return;
    commitText();
    clearChrome();
    try {
      const blob = await new Promise<Blob | null>((res) => cv.toBlob(res, "image/png"));
      if (!blob) throw new Error("no image");
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      opts.onToast("copied");
    } catch (e) {
      opts.onToast("copyFailed:" + (e instanceof Error ? e.message : String(e)));
    }
  }, [clearChrome, commitText, opts]);

  /** Apply a pref change to the currently selected op (live recolor/resize after drawing). */
  const applyPrefToSelected = useCallback(
    (patch: Partial<Op>): void => {
      const sel = st.current.selected;
      const pending = st.current.pendingTextOp;
      const cv = opts.canvasRef.current;
      // Font size live-resizes the text being typed, too.
      if (patch.size != null && pending && cv) {
        pending.size = patch.size;
        const scale = cv.width ? cv.getBoundingClientRect().width / cv.width : 1;
        if (opts.textRef.current) opts.textRef.current.style.fontSize = patch.size * scale + "px";
      }
      if (!sel) return;
      if (patch.color != null) sel.color = patch.color;
      if (patch.strokeColor != null) sel.strokeColor = patch.strokeColor;
      if (patch.strokeWidth != null) sel.strokeWidth = patch.strokeWidth;
      if (patch.width != null && sel.tool !== "text") sel.width = patch.width;
      if (patch.size != null && sel.tool === "text") sel.size = patch.size;
      redraw();
      opts.onPersist();
    },
    [opts, redraw],
  );

  // ---- pointer + keyboard wiring --------------------------------------------
  useEffect(() => {
    const cv = opts.canvasRef.current;
    const ta = opts.textRef.current;
    if (!cv || !ta) return;

    const toCanvasXY = (evt: MouseEvent): eng.Pt => {
      const rect = cv.getBoundingClientRect();
      const scaleX = cv.width / rect.width;
      const scaleY = cv.height / rect.height;
      return { x: (evt.clientX - rect.left) * scaleX, y: (evt.clientY - rect.top) * scaleY };
    };

    const normalizeSelected = (): void => {
      const op = st.current.selected;
      if (!op || op.tool === "arrow" || op.tool === "text") return;
      const l = Math.min(op.x0 ?? 0, op.x1 ?? 0);
      const r = Math.max(op.x0 ?? 0, op.x1 ?? 0);
      const t = Math.min(op.y0 ?? 0, op.y1 ?? 0);
      const b = Math.max(op.y0 ?? 0, op.y1 ?? 0);
      op.x0 = l;
      op.y0 = t;
      op.x1 = r;
      op.y1 = b;
    };

    const updateHoverCursor = (p: eng.Pt): void => {
      const s = st.current;
      const c = ctx();
      let cur = "crosshair";
      if (s.tool === "crop" && s.crop.rect) {
        const h = cropHandleAt(s.crop, p, scaleFactor());
        if (h) cur = cursorForHandle(h);
        else if (eng.pointInRect(p, s.crop.rect)) cur = "move";
      } else if (s.selected && c) {
        const h = eng.handleAt(c, s.selected, p, scaleFactor());
        if (h) cur = cursorForHandle(h);
        else if (eng.pointInOp(c, s.selected, p, scaleFactor())) cur = "move";
      }
      cv.style.cursor = cur;
    };

    const onDown = (e: MouseEvent): void => {
      if (e.button !== 0 || opts.isAiBusy() || !st.current.hasImage) return;
      const c = ctx();
      if (!c) return;
      const s = st.current;
      const p = toCanvasXY(e);
      const prefs = opts.prefsRef.current;

      if (s.tool === "crop") {
        if (s.crop.rect) {
          const h = cropHandleAt(s.crop, p, scaleFactor());
          if (h) {
            s.dragMode = "crop-resize";
            s.dragHandle = h;
            s.crop.orig = { ...s.crop.rect };
            s.dragStart = p;
            return;
          }
          if (eng.pointInRect(p, s.crop.rect)) {
            s.dragMode = "crop-move";
            s.crop.orig = { ...s.crop.rect };
            s.dragStart = p;
            return;
          }
        }
        s.crop.rect = null;
        opts.onCropChange(false);
        s.drawing = { tool: "crop", color: "", x0: p.x, y0: p.y, x1: p.x, y1: p.y };
        return;
      }

      if (s.selected) {
        const h = eng.handleAt(c, s.selected, p, scaleFactor());
        if (h) {
          s.dragMode = "resize";
          s.dragHandle = h;
          s.dragOrig = eng.cloneOp(s.selected);
          s.dragStart = p;
          return;
        }
        if (eng.pointInOp(c, s.selected, p, scaleFactor())) {
          s.dragMode = "move";
          s.dragOrig = eng.cloneOp(s.selected);
          s.dragStart = p;
          return;
        }
        deselect();
      }

      if (s.tool === "text") {
        commitText();
        s.drawing = { tool: "textbox", color: prefs.color, strokeColor: prefs.strokeColor, strokeWidth: prefs.strokeWidth, width: prefs.width, x0: p.x, y0: p.y, x1: p.x, y1: p.y };
        return;
      }
      if (s.tool === "pen") {
        s.drawing = { tool: "pen", color: prefs.color, strokeColor: prefs.strokeColor, strokeWidth: prefs.strokeWidth, width: prefs.width, points: [{ x: p.x, y: p.y }] };
        return;
      }
      s.drawing = { tool: s.tool, color: prefs.color, strokeColor: prefs.strokeColor, strokeWidth: prefs.strokeWidth, width: prefs.width, x0: p.x, y0: p.y, x1: p.x, y1: p.y };
      if (s.tool === "numrect") {
        s.drawing.num = Math.max(0, ...s.ops.filter((o) => o.tool === "numrect").map((o) => o.num ?? 0)) + 1;
      }
    };

    const onMove = (e: MouseEvent): void => {
      const s = st.current;
      const cv2 = opts.canvasRef.current;
      if (!cv2) return;
      const p = toCanvasXY(e);
      if (s.dragMode === "move" && s.dragOrig && s.selected) {
        eng.moveOpBy(s.selected, s.dragOrig, p.x - s.dragStart.x, p.y - s.dragStart.y);
        redraw();
        return;
      }
      if (s.dragMode === "resize" && s.dragOrig && s.selected) {
        eng.resizeOp(s.selected, s.dragOrig, s.dragHandle, p);
        redraw();
        return;
      }
      if (s.dragMode === "crop-move" && s.crop.orig && s.crop.rect) {
        moveCrop(s.crop, p, s.dragStart, cv2.width, cv2.height);
        redraw();
        return;
      }
      if (s.dragMode === "crop-resize") {
        resizeCrop(s.crop, s.dragHandle, p, cv2.width, cv2.height);
        redraw();
        return;
      }
      if (!s.drawing) {
        updateHoverCursor(p);
        return;
      }
      if (s.drawing.tool === "pen") s.drawing.points?.push({ x: p.x, y: p.y });
      else {
        s.drawing.x1 = p.x;
        s.drawing.y1 = p.y;
      }
      redraw();
    };

    const onUp = (): void => {
      const s = st.current;
      if (s.dragMode) {
        if (s.dragMode === "move" || s.dragMode === "resize") {
          normalizeSelected();
          opts.onPersist();
        }
        s.dragMode = null;
        s.dragOrig = null;
        s.crop.orig = null;
        redraw();
        return;
      }
      if (!s.drawing) return;
      const d = s.drawing;
      s.drawing = null;

      if (d.tool === "crop") {
        const x = Math.min(d.x0 ?? 0, d.x1 ?? 0);
        const y = Math.min(d.y0 ?? 0, d.y1 ?? 0);
        const w = Math.abs((d.x1 ?? 0) - (d.x0 ?? 0));
        const h = Math.abs((d.y1 ?? 0) - (d.y0 ?? 0));
        if (w > 8 && h > 8) {
          s.crop.rect = { x, y, w, h };
          opts.onCropChange(true);
        }
        redraw();
        return;
      }
      if (d.tool === "textbox") {
        const bx = Math.min(d.x0 ?? 0, d.x1 ?? 0);
        const by = Math.min(d.y0 ?? 0, d.y1 ?? 0);
        let bw = Math.abs((d.x1 ?? 0) - (d.x0 ?? 0));
        let bh = Math.abs((d.y1 ?? 0) - (d.y0 ?? 0));
        const size = opts.prefsRef.current.fontSize;
        if (bw < 8 || bh < 8) {
          bw = 240;
          bh = Math.round(size * 1.6);
        }
        redraw();
        openTextBox(bx, by, bw, bh, size, d.color, d.strokeColor || opts.prefsRef.current.strokeColor);
        return;
      }
      let added = false;
      if (d.tool === "pen") {
        if ((d.points?.length ?? 0) > 1) {
          s.ops.push(d);
          added = true;
        }
      } else {
        const moved = Math.hypot((d.x1 ?? 0) - (d.x0 ?? 0), (d.y1 ?? 0) - (d.y0 ?? 0)) > 3;
        if (moved) {
          s.ops.push(d);
          added = true;
        }
      }
      if (added) {
        s.redoStack.length = 0; // a fresh draw invalidates redo + pending deletions
        s.deleted.length = 0;
        s.selected = eng.isSelectable(d.tool) ? d : null;
        opts.onPersist();
      }
      redraw();
    };

    const onTextKey = (e: KeyboardEvent): void => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        commitText();
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        ta.style.display = "none";
        ta.blur();
        st.current.pendingTextOp = null;
      }
    };

    cv.addEventListener("mousedown", onDown);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    ta.addEventListener("keydown", onTextKey);
    ta.addEventListener("blur", commitText);
    return () => {
      cv.removeEventListener("mousedown", onDown);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      ta.removeEventListener("keydown", onTextKey);
      ta.removeEventListener("blur", commitText);
    };
  }, [commitText, ctx, deselect, openTextBox, opts, redraw, scaleFactor]);

  return {
    baseImage,
    redraw,
    deselect,
    commitText,
    setTool,
    loadImage,
    undo,
    redo,
    deleteSelected,
    clear,
    applyCrop,
    cancelCrop,
    download,
    copy,
    applyPrefToSelected,
    /** Read-only helpers for the view's keyboard shortcuts. */
    state: st,
    isDrawingTool: (t: string) => DRAWING_TOOLS.includes(t),
  };
}
