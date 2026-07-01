// Settings — the desktop analogue of the extension's options page, over core storage. Tabs:
//   Workspaces (issue targets + Types), Accounts (GitHub login + GitLab/YouTrack credentials),
//   AI (connect/manage + prompts/reasoning/vocab), General (capture hotkey recorder + title/body
//   templates + language).
//
// Config is edited as a draft (useState) and persisted with an explicit Save (setConfig),
// mirroring options.ts. The capture hotkey and AI connect/sign-out are immediate actions (they
// touch the Rust backend / token store), not draft fields.

import { useEffect, useState } from "react";
import {
  getAiAuth,
  getConfig,
  setConfig as persistConfig,
  setLanguage,
  t as tr,
  type AiAuth,
  type Config,
} from "@shot2issue/core";
import { getDefaultAccelerator, getHotkey, setCaptureHotkey } from "../lib/api";
import AccountsPanel from "../settings/AccountsPanel";
import WorkspacesPanel from "../settings/WorkspacesPanel";
import AiPanel from "../settings/AiPanel";

type Tab = "workspaces" | "accounts" | "ai" | "general";

// Build a tauri-plugin-global-shortcut accelerator string ("CommandOrControl+Shift+2") from a
// keydown event. Returns null until a non-modifier key is pressed.
function accelFromEvent(e: KeyboardEvent): string | null {
  const key = e.key;
  if (["Control", "Meta", "Alt", "Shift"].includes(key)) return null; // modifier-only
  // A global chord needs a primary modifier (Cmd/Ctrl/Alt). A bare letter — or
  // Shift+letter — would grab that key globally and the backend rejects it.
  // Escape/Tab/Enter are handled as controls in onKey and never reach here.
  if (!(e.metaKey || e.ctrlKey || e.altKey)) return null;
  const parts: string[] = [];
  if (e.metaKey || e.ctrlKey) parts.push("CommandOrControl");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  let token = key.length === 1 ? key.toUpperCase() : key;
  if (key === " ") token = "Space";
  parts.push(token);
  return parts.join("+");
}

// OS-reserved capture chords we reject up front with a friendly message instead
// of letting backend registration fail: macOS Cmd+Shift+3/4/5/6 (screenshot /
// recording), Windows Win+Shift+S (Snip).
function isSystemReserved(e: KeyboardEvent): boolean {
  const mac = navigator.platform.toUpperCase().includes("MAC");
  const k = e.key.toLowerCase();
  if (mac && e.metaKey && e.shiftKey && ["3", "4", "5", "6"].includes(k)) return true;
  if (!mac && e.metaKey && e.shiftKey && k === "s") return true;
  return false;
}

