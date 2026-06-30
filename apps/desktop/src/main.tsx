import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import OverlayWindow from "./views/OverlayWindow";
import EditorWindow from "./views/EditorWindow";
import UpdaterWindow from "./views/UpdaterWindow";
import AboutWindow from "./views/AboutWindow";
import "./index.css";
import "./overlay.css";

// One bundle serves every window; each secondary window renders its own
// standalone UI keyed by window label (no IPC, no permission needed).
function currentLabel(): string {
  try {
    const internals = (
      window as unknown as {
        __TAURI_INTERNALS__?: {
          metadata?: { currentWindow?: { label?: string } };
        };
      }
    ).__TAURI_INTERNALS__;
    return internals?.metadata?.currentWindow?.label ?? "main";
  } catch {
    return "main";
  }
}

function Root() {
  switch (currentLabel()) {
    case "overlay":
      return <OverlayWindow />; // capture HUD (region/window pick)
    case "editor":
      return <EditorWindow />; // annotate stage (reads staged shots on mount)
    case "updater":
      return <UpdaterWindow />;
    case "about":
      return <AboutWindow />;
    default:
      return <App />;
  }
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
);
