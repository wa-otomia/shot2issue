import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open as openExternal } from "@tauri-apps/plugin-shell";
import BrandBackdrop from "../components/BrandBackdrop";
import BrandLogo from "../components/BrandLogo";

const REPO_URL = "https://github.com/wa-otomia/shot2issue";
const DRAG = { "data-tauri-drag-region": true } as const;

export default function AboutWindow() {
  const [version, setVersion] = useState("");
  const [closing, setClosing] = useState(false);

  useEffect(() => {
    document.documentElement.style.background = "transparent";
    document.body.style.background = "transparent";
    getVersion()
      .then(setVersion)
      .catch(() => {});
  }, []);

  const close = () => {
    setClosing(true);
    setTimeout(() => getCurrentWindow().close().catch(() => {}), 230);
  };

  return (
    <div className={`updater-root${closing ? " closing" : ""}`} {...DRAG}>
      <BrandBackdrop opacity={0.5} />
      <div className="updater-content about-content" {...DRAG}>
        <BrandLogo size={84} />
        <h1 className="updater-title" {...DRAG}>
          shot2issue
        </h1>
        <p className="updater-sub" {...DRAG}>
          Capture, annotate, and file screenshots as issues.
        </p>
        <div className="about-meta">
          <span>
            <b>Version</b> v{version}
          </span>
          <span>
            <b>License</b> MIT
          </span>
        </div>
        <div className="updater-actions">
          <button
            onMouseDown={(e) => e.stopPropagation()}
            onClick={() => openExternal(REPO_URL).catch(() => {})}
          >
            Project page
          </button>
          <button
            className="primary"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={close}
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
