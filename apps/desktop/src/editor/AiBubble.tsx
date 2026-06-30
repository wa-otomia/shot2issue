// The floating AI status bubble, ported from the extension. It points at an anchor element
// (the title field, the description textarea, or the voice-input button) and shows the current
// streaming status plus the live reasoning ("thinking") text. Positioning runs in an effect on
// every render and on window resize/scroll, matching the extension's positionBubble.

import { useEffect, useRef } from "react";

export type BubblePhase = "busy" | "done" | "error";

export interface BubbleState {
  visible: boolean;
  phase: BubblePhase;
  status: string;
  think: string;
  /** The element the bubble's arrow points at. */
  anchor: HTMLElement | null;
}

export const EMPTY_BUBBLE: BubbleState = {
  visible: false,
  phase: "busy",
  status: "",
  think: "",
  anchor: null,
};

export default function AiBubble({ state }: { state: BubbleState }) {
  const ref = useRef<HTMLDivElement>(null);
  const thinkRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || !state.visible || !state.anchor) return;
    const position = (): void => {
      const anchor = state.anchor;
      if (!anchor) return;
      const r = anchor.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return; // anchor hidden — keep last position
      const b = el.getBoundingClientRect();
      const gap = 10;
      let top: number;
      let pointDown: boolean;
      if (r.top - b.height - gap >= 8) {
        top = r.top - b.height - gap;
        pointDown = true; // bubble above → arrow on its bottom edge
      } else {
        top = r.bottom + gap;
        pointDown = false;
      }
      let left = r.left + r.width / 2 - b.width / 2;
      left = Math.max(8, Math.min(left, window.innerWidth - b.width - 8));
      el.style.left = `${left}px`;
      el.style.top = `${top}px`;
      el.classList.toggle("point-down", pointDown);
      el.classList.toggle("point-up", !pointDown);
      el.style.setProperty("--arrow-x", `${r.left + r.width / 2 - left}px`);
    };
    position();
    // Re-position when the think text grows (it changes the bubble height).
    if (thinkRef.current) thinkRef.current.scrollTop = thinkRef.current.scrollHeight;
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    return () => {
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", position, true);
    };
  });

  if (!state.visible) return null;
  const cls = `s2i-ai-bubble${state.phase === "done" ? " done" : ""}${state.phase === "error" ? " error" : ""}`;
  return (
    <div className={cls} ref={ref}>
      <div className="s2i-ai-bubble-head">
        <span className="s2i-ai-bubble-dot" />
        <span className="s2i-ai-bubble-status">{state.status}</span>
        <span className="s2i-ai-bubble-check">✓</span>
      </div>
      {state.think && (
        <div className="s2i-ai-bubble-think" ref={thinkRef}>
          {state.think}
        </div>
      )}
    </div>
  );
}
