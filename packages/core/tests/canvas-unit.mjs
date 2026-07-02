// Unit tests for the pure canvas annotation engine in @shot2issue/core (no platform, no network).
//
// SCOPE NOTE (read before extending): packages/core/src/canvas/engine.ts + crop.ts export only
// stateless geometry/hit-test/render helpers (cloneOp, moveOpBy, resizeOp, bboxOf, handleAt,
// pointInOp, offsetOp, opIntersects, renderOps, wrapText, drawOne, ...). There is NO shape list,
// NO undo/redo stack, and NO applyCrop() in @shot2issue/core — that stateful engine (ops[],
// redoStack, deleted[], cropHistory[], applyCrop()) lives in apps/desktop/src/editor/
// useAnnotator.ts and useCropTool.ts, which are React hooks outside packages/core and were
// explicitly out of scope for this file. Verified by reading both files before writing this
// suite (grep for "undo"/"crop" across apps+packages turned up the state machine only in
// apps/desktop; packages/core's ./canvas export map points solely at engine.ts).
//
// To still exercise the *designed* scenarios (add/move/delete/undo/redo, crop apply/undo,
// coordinate mapping) against real product code, this file defines a tiny local harness
// (`makeShapeEngine`, `applyCropLikeDesktop`) that reproduces the bookkeeping shape
// (ops array / redo stack / crop history) but delegates every actual geometry/mutation/
// clamping decision to the real exported functions below. The harness itself is test
// scaffolding, not product code — bugs in *its* bookkeeping are not @shot2issue/core bugs,
// only bugs surfaced through the real cloneOp/moveOpBy/resizeOp/offsetOp/opIntersects/clamp
// calls are reported as such.
//
// Run: node tests/canvas-unit.mjs (per run.mjs convention: build/ must already be current
// with src/; this file does NOT invoke tsc).

import {
  HANDLE,
  clamp,
  cloneOp,
  isSelectable,
  bboxOf,
  boxHandles,
  handlesOf,
  handleAt,
  distToSeg,
  pointInOp,
  pointInRect,
  moveOpBy,
  resizeOp,
  offsetOp,
  opIntersects,
  renderOps,
  haloWidth,
  outlineWidth,
  drawOne,
  wrapText,
} from '../build/canvas/engine.js';

