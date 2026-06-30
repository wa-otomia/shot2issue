// The shot2issue camera mark — same geometry as the app icon
// (src-tauri/icon-src/icon.svg): a GitHub-blue rounded square with a white
// camera. Flat, no gradients, so it matches the chrome.
export default function BrandLogo({ size = 120 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 1024 1024" aria-hidden="true">
      <rect x="80" y="80" width="864" height="864" rx="208" fill="#1f6feb" />
      <g fill="#ffffff">
        <rect x="408" y="298" width="208" height="126" rx="34" />
        <rect x="200" y="368" width="624" height="452" rx="76" />
      </g>
      <circle cx="512" cy="596" r="132" fill="#1f6feb" />
      <circle cx="512" cy="596" r="86" fill="#ffffff" />
      <circle cx="512" cy="596" r="46" fill="#1f6feb" />
    </svg>
  );
}
