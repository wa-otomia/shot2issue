// A restrained brand backdrop for the About / Updater panels: a faint
// rule-of-thirds viewfinder grid that nods to the capture/framing idea.
// Flat, single brand-blue stroke at low opacity — no gradients, dots, or waves.
export default function BrandBackdrop({ opacity = 1 }: { opacity?: number }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
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
      <g stroke="#1f6feb" strokeOpacity="0.07" strokeWidth="0.4" fill="none">
        <line x1="33.3" y1="0" x2="33.3" y2="100" />
        <line x1="66.6" y1="0" x2="66.6" y2="100" />
        <line x1="0" y1="33.3" x2="100" y2="33.3" />
        <line x1="0" y1="66.6" x2="100" y2="66.6" />
      </g>
    </svg>
  );
}