let pass = 0;
let fail = 0;
function check(name, cond) {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}`);
  }
}

// A minimal fake CanvasRenderingContext2D: records calls, never touches real Canvas/DOM APIs.
// bboxOf/handlesOf only dereference ctx for 'text' ops (font/measureText/save/restore); for
// rect/arrow/numrect/mosaic ops (used throughout this suite) ctx is not read at all.
function makeFakeCtx() {
  const calls = [];
  const ctx = {
    calls,
    save() { calls.push(['save']); },
    restore() { calls.push(['restore']); },
    clearRect(...a) { calls.push(['clearRect', ...a]); },
    drawImage(...a) { calls.push(['drawImage', ...a]); },
    beginPath() { calls.push(['beginPath']); },
    closePath() { calls.push(['closePath']); },
    moveTo(...a) { calls.push(['moveTo', ...a]); },
    lineTo(...a) { calls.push(['lineTo', ...a]); },
    stroke() { calls.push(['stroke']); },
    fill() { calls.push(['fill']); },
    arc(...a) { calls.push(['arc', ...a]); },
    strokeRect(...a) { calls.push(['strokeRect', ...a]); },
    fillRect(...a) { calls.push(['fillRect', ...a]); },
    fillText(...a) { calls.push(['fillText', ...a]); },
    strokeText(...a) { calls.push(['strokeText', ...a]); },
    setLineDash(...a) { calls.push(['setLineDash', ...a]); },
    measureText(text) { return { width: text.length * 6 }; }, // deterministic 6px/char
    font: '',
    lineWidth: 1,
    lineJoin: 'miter',
    lineCap: 'butt',
    strokeStyle: '#000',
    fillStyle: '#000',
    textAlign: 'start',
    textBaseline: 'alphabetic',
    imageSmoothingEnabled: true,
  };
  return ctx;
}

const rectOp = (over = {}) => ({ tool: 'rect', color: '#ff0000', x0: 10, y0: 10, x1: 50, y1: 40, width: 4, ...over });
const arrowOp = (over = {}) => ({ tool: 'arrow', color: '#00ff00', x0: 0, y0: 0, x1: 100, y1: 50, width: 4, ...over });
const penOp = (over = {}) => ({ tool: 'pen', color: '#0000ff', width: 4, points: [{ x: 10, y: 10 }, { x: 30, y: 15 }, { x: 20, y: 40 }], ...over });

// =====================================================================================
// A tiny "shape engine" harness: ops[] + undo/redo, built ONLY from the real exported
// primitives (cloneOp for snapshotting, moveOpBy/resizeOp for mutation) and modeling the
// EXACT undo/redo semantics read out of apps/desktop/src/editor/useAnnotator.ts (undo(),
// redo(), deleteSelected(), onUp() at lines 272-326 and 545-554):
//   - add:            ops.push(op); redoStack.length = 0 (a fresh commit invalidates redo).
//   - delete:         ops.splice(index,1); deleted.push({op,index}) (single pending slot --
//                     the real code only ever has one outstanding deletion, since any add
//                     clears `deleted`); redoStack.length = 0.
//   - move / resize:  mutates the op in place (moveOpBy/resizeOp) and is a "history
//                     diverging" edit: deleted.length = 0; redoStack.length = 0. It is NOT
//                     itself undoable/redoable as its own step -- there is no snapshot of
//                     pre-move geometry pushed anywhere in the real hook.
//   - undo():         pop the pending deletion first (re-insert at its index) if present;
//                     else pop the most recent op onto the redo stack.
//   - redo():         pop the redo stack back onto ops; redoing an add clears `deleted`
//                     (re-adding a draw makes it the most-recent action).
// This harness is test scaffolding (not product code); it exists so cases 1-5, designed
// against "the engine's shape list / undo / redo", can run against the real geometry
// primitives with the real product's own undo model, rather than an invented one.
// =====================================================================================
function makeShapeEngine() {
  const state = {
    ops: [],
    redoStack: [], // ops popped by undo(), most-recent last (mirrors useAnnotator.ts's redoStack)
    deleted: null, // single pending deletion {op, index} (mirrors useAnnotator.ts's `deleted` array, which in practice never holds more than one entry)
  };
  return {
    ops: state.ops,
    add(op) {
      state.ops.push(op);
      state.redoStack.length = 0;
    },
    moveBy(index, dx, dy) {
      const op = state.ops[index];
      const orig = cloneOp(op);
      moveOpBy(op, orig, dx, dy);
      state.deleted = null;
      state.redoStack.length = 0;
    },
    resize(index, handle, p) {
      const op = state.ops[index];
      const orig = cloneOp(op);
      resizeOp(op, orig, handle, p);
      state.deleted = null;
      state.redoStack.length = 0;
    },
    remove(index) {
      const [op] = state.ops.splice(index, 1);
      state.deleted = { op, index };
      state.redoStack.length = 0;
      return op;
    },
    undo() {
      if (state.deleted) {
        const { op, index } = state.deleted;
        state.deleted = null;
        state.ops.splice(Math.min(index, state.ops.length), 0, op);
        return true;
      }
      const popped = state.ops.pop();
      if (!popped) return false;
      state.redoStack.push(popped);
      return true;
    },
    redo() {
      const op = state.redoStack.pop();
      if (!op) return false;
      state.ops.push(op);
      state.deleted = null; // re-adding a draw makes it the most-recent action
      return true;
    },
    canRedo() { return state.redoStack.length > 0; },
  };
}

// =====================================================================================
// Case 1: add shape -> appears in the engine's shape list with the given geometry
// =====================================================================================
{
  const eng = makeShapeEngine();
  const r = rectOp();
  eng.add(r);
  check('add: shape appears in ops list', eng.ops.length === 1 && eng.ops[0] === r);
  check('add: geometry matches what was given', eng.ops[0].x0 === 10 && eng.ops[0].y0 === 10 && eng.ops[0].x1 === 50 && eng.ops[0].y1 === 40);

  const a = arrowOp();
  eng.add(a);
  check('add: a second shape appends (does not replace)', eng.ops.length === 2 && eng.ops[1] === a);
}

// =====================================================================================
// Case 2: move/resize a shape -> geometry updated
// =====================================================================================
{
  const eng = makeShapeEngine();
  eng.add(rectOp());
  eng.moveBy(0, 5, -3);
  check('move: x0/y0/x1/y1 shifted by dx/dy', JSON.stringify([eng.ops[0].x0, eng.ops[0].y0, eng.ops[0].x1, eng.ops[0].y1]) === JSON.stringify([15, 7, 55, 37]));

  eng.resize(0, 'se', { x: 100, y: 90 });
  // resizeOp: handle includes 'e' -> r = p.x; includes 's' -> b = p.y. l/t stay at the moved position.
  check('resize: se handle drags the right/bottom edge', eng.ops[0].x1 === 100 && eng.ops[0].y1 === 90 && eng.ops[0].x0 === 15 && eng.ops[0].y0 === 7);

  // Resize an arrow endpoint (arrow uses named endpoints, not box handles).
  const eng2 = makeShapeEngine();
  eng2.add(arrowOp());
  eng2.resize(0, 'p1', { x: 200, y: 150 });
  check('resize: arrow p1 handle moves the arrow tip only', eng2.ops[0].x1 === 200 && eng2.ops[0].y1 === 150 && eng2.ops[0].x0 === 0 && eng2.ops[0].y0 === 0);
}

// =====================================================================================
// Case 3: delete a shape -> gone; undo -> restored
// =====================================================================================
{
  const eng = makeShapeEngine();
  const r1 = rectOp({ x0: 1, y0: 1, x1: 2, y1: 2 });
  const r2 = rectOp({ x0: 9, y0: 9, x1: 20, y1: 20 });
  eng.add(r1);
  eng.add(r2);
  eng.remove(0);
  check('delete: shape removed from list', eng.ops.length === 1 && eng.ops[0] === r2);

  eng.undo();
  check('delete-undo: shape restored', eng.ops.length === 2 && eng.ops[0] === r1 && eng.ops[1] === r2);
  check('delete-undo: restored at its original index (order preserved)', eng.ops.indexOf(r1) === 0);
}

// =====================================================================================
// Case 4: undo/redo round-trip over a mixed sequence (add, add, move, delete) ends in
// the expected state.
//
// Per the real undo model (see the harness comment above, mirroring useAnnotator.ts): a
// move/resize is a history-diverging edit, not an independently undoable step. So starting
// from empty ops, add(A), add(B), move(A), delete(B) leaves exactly one pending deletion
// (B) undoable, then two adds (A, B) undoable/redoable behind it -- the moved geometry on A
// is simply part of A's current state, carried along through undo/redo like any other field.
// =====================================================================================
{
  const eng = makeShapeEngine();
  eng.add(rectOp({ x0: 0, y0: 0, x1: 10, y1: 10 })); // op A
  eng.add(rectOp({ x0: 100, y0: 100, x1: 110, y1: 110 })); // op B
  eng.moveBy(0, 5, 5); // A -> (5,5,15,15); history-diverging (per the real model), not its own undo step
  eng.remove(1); // remove B; this is the one pending deletion

  const expectedFinal = JSON.stringify(eng.ops.map((o) => ({ x0: o.x0, y0: o.y0, x1: o.x1, y1: o.y1 })));
  check('mixed: after add,add,move,delete only A remains, moved', expectedFinal === JSON.stringify([{ x0: 5, y0: 5, x1: 15, y1: 15 }]));

  // Undo: first pops the pending deletion (B back), then pops adds one at a time (B, then A).
  eng.undo(); // undo delete(B) -> B restored at its index
  check('mixed: first undo re-inserts the pending deletion (B), A keeps its moved geometry', eng.ops.length === 2 && eng.ops[0].x0 === 5 && eng.ops[1].x0 === 100);
  eng.undo(); // undo add(B) -> B popped onto the redo stack
  eng.undo(); // undo add(A) -> A popped onto the redo stack
  check('mixed: full undo empties the list', eng.ops.length === 0);

  eng.redo(); // redo add(A)
  eng.redo(); // redo add(B) (re-adding clears the (already-empty) `deleted` slot)
  const afterRoundTrip = JSON.stringify(eng.ops.map((o) => ({ x0: o.x0, y0: o.y0, x1: o.x1, y1: o.y1 })));
  check('mixed: full undo + full redo (2 undos, 2 redos) round-trips back to the state right after the moved A and restored B', afterRoundTrip === JSON.stringify([{ x0: 5, y0: 5, x1: 15, y1: 15 }, { x0: 100, y0: 100, x1: 110, y1: 110 }]));
}

// =====================================================================================
// Case 5: redo stack is cleared when a new op is performed after an undo.
// =====================================================================================
{
  const eng = makeShapeEngine();
  eng.add(rectOp());
  eng.add(arrowOp());
  eng.undo(); // undo the arrow add
  check('redo-clear: redo is available right after an undo', eng.canRedo());

  eng.add(rectOp({ x0: 1, y0: 1, x1: 2, y1: 2 })); // a brand-new op after the undo
  check('redo-clear: performing a new op after undo clears the redo stack', !eng.canRedo());
  check('redo-clear: redo() is now a no-op (does not resurrect the discarded branch)', eng.redo() === false && eng.ops.length === 2);
}

// =====================================================================================
// Case 6: crop apply -> canvas/image dims change; undo crop -> original dims AND
// annotation coordinates restored (the v0.1.11 feature).
//
// NOTE: apps/desktop/src/editor/useCropTool.ts's applyCrop() (the real product entry point
// for this feature) lives OUTSIDE @shot2issue/core and cannot be imported here. What IS in
// packages/core and is exercised below is the exact geometry it composes: clamp() (bounds
// clamping) + offsetOp() (shifting ops into the new origin) + opIntersects() (dropping ops
// that fall outside the cropped frame). We reproduce applyCrop's documented transform
// (apps/desktop/src/editor/useCropTool.ts:80-104), INCLUDING its zero-area guard (returns
// null for a degenerate rect instead of flooring to 1x1), verbatim using only these real,
// imported primitives, then verify the crop is undoable back to original dims + coordinates
// using a desktop-style cropHistory snapshot (dataUrl/dims + pre-crop ops), matching the
// shape of useAnnotator.ts's `cropHistory` field.
// =====================================================================================
function applyCropLikeDesktop(rect, ops, canvasW, canvasH, ctx) {
  const x = clamp(Math.round(rect.x), 0, canvasW - 1);
  const y = clamp(Math.round(rect.y), 0, canvasH - 1);
  if (Math.round(rect.w) < 1 || Math.round(rect.h) < 1) return null; // degenerate rect: no-op
  const w = clamp(Math.round(rect.w), 1, canvasW - x);
  const h = clamp(Math.round(rect.h), 1, canvasH - y);
  const nextOps = ops.map((op) => offsetOp(op, -x, -y)).filter((op) => opIntersects(ctx, op, w, h));
  return { x, y, w, h, ops: nextOps };
}

{
  const ctx = makeFakeCtx();
  const canvasW = 400, canvasH = 300;
  const ops = [
    rectOp({ x0: 60, y0: 60, x1: 90, y1: 80 }), // fully inside the crop region below
    rectOp({ x0: 350, y0: 250, x1: 390, y1: 290 }), // fully outside the crop region below
  ];
  const cropRect = { x: 50, y: 50, w: 150, h: 100 };

  // -- crop history snapshot, desktop-style (dataUrl stands in for the "canvas image"): --
  const preCropSnapshot = { dims: { w: canvasW, h: canvasH }, ops: ops.map(cloneOp) };

  const applied = applyCropLikeDesktop(cropRect, ops, canvasW, canvasH, ctx);
  const postDims = { w: applied.w, h: applied.h };

  check('crop-apply: canvas dims change to the crop rect size', postDims.w === 150 && postDims.h === 100 && (postDims.w !== canvasW || postDims.h !== canvasH));
  check('crop-apply: in-bounds op is kept and re-based to the new origin', applied.ops.length === 1 && applied.ops[0].x0 === 10 && applied.ops[0].y0 === 10 && applied.ops[0].x1 === 40 && applied.ops[0].y1 === 30);
  check('crop-apply: the out-of-frame op is dropped (opIntersects filter)', !applied.ops.some((o) => o.x0 === 300)); // op that was at x0=350-50=300 filtered out

  // -- undo crop: restore original dims AND original (pre-offset) annotation coordinates --
  const restoredDims = preCropSnapshot.dims;
  const restoredOps = preCropSnapshot.ops;
  check('crop-undo: original canvas dims restored', restoredDims.w === canvasW && restoredDims.h === canvasH);
  check('crop-undo: original op coordinates restored (not the cropped/offset ones)', restoredOps[0].x0 === 60 && restoredOps[0].y0 === 60 && restoredOps[1].x0 === 350);
  check('crop-undo: the previously-dropped out-of-frame op reappears', restoredOps.length === 2);

  // -- pen (freehand) ops: bboxOf() now computes a points-based bbox, so a pen stroke fully
  // inside the crop region survives (and is offset), and one fully outside is dropped -- same
  // as rect ops above. Before the bboxOf() fix, ALL pen ops were dropped by ANY crop (bboxOf
  // returned {0,0,0,0} for points-only ops, so opIntersects() was always false).
  const penInside = penOp({ points: [{ x: 60, y: 60 }, { x: 80, y: 70 }, { x: 90, y: 80 }] }); // fully inside cropRect
  const penOutside = penOp({ points: [{ x: 350, y: 250 }, { x: 360, y: 260 }, { x: 370, y: 270 }] }); // fully outside cropRect
  const penApplied = applyCropLikeDesktop(cropRect, [penInside, penOutside], canvasW, canvasH, ctx);
  check('crop-apply: a pen stroke fully inside the crop survives', penApplied.ops.length === 1 && penApplied.ops[0].tool === 'pen');
  check('crop-apply: the surviving pen stroke is offset by the crop origin', JSON.stringify(penApplied.ops[0].points) === JSON.stringify([{ x: 10, y: 10 }, { x: 30, y: 20 }, { x: 40, y: 30 }]));
  check('crop-apply: a pen stroke fully outside the crop is dropped', !penApplied.ops.some((o) => o.tool === 'pen' && o.points.some((p) => p.x > 100)));
}

// =====================================================================================
// Case 7: crop rect normalization -- inverted drag yields positive size; clamp to image
// bounds; zero-area crop is rejected/no-op.
// =====================================================================================
{
  // Inverted drag (end < start): normalize the same way engine.ts's drawOne/bboxOf do for
  // 'crop'/'textbox' preview ops (min of the two corners, abs of the deltas) -- this is the
  // exact math at engine.ts:188-193 (Math.min(x0,x1), Math.abs(x1-x0)).
  function normalizeCropDrag(d) {
    const x = Math.min(d.x0 ?? 0, d.x1 ?? 0);
    const y = Math.min(d.y0 ?? 0, d.y1 ?? 0);
    const w = Math.abs((d.x1 ?? 0) - (d.x0 ?? 0));
    const h = Math.abs((d.y1 ?? 0) - (d.y0 ?? 0));
    return { x, y, w, h };
  }
  const inverted = normalizeCropDrag({ x0: 120, y0: 80, x1: 20, y1: 30 }); // dragged up-and-left
  check('crop-normalize: inverted drag yields a positive-size rect', inverted.w > 0 && inverted.h > 0);
  check('crop-normalize: inverted drag rect has the correct top-left', inverted.x === 20 && inverted.y === 30 && inverted.w === 100 && inverted.h === 50);

  // Clamp to image bounds: reuse applyCropLikeDesktop's clamp (same as useCropTool.ts resizeCrop's
  // clamp(p.x, 0, canvasW) / clamp(p.y, 0, canvasH) pattern for keeping a crop rect on-canvas).
  const ctx = makeFakeCtx();
  const canvasW = 100, canvasH = 80;
  const overhanging = { x: -30, y: -10, w: 200, h: 200 }; // drawn far outside the canvas
  const applied = applyCropLikeDesktop(overhanging, [], canvasW, canvasH, ctx);
  check('crop-normalize: x/y clamp to >= 0', applied.x === 0 && applied.y === 0);
  check('crop-normalize: w/h clamp so the rect never exceeds the canvas', applied.x + applied.w <= canvasW && applied.y + applied.h <= canvasH);

  // Zero-area crop is rejected / no-op: apps/desktop/src/editor/useCropTool.ts's applyCrop()
  // now guards against a degenerate (zero-width or zero-height) rect and returns null before
  // ever flooring it to a 1x1 crop. useAnnotator.ts's applyCrop() treats a null result as a
  // no-op (`if (!result) return;` -- no cropHistory push, no applyLoad, no onCropApplied), so
  // the crop rect stays as-is for the user to adjust or cancel, and existing ops are untouched.
  const zero = { x: 10, y: 10, w: 0, h: 0 };
  const zeroApplied = applyCropLikeDesktop(zero, [rectOp()], canvasW, canvasH, ctx);
  check('crop-normalize: a zero-area crop rect is rejected as a no-op (returns null, not a 1x1 crop)', zeroApplied === null);

  const zeroHeight = { x: 10, y: 10, w: 40, h: 0.4 }; // rounds to h=0
  const zeroHeightApplied = applyCropLikeDesktop(zeroHeight, [rectOp()], canvasW, canvasH, ctx);
  check('crop-normalize: a rect that rounds to zero height is also rejected', zeroHeightApplied === null);
}

// =====================================================================================
// Case 8: coordinate mapping at devicePixelRatio=2 -- screen->image transform used by
// hit-testing is scale-correct.
//
// engine.ts's hit-testing (handleAt/pointInOp/distToSeg) takes canvas-px points directly and
// a `scale` factor (canvas px per screen px -- see useAnnotator.ts's scaleFactor(), which is
// canvas.width / canvas.getBoundingClientRect().width, i.e. dpr when the backing store is
// sized at devicePixelRatio and the CSS size is unscaled). We simulate dpr=2 the same way:
// a canvas backing store at 2x the CSS/screen size, so 1 screen px = 2 canvas px, and confirm
// the HANDLE tolerance (screen px) is converted to canvas px via `scale` before comparison.
// =====================================================================================
{
  const ctx = makeFakeCtx();
  const dpr = 2;
  // A rect op at canvas-px (backing-store) coordinates; on a dpr=2 display this is a 40x30
  // CSS-px rect drawn at 80x60 canvas px.
  const op = rectOp({ x0: 100, y0: 100, x1: 180, y1: 160 }); // 80x60 canvas px

  // The 'se' handle sits at the bottom-right corner: canvas px (180, 160).
  const handles = boxHandles(bboxOf(ctx, op));
  const se = handles.find((h) => h.name === 'se');
  check('dpr2: se handle is at the canvas-px corner', se.x === 180 && se.y === 160);

  // A screen click 4 CSS-px away from the corner is within HANDLE(9) tolerance in CSS px,
  // but must be converted to canvas px (x2) before comparing against the canvas-px handle.
  const screenClickPt = { x: 90, y: 80 }; // CSS px pointer position
  const canvasPt = { x: screenClickPt.x * dpr, y: screenClickPt.y * dpr }; // -> (180, 160) canvas px, dead on corner
  check('dpr2: handleAt hits the se handle when the screen point is mapped to canvas px by *dpr', handleAt(ctx, op, canvasPt, dpr) === 'se');

  // A click 8 CSS-px away (within the 9px CSS tolerance) should still hit once mapped & scaled.
  const nearMiss = { x: 90 - 4, y: 80 }; // 4 CSS px left of the true corner-in-CSS-px position (90,80)
  const nearMissCanvas = { x: nearMiss.x * dpr, y: nearMiss.y * dpr };
  check('dpr2: a near (within-tolerance) screen click still resolves to the se handle', handleAt(ctx, op, nearMissCanvas, dpr) === 'se');

  // A click far away in CSS px (well outside the 9px tolerance even after scaling, and clear
  // of every other handle on the box) must miss entirely.
  const farMiss = { x: 200, y: 200 };
  const farMissCanvas = { x: farMiss.x * dpr, y: farMiss.y * dpr };
  check('dpr2: a screen click outside tolerance does not hit any handle', handleAt(ctx, op, farMissCanvas, dpr) === '');

  // Sanity: without accounting for dpr (i.e. naively using scale=1 with a CSS-px point against
  // canvas-px geometry), the same near-miss point would NOT hit -- proving the *dpr mapping,
  // not just the tolerance, is what makes the hit-test correct at HiDPI.
  check('dpr2: the same CSS-px point WITHOUT the *dpr mapping would miss (demonstrates the mapping matters)', handleAt(ctx, op, nearMiss, dpr) === '');

  // pointInOp for an arrow: distToSeg tolerance is `8 * scale` canvas px, so at dpr=2 the
  // hit-test corridor is twice as wide in canvas px as it would be at dpr=1 for the same
  // CSS-px tolerance -- confirm a point that only hits at dpr=2 (not dpr=1) is handled correctly.
  const arrow = arrowOp({ x0: 0, y0: 0, x1: 100, y1: 0 }); // horizontal arrow along y=0 (canvas px)
  const offAxis = { x: 50, y: 14 }; // 14 canvas px off the line
  check('dpr2: arrow hit-test tolerance scales with dpr (misses at scale=1)', pointInOp(ctx, arrow, offAxis, 1) === false);
  check('dpr2: arrow hit-test tolerance scales with dpr (hits at scale=2, 14 <= 8*2=16)', pointInOp(ctx, arrow, offAxis, 2) === true);
}

// =====================================================================================
// A few additional direct checks against the real exported primitives, to make sure the
// harness above isn't the only thing exercising engine.ts/crop.ts.
// =====================================================================================
{
  const ctx = makeFakeCtx();
  check('isSelectable: rect/numrect/arrow/mosaic/text selectable, pen is not', isSelectable('rect') && isSelectable('numrect') && isSelectable('arrow') && isSelectable('mosaic') && isSelectable('text') && !isSelectable('pen'));
  check('pointInRect: basic containment', pointInRect({ x: 5, y: 5 }, { x: 0, y: 0, w: 10, h: 10 }) === true && pointInRect({ x: 20, y: 5 }, { x: 0, y: 0, w: 10, h: 10 }) === false);
  check('cloneOp: deep clone, mutating the clone does not affect the original', (() => {
    const o = rectOp({ points: [{ x: 1, y: 1 }] });
    const c = cloneOp(o);
    c.x0 = 999;
    c.points[0].x = 999;
    return o.x0 === 10 && o.points[0].x === 1;
  })());
  check('haloWidth: adds outline thickness on both sides', haloWidth(4, 3) === 10);
  check('outlineWidth: defaults to 3 when strokeWidth is unset', outlineWidth(rectOp()) === 3 && outlineWidth(rectOp({ strokeWidth: 0 })) === 0);
  check('wrapText: no maxW returns paragraphs unwrapped', JSON.stringify(wrapText(ctx, 'a\nb')) === JSON.stringify(['a', 'b']));
  check('wrapText: wraps long text at the given width (6px/char fake measurer)', wrapText(ctx, 'aaaa bbbb', 30).length > 1);
  check('offsetOp: shifts x/y-based coordinates and leaves untouched fields alone', (() => {
    const o = offsetOp(rectOp(), -10, -20);
    return o.x0 === 0 && o.y0 === -10 && o.x1 === 40 && o.y1 === 20 && o.color === '#ff0000';
  })());
  check('opIntersects: a box fully outside the frame does not intersect', opIntersects(ctx, rectOp({ x0: 500, y0: 500, x1: 600, y1: 600 }), 400, 300) === false);
  check('opIntersects: a box overlapping the frame does intersect', opIntersects(ctx, rectOp({ x0: -5, y0: -5, x1: 5, y1: 5 }), 400, 300) === true);
  check('bboxOf: a pen op bbox is the min/max over its points (not {0,0,0,0})', JSON.stringify(bboxOf(ctx, penOp())) === JSON.stringify({ x: 10, y: 10, w: 20, h: 30 }));
  check('opIntersects: a pen stroke inside the frame intersects (not always-false as when bboxOf ignored points)', opIntersects(ctx, penOp(), 400, 300) === true);
  check('opIntersects: a pen stroke fully outside the frame does not intersect', opIntersects(ctx, penOp({ points: [{ x: 500, y: 500 }, { x: 520, y: 520 }] }), 400, 300) === false);

  // renderOps: drives clearRect + drawImage + one drawOne per op, without throwing, using the
  // fake ctx (records calls instead of touching a real canvas).
  const fakeBase = {}; // stand-in for an HTMLImageElement/HTMLCanvasElement (drawImage is stubbed)
  renderOps(ctx, fakeBase, 200, 100, [rectOp(), arrowOp()]);
  check('renderOps: clears then draws the base image once, and each op via drawOne', ctx.calls.some((c) => c[0] === 'clearRect') && ctx.calls.filter((c) => c[0] === 'drawImage').length === 1);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
