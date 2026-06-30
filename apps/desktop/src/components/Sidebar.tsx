export type View = "home" | "settings" | "annotate" | "about";

const NAV: { id: View; label: string }[] = [
  { id: "home", label: "Home" },
  { id: "settings", label: "Settings" },
  { id: "about", label: "About" },
];

export default function Sidebar({
  current,
  onSelect,
}: {
  current: View;
  onSelect: (v: View) => void;
}) {
  return (
    <nav className="sidebar">
      <div className="brand">
        {/* Reuse the C-curve mark (brandBg cyan->blue gradient) as the
            shot2issue logo so the apps share one identity family. */}
        <svg width="34" height="34" viewBox="0 0 120 120" className="brand-logo">
          <defs>
            <linearGradient id="brandBg" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stopColor="#36c5ff" />
              <stop offset="1" stopColor="#1b4fd6" />
            </linearGradient>
          </defs>
          <path
            d="M 86.87 33.13 A 38 38 0 1 0 86.87 86.87"
            fill="none"
            stroke="url(#brandBg)"
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
        <span className="brand-name">shot2issue</span>
      </div>

      <div className="sidebar-nav">
        {NAV.map((item) => (
          <button
            key={item.id}
            className={`nav-item ${current === item.id ? "active" : ""}`}
            onClick={() => onSelect(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>

      {/* .sidebar-waves SVG copied verbatim from curvault (sideWaveGrad). */}
      <svg
        className="sidebar-waves"
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <defs>
          <linearGradient id="sideWaveGrad" x1="0" y1="0" x2="1" y2="0.3">
            <stop offset="0" stopColor="#36c5ff" stopOpacity="0" />
            <stop offset=".5" stopColor="#3f8bff" stopOpacity=".9" />
            <stop offset="1" stopColor="#1b4fd6" stopOpacity="0" />
          </linearGradient>
        </defs>
        <g
          fill="none"
          stroke="url(#sideWaveGrad)"
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
      </svg>
    </nav>
  );
}