export default function SettingsView() {
  const t = tr;
  const [tab, setTab] = useState<Tab>("workspaces");
  const [config, setDraft] = useState<Config | null>(null);
  const [auth, setAuth] = useState<AiAuth | null>(null);
  const [saved, setSaved] = useState(false);

  // Hotkey recorder (immediate, not part of the draft).
  const [hotkey, setHotkey] = useState("");
  const [recording, setRecording] = useState(false);
  const [hotkeyErr, setHotkeyErr] = useState("");
  const [hotkeyErrDetail, setHotkeyErrDetail] = useState("");

  useEffect(() => {
    getConfig().then(setDraft).catch(() => {});
    getAiAuth().then(setAuth).catch(() => {});
    getHotkey().then(setHotkey).catch(() => {});
  }, []);

  useEffect(() => {
    if (!recording) return;
    const onKey = async (e: KeyboardEvent): Promise<void> => {
      // Escape cancels recording without recording a shortcut (fixes the pill
      // showing "Escape"). Tab/Enter are navigation keys — ignore, never record.
      if (e.key === "Escape") {
        e.preventDefault();
        setRecording(false);
        setHotkeyErr("");
        setHotkeyErrDetail("");
        return;
      }
      if (e.key === "Tab" || e.key === "Enter") return;
      e.preventDefault();
      if (isSystemReserved(e)) {
        setRecording(false);
        setHotkeyErr(t("hotkeyReservedSystem"));
        setHotkeyErrDetail("");
        return;
      }
      const accel = accelFromEvent(e);
      if (!accel) return; // modifier-only or lone key — wait for a valid chord
      setRecording(false);
      try {
        await setCaptureHotkey(accel);
        setHotkey(accel);
        setHotkeyErr("");
        setHotkeyErrDetail("");
      } catch (err) {
        // invoke() rejects with the serialized ServiceError STRING. Keep the
        // friendly hint AND the raw reason so a first-real-run failure (parse /
        // chord-in-use / Wayland / macOS refusal) stays diagnosable.
        const raw = String(err);
        console.error("setCaptureHotkey failed:", accel, raw);
        setHotkeyErr(t("hotkeyRegisterFailed"));
        setHotkeyErrDetail(raw);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [recording]);

  const resetHotkey = async (): Promise<void> => {
    setHotkeyErr("");
    setHotkeyErrDetail("");
    setRecording(false);
    try {
      const def = await getDefaultAccelerator();
      await setCaptureHotkey(def);
      setHotkey(def);
    } catch (err) {
      const raw = String(err);
      console.error("resetHotkey failed:", raw);
      setHotkeyErr(t("hotkeyRegisterFailed"));
      setHotkeyErrDetail(raw);
    }
  };

  const onConfig = (patch: Partial<Config>): void => {
    setDraft((c) => (c ? { ...c, ...patch } : c));
    setSaved(false);
  };

  const save = async (): Promise<void> => {
    if (!config) return;
    setLanguage(config.lang);
    await persistConfig(config);
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  if (!config) return <div className="card"><p className="empty">…</p></div>;

  const TABS: Array<{ id: Tab; label: string }> = [
    { id: "workspaces", label: t("tabWorkspaces") },
    { id: "accounts", label: t("tabAccounts") },
    { id: "ai", label: t("tabAi") },
    { id: "general", label: t("tabGeneral") },
  ];

  return (
    <>
      <h2>{t("settings")}</h2>
      <div className="s2i-tabs">
        {TABS.map((tb) => (
          <button key={tb.id} className={`s2i-tab${tab === tb.id ? " active" : ""}`} onClick={() => setTab(tb.id)}>
            {tb.label}
          </button>
        ))}
      </div>

      {tab === "workspaces" && <WorkspacesPanel t={t} config={config} onConfig={onConfig} />}
      {tab === "accounts" && <AccountsPanel t={t} config={config} onConfig={onConfig} />}
      {tab === "ai" && <AiPanel t={t} config={config} auth={auth} onConfig={onConfig} onAuth={setAuth} />}

      {tab === "general" && (
        <>
          <div className="card">
            <h3>{t("shortcutHeading")}</h3>
            <div className="field">
              <label>{t("hotkeyLabel")}</label>
              <div className="row" style={{ gap: 8 }}>
                <button
                  className={`hotkey-pill${recording ? " recording" : ""}`}
                  onClick={() => {
                    setHotkeyErr("");
                    setHotkeyErrDetail("");
                    setRecording((r) => !r);
                  }}
                >
                  {recording ? t("hotkeyRecording") : hotkey || t("hotkeyNotSet")}
                </button>
                <button onClick={() => void resetHotkey()}>{t("hotkeyReset")}</button>
              </div>
              {hotkeyErr && (
                <div className="s2i-set-error">
                  <p style={{ margin: 0 }}>{hotkeyErr}</p>
                  {hotkeyErrDetail && (
                    <details style={{ marginTop: 4 }}>
                      <summary style={{ cursor: "pointer", opacity: 0.8 }}>{t("hotkeyErrorDetails")}</summary>
                      <code style={{ display: "block", marginTop: 4, whiteSpace: "pre-wrap", opacity: 0.85 }}>
                        {hotkeyErrDetail}
                      </code>
                    </details>
                  )}
                </div>
              )}
            </div>
          </div>

          <div className="card">
            <h3>{t("templatesHeading")}</h3>
            <p className="empty" style={{ textAlign: "left", padding: 0 }}>{t("templatesHint")}</p>
            <div className="field">
              <label>{t("titleTemplateLabel")}</label>
              <input type="text" value={config.titleTemplate} onChange={(e) => onConfig({ titleTemplate: e.target.value })} />
            </div>
            <div className="field">
              <label>{t("bodyTemplateLabel")}</label>
              <textarea rows={3} value={config.bodyTemplate} onChange={(e) => onConfig({ bodyTemplate: e.target.value })} />
            </div>
          </div>

          <div className="card">
            <h3>{t("languageHeading")}</h3>
            <p className="empty" style={{ textAlign: "left", padding: 0 }}>{t("languageHint")}</p>
            <select value={config.lang} style={{ maxWidth: 240 }} onChange={(e) => onConfig({ lang: e.target.value })}>
              <option value="en">English</option>
              <option value="zh">中文（简体）</option>
              <option value="ja">日本語</option>
            </select>
          </div>
        </>
      )}

      <div className="s2i-save-bar">
        <button className="primary" onClick={() => void save()}>
          {t("save")}
        </button>
        {saved && <span className="s2i-set-ok">{t("saved")}</span>}
      </div>
    </>
  );
}
