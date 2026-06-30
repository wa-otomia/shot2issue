import { useMemo } from "react";

// The signature brand motif — dotted texture + curve cluster — rendered as a
// non-interactive SVG layer. Mirrors the formula used by the app icon and the
// card sticker so surfaces like About / Updater carry the same identity.

const DOT_COLS = 22;
const DOT_ROWS = 22;

interface Dot {
  x: number;
  y: number;
  r: number;
  bright: boolean;
  o: number;
}

function buildDots(): Dot[] {
  const dots: Dot[] = [];
  for (let row = 0; row < DOT_ROWS; row++) {
    for (let col = 0; col < DOT_COLS; col++) {
      const x = ((col + 0.5) / DOT_COLS) * 100;
      const y = ((row + 0.5) / DOT_ROWS) * 100;
      const wave = Math.sin(x * 0.12 + y * 0.16 - 1.2);
      const band = Math.cos((x - y) * 0.07);
      const a = Math.max(0, Math.min(1, (wave * 0.5 + 0.5) * (band * 0.4 + 0.6))) * 0.5;
      if (a < 0.05) continue;
      dots.push({ x, y, r: 0.25 + a * 0.6, bright: a > 0.32, o: a });
    }
  }
  return dots;
}

/**
 * Fills its nearest positioned ancestor. Give the parent `position:
 * relative` and put real content at a higher `zIndex`.
 */
export default function BrandBackdrop({ opacity = 1 }: { opacity?: number }) {
  const dots = useMemo(buildDots, []);
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 100 100"
      preserveAspectRatio="xMidYMid slice"
      style={{
        position: "absolute",
        inset: 0,
        width: "100%",
        height: "100%",
        pointerEvents: "none",
        opacity,
        zIndex: 0,
      }}
    >
      <defs>
        <linearGradient id="bb-wave" x1="0" y1="0" x2="1" y2="0.3">
          <stop offset="0" stopColor="#36c5ff" stopOpacity="0" />
          <stop offset=".5" stopColor="#3f8bff" stopOpacity=".9" />
          <stop offset="1" stopColor="#1b4fd6" stopOpacity="0" />
        </linearGradient>
      </defs>
      <g
        fill="none"
        stroke="url(#bb-wave)"
        strokeLinecap="round"
        transform="rotate(-14 50 60)"
      >
        <path d="M-20 40 C 20 20, 60 64, 130 30" strokeWidth=".55" opacity=".9" />
        <path d="M-20 48 C 20 28, 60 72, 130 38" strokeWidth=".5" opacity=".75" />
        <path d="M-20 56 C 20 36, 60 80, 130 46" strokeWidth=".5" opacity=".6" />
        <path d="M-20 64 C 20 44, 60 88, 130 54" strokeWidth=".45" opacity=".48" />
        <path d="M-20 72 C 20 52, 60 96, 130 62" strokeWidth=".45" opacity=".36" />
        <path d="M-20 80 C 20 60, 60 104, 130 70" strokeWidth=".4" opacity=".26" />
        <path d="M-20 88 C 20 68, 60 112, 130 78" strokeWidth=".4" opacity=".18" />
      </g>
      {dots.map((d, i) => (
        <circle
          key={i}
          cx={d.x}
          cy={d.y}
          r={d.r}
          fill={d.bright ? "#46c8ff" : "#3a6fd8"}
          opacity={d.o}
        />
      ))}
    </svg>
  );
}
