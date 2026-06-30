// The C-curve mark. Same geometry as the app icon. Reused verbatim from
// curvault as the shot2issue identity mark (same brand family).
export default function BrandLogo({ size = 120 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 120 120" aria-hidden="true">
      <defs>
        <linearGradient id="brandLogoArc" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#36c5ff" />
          <stop offset="1" stopColor="#1b4fd6" />
        </linearGradient>
      </defs>
      <path
        d="M 86.87 33.13 A 38 38 0 1 0 86.87 86.87"
        fill="none"
        stroke="url(#brandLogoArc)"
        strokeWidth="9"
        strokeLinecap="round"
      />
      <path
        d="M 76.97 43.03 A 24 24 0 1 0 76.97 76.97"
        fill="none"
        stroke="#fff"
        strokeWidth="6"
        strokeLinecap="round"
        opacity=".9"
      />
      <circle cx="60" cy="60" r="6.5" fill="#fff" />
    </svg>
  );
}
