import { useState } from "react";
import Sidebar, { type View } from "./components/Sidebar";
import StatusBar from "./components/StatusBar";
import HomeView from "./views/HomeView"; // shows hotkey + 'Capture now' button
import SettingsView from "./views/SettingsView"; // accounts, hotkey, capture mode, AI (Phase 4)
import AnnotateView from "./views/AnnotateView"; // hosts the reused canvas editor (Phase 4)
import { openAboutWindow } from "./lib/api";

export default function App() {
  const [view, setView] = useState<View>("home");

  const onSelect = (v: View) => {
    if (v === "about") openAboutWindow().catch(() => {});
    else setView(v);
  };

  // The capture flow is window-based: a hotkey/button capture opens the
  // overlay, and a confirmed crop opens the dedicated `editor` window (see
  // services/editor_stage.rs). The main window no longer hosts the captured
  // shot, so there's no in-app capture->annotate listener here.

  return (
    <>
      <div className="titlebar" data-tauri-drag-region></div>
      <div className="app-body">
        <Sidebar current={view} onSelect={onSelect} />
        <div className="main-frame">
          <div className="content">
            {view === "home" && <HomeView />}
            {view === "settings" && <SettingsView />}
            {view === "annotate" && (
              <AnnotateView onDone={() => setView("home")} />
            )}
          </div>
          <StatusBar />
        </div>
      </div>
    </>
  );
}
