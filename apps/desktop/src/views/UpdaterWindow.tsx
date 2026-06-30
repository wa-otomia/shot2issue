import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open as openExternal } from "@tauri-apps/plugin-shell";
import { check as checkUpdate, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import BrandBackdrop from "../components/BrandBackdrop";
import BrandLogo from "../components/BrandLogo";

const REPO_URL = "https://github.com/wa-otomia/shot2issue";

// Whole window is draggable (frameless); spread onto non-interactive nodes.
const DRAG = { "data-tauri-drag-region": true } as const;

type State =
  | { kind: "checking" }
  | { kind: "up-to-date"; current: string }
  | { kind: "available"; update: Update }
  | { kind: "downloading"; update: Update; received: number; total: number | null }
  | { kind: "ready"; version: string }
  | { kind: "error"; message: string };

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

export default function UpdaterWindow() {
  const [state, setState] = useState<State>({ kind: "checking" });
  const [version, setVersion] = useState("");
  const [closing, setClosing] = useState(false);

  // Frameless + transparent window: make the page background transparent so
  // the rounded panel's corners show through.
  useEffect(() => {
    document.documentElement.style.background = "transparent";
    document.body.style.background = "transparent";
  }, []);

  const runCheck = async () => {
    setState({ kind: "checking" });
    try {
      const v = await getVersion().catch(() => "");
      setVersion(v);
      const update = await checkUpdate();
      if (!update?.available) setState({ kind: "up-to-date", current: v || "?" });
      else setState({ kind: "available", update });
    } catch (e: unknown) {
      setState({ kind: "error", message: String(e) });
    }
  };

  useEffect(() => {
    runCheck();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onDownload = async () => {
    if (state.kind !== "available") return;
    const update = state.update;
    setState({ kind: "downloading", update, received: 0, total: null });
    try {
      let received = 0;
      let total: number | null = null;
      await update.downloadAndInstall((event) => {
        switch (event.event) {
          case "Started":
            total = event.data?.contentLength ?? null;
            setState({ kind: "downloading", update, received: 0, total });
            break;
          case "Progress":
            received += event.data.chunkLength;
            setState({ kind: "downloading", update, received, total });
            break;
          case "Finished":
            break;
        }
      });
      setState({ kind: "ready", version: update.version }); // manual restart
    } catch (e: unknown) {
      setState({ kind: "error", message: String(e) });
    }
  };

  const onRestart = async () => {
    try {
      await relaunch();
    } catch (e: unknown) {
      setState({ kind: "error", message: String(e) });
    }
  };
  // Play the dismiss animation, then actually close the window.
  const onClose = () => {
    setClosing(true);
    setTimeout(() => getCurrentWindow().close().catch(() => {}), 230);
  };

  return (
    <div className={`updater-root${closing ? " closing" : ""}`} {...DRAG}>
      <BrandBackdrop opacity={0.5} />

      <div className="updater-content" {...DRAG}>
        <div {...DRAG}>
          <BrandLogo size={84} />
        </div>
        <h1 className="updater-title" {...DRAG}>
          Software Update
        </h1>

        <div className="updater-stage" {...DRAG}>
          {/* keyed by kind so the fade replays on state changes only */}
          <div className="updater-panel updater-fade" key={state.kind} {...DRAG}>
            {renderPanel(state, { onDownload, onRestart, onClose, runCheck })}
          </div>
        </div>

        {version && (
          <div className="updater-version" {...DRAG}>
            shot2issue · v{version}
          </div>
        )}
      </div>
    </div>
  );
}

function renderPanel(
  state: State,
  actions: {
    onDownload: () => void;
    onRestart: () => void;
    onClose: () => void;
    runCheck: () => void;
  },
) {
  const DRAG = { "data-tauri-drag-region": true } as const;
  const noDrag = { onMouseDown: (e: React.MouseEvent) => e.stopPropagation() };

  switch (state.kind) {
    case "checking":
      return (
        <>
          <p className="updater-sub" {...DRAG}>
            Checking for updates…
          </p>
          <div className="updater-actions">
            <button {...noDrag} onClick={actions.onClose}>
              Close
            </button>
          </div>
        </>
      );

    case "up-to-date":
      return (
        <>
          <p className="updater-headline" {...DRAG}>
            You're up to date.
          </p>
          <p className="updater-sub" {...DRAG}>
            v{state.current} is the newest signed release.
          </p>
          <div className="updater-actions">
            <button {...noDrag} onClick={actions.runCheck}>
              Check again
            </button>
            <button className="primary" {...noDrag} onClick={actions.onClose}>
              Close
            </button>
          </div>
        </>
      );

    case "available":
      return (
        <>
          <p className="updater-headline" {...DRAG}>
            Update available · v{state.update.version}
          </p>
          <p className="updater-sub" {...DRAG}>
            You're on v{state.update.currentVersion}.
            {state.update.date &&
              ` Released ${new Date(state.update.date).toLocaleDateString()}.`}
          </p>
          {state.update.body && (
            <pre className="updater-notes">
              {state.update.body.slice(0, 1200)}
              {state.update.body.length > 1200 ? "\n…" : ""}
            </pre>
          )}
          <div className="updater-actions">
            <button className="primary" {...noDrag} onClick={actions.onDownload}>
              Download &amp; install
            </button>
            <button
              {...noDrag}
              onClick={() =>
                openExternal(
                  `${REPO_URL}/releases/tag/v${state.update.version}`,
                ).catch(() => {})
              }
            >
              Release notes
            </button>
            <button {...noDrag} onClick={actions.onClose}>
              Later
            </button>
          </div>
        </>
      );

    case "downloading": {
      const pct = state.total
        ? Math.min(100, (state.received / state.total) * 100)
        : null;
      return (
        <>
          <p className="updater-headline" {...DRAG}>
            Downloading v{state.update.version}…
          </p>
          <p className="updater-sub" {...DRAG}>
            {fmtBytes(state.received)}
            {state.total ? ` / ${fmtBytes(state.total)}` : ""}
          </p>
          <div className="updater-progress" {...DRAG}>
            {pct === null ? (
              <div className="updater-progress-indeterminate" />
            ) : (
              <div className="updater-progress-fill" style={{ width: `${pct}%` }} />
            )}
          </div>
          <div className="updater-actions">
            <button {...noDrag} onClick={actions.onClose}>
              Close
            </button>
          </div>
        </>
      );
    }

    case "ready":
      return (
        <>
          <p
            className="updater-headline"
            style={{ color: "var(--ok)" }}
            {...DRAG}
          >
            v{state.version} downloaded.
          </p>
          <p className="updater-sub" {...DRAG}>
            Restart shot2issue to finish updating. You can keep working and
            restart later.
          </p>
          <div className="updater-actions">
            <button className="primary" {...noDrag} onClick={actions.onRestart}>
              Restart now
            </button>
            <button {...noDrag} onClick={actions.onClose}>
              Later
            </button>
          </div>
        </>
      );

    case "error":
      return (
        <>
          <p
            className="updater-headline"
            style={{ color: "var(--error)" }}
            {...DRAG}
          >
            Update failed
          </p>
          <pre className="updater-notes">{state.message}</pre>
          <div className="updater-actions">
            <button {...noDrag} onClick={actions.runCheck}>
              Retry
            </button>
            <button className="primary" {...noDrag} onClick={actions.onClose}>
              Close
            </button>
          </div>
        </>
      );
  }
}
