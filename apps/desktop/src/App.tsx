import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { exit } from "@tauri-apps/plugin-process";
import Sidebar, { type View } from "./components/Sidebar";
import StatusBar from "./components/StatusBar";
import HomeView from "./views/HomeView"; // shows hotkey + 'Capture now' button
import SettingsView from "./views/SettingsView"; // accounts, hotkey, capture mode, AI (Phase 4)
import AnnotateView from "./views/AnnotateView"; // hosts the reused canvas editor (Phase 4)
import { openAboutWindow } from "./lib/api";
import type { CaptureResult } from "./lib/api";

export default function App() {
  const [view, setView] = useState<View>("home");
  const [shot, setShot] = useState<CaptureResult | null>(null);

  const onSelect = (v: View) => {
    if (v === "about") openAboutWindow().catch(() => {});
    else setView(v);
  };

  // Rust emits this after the HUD finishes a crop (or after a Wayland
  // capture-then-crop). Carries the PNG data URL + source geometry.
  useEffect(() => {
    const un = listen<CaptureResult>("capture://annotate", (e) => {
      setShot(e.payload);
      setView("annotate");
    });
    return () => {
      un.then((f) => f());
    };
  }, []);

  // Match curvault: hold the main-window close in Rust, animate <body>, exit.
  useEffect(() => {
    const un = listen("app://close", () => {
      document.body.classList.add("app-closing");
      setTimeout(() => {
        exit(0).catch(() => {});
      }, 230);
    });
    return () => {
      un.then((f) => f());
    };
  }, []);

  return (
    <>
      <div className="titlebar" data-tauri-drag-region></div>
      <div className="app-body">
        <Sidebar current={view} onSelect={onSelect} />
        <div className="main-frame">
          <div className="content">
            {view === "home" && (
              <HomeView
                onCaptureDone={(s) => {
                  setShot(s);
                  setView("annotate");
                }}
              />
            )}
            {view === "settings" && <SettingsView />}
            {view === "annotate" && (
              <AnnotateView
                shot={shot}
                onDone={() => {
                  setShot(null);
                  setView("home");
                }}
              />
            )}
          </div>
          <StatusBar />
        </div>
      </div>
    </>
  );
}
