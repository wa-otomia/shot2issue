import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import OverlayWindow from "./views/OverlayWindow";
import EditorView from "./editor/EditorView";
import UpdaterWindow from "./views/UpdaterWindow";
import AboutWindow from "./views/AboutWindow";
import { initCore, setLanguage, getConfig } from "@shot2issue/core";
import { makePlatform } from "./lib/platform";
import { registerAllProviders } from "./providers";
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
      return <EditorView />; // annotation editor (reads staged shots on mount)
    case "updater":
      return <UpdaterWindow />;
    case "about":
      return <AboutWindow />;
    default:
      return <App />;
  }
}

// Inject the platform adapters into @shot2issue/core, set the UI language from the persisted
// config, and register the issue providers — all BEFORE the first render so every view (storage
// reads, the editor's provider list, AI connect) sees a fully wired core. A platform/store
// failure must not leave a blank window, so we fall back to rendering with core's defaults.
async function bootstrap(): Promise<void> {
  try {
    initCore(await makePlatform());
    registerAllProviders();
    const config = await getConfig();
    setLanguage(config.lang);
  } catch (e) {
    // Storage/platform not ready (or a non-Tauri preview): render anyway with defaults.
    console.error("core bootstrap failed; rendering with defaults", e);
  }
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <Root />
    </React.StrictMode>,
  );
}

void bootstrap();
