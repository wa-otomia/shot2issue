// Settings — the desktop analogue of the extension's options page, over core storage. Tabs:
//   Workspaces (issue targets + Types), Accounts (GitHub login + GitLab/YouTrack credentials),
//   AI (connect/manage + prompts/reasoning/vocab), General (capture hotkey recorder + title/body
//   templates + language).
//
// Config is edited as a draft (useState) and persisted with an explicit Save (setConfig),
// mirroring options.ts. The capture hotkey and AI connect/sign-out are immediate actions (they
// touch the Rust backend / token store), not draft fields.

import { useEffect, useRef, useState } from "react";
import {
  accountFor,
  getAiAuth,
  getConfig,
  getOptionsTab,
  getProvider,
  makeAccountId,
  makeId,
  migrateAccounts,
  setConfig as persistConfig,
  setLanguage,
  setOptionsTab,
  t as tr,
  type AiAuth,
  type Config,
  type Workspace,
} from "@shot2issue/core";
import { getDefaultAccelerator, getHotkey, setCaptureHotkey } from "../lib/api";
import AccountsPanel from "../settings/AccountsPanel";
import WorkspacesPanel from "../settings/WorkspacesPanel";
import AiPanel from "../settings/AiPanel";

type Tab = "workspaces" | "accounts" | "ai" | "general";

// Build a tauri-plugin-global-shortcut accelerator string ("CommandOrControl+Shift+2") from a
// keydown event. Returns null until a non-modifier key is pressed.
// Map a PHYSICAL key (e.code) to a tauri accelerator token. Using e.code — not
// e.key — means Shift doesn't turn a digit into a symbol (Shift+1 → "!", which
// is an invalid accelerator). tauri accepts short tokens: A, 2, Up, F1, ",".
function tokenFromCode(code: string): string | null {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3); // KeyA -> A
  if (/^Digit[0-9]$/.test(code)) return code.slice(5); // Digit2 -> 2
  if (/^F[1-9][0-9]?$/.test(code)) return code; // F1..F24
  const named: Record<string, string> = {
    ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right",
    Space: "Space", Enter: "Enter", Tab: "Tab", Backspace: "Backspace",
    Minus: "-", Equal: "=", Comma: ",", Period: ".", Slash: "/",
    Semicolon: ";", Quote: "'", BracketLeft: "[", BracketRight: "]",
    Backslash: "\\", Backquote: "`",
  };
  return named[code] ?? null;
}

// Build a tauri accelerator ("CommandOrControl+Shift+1") from a keydown event.
// Returns null when the press shouldn't be recorded yet: a modifier-only key, a
// chord with no primary modifier (Cmd/Ctrl/Alt), or an unsupported physical key.
function accelFromEvent(e: KeyboardEvent): string | null {
  if (["Control", "Meta", "Alt", "Shift"].includes(e.key)) return null; // modifier-only
  if (!(e.metaKey || e.ctrlKey || e.altKey)) return null; // needs a primary modifier
  const token = tokenFromCode(e.code);
  if (!token) return null; // unsupported physical key — wait for a valid chord
  const parts: string[] = [];
  if (e.metaKey || e.ctrlKey) parts.push("CommandOrControl");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
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
  const [saveErr, setSaveErr] = useState("");
  const importInputRef = useRef<HTMLInputElement>(null);

  // Persist the active tab (mirrors the extension's getOptionsTab/setOptionsTab).
  const selectTab = (name: Tab): void => {
    setTab(name);
    void setOptionsTab(name);
  };

  // Hotkey recorder (immediate, not part of the draft).
  const [hotkey, setHotkey] = useState("");
  const [recording, setRecording] = useState(false);
  const [hotkeyErr, setHotkeyErr] = useState("");
  const [hotkeyErrDetail, setHotkeyErrDetail] = useState("");

  useEffect(() => {
    getConfig().then(setDraft).catch(() => {});
    getAiAuth().then(setAuth).catch(() => {});
    getHotkey().then(setHotkey).catch(() => {});
    // Restore the last-used Settings tab (persisted across sessions, mirroring options.ts).
    getOptionsTab()
      .then((name) => {
        if (name === "workspaces" || name === "accounts" || name === "ai" || name === "general") {
          setTab(name);
        }
      })
      .catch(() => {});
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
    setSaveErr("");
  };

  // Validate + normalize the draft before persisting, mirroring the extension's options.ts
  // save(). Blocks on incomplete accounts, invalid workspaces, or zero types; repairs the
  // remembered lastWorkspaceId/lastType; and switches to the offending tab on error.
  const save = async (): Promise<void> => {
    if (!config) return;
    setSaveErr("");

    // 1) Normalize + validate accounts: every account-field the provider requires must be filled.
    const accounts = config.accounts.map((a) => ({
      ...a,
      id: a.id || makeAccountId(),
      name: (a.name || "").trim(),
      baseUrl: (a.baseUrl || "").trim().replace(/\/+$/, ""),
      token: (a.token || "").trim(),
    }));
    for (const a of accounts) {
      const fields = getProvider(a.kind).accountFields || [];
      const rec = a as unknown as Record<string, string>;
      if (fields.some((f) => !((rec[f.key] || "").trim()))) {
        selectTab("accounts");
        setSaveErr(t("errAccountIncomplete"));
        return;
      }
    }

    // 2) Normalize workspaces to the fields relevant to their provider.
    const workspaces: Workspace[] = config.workspaces.map((w) => {
      const provider = getProvider(w.kind);
      return { id: w.id || makeId(), kind: provider.id, name: (w.name || "").trim(), ...provider.normalize(w) };
    });

    const draft: Config = { ...config, accounts, workspaces };

    // 3) Validate each workspace against its merged shape (account creds overlaid).
    for (const w of workspaces) {
      const acct = accountFor(draft, w);
      const merged = acct ? { ...w, baseUrl: acct.baseUrl, token: acct.token } : w;
      const errKey = getProvider(w.kind).validate(merged);
      if (errKey) {
        selectTab("workspaces");
        setSaveErr(t(errKey));
        return;
      }
    }

    // 4) At least one issue type must remain.
    if (draft.types.length < 1) {
      selectTab("workspaces");
      setSaveErr(t("errKeepOneType"));
      return;
    }

    // 5) Repair the remembered selections if they point at nothing.
    if (!workspaces.some((w) => w.id === draft.lastWorkspaceId)) {
      draft.lastWorkspaceId = workspaces[0]?.id || "";
    }
    if (!draft.types.includes(draft.lastType)) draft.lastType = draft.types[0] || "";

    setLanguage(draft.lang);
    await persistConfig(draft);
    setDraft(draft); // reflect normalized data back into the editor
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  // ---- Backup / restore (mirrors options.ts) ----
  const exportConfig = (): void => {
    if (!config) return;
    const blob = new Blob([JSON.stringify(config, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const stamp = new Date(Date.now()).toISOString().slice(0, 19).replace(/[:T]/g, "-");
    a.href = url;
    a.download = `shot2issue-config-${stamp}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setSaveErr("");
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  const importConfig = async (file: File): Promise<void> => {
    if (!config) return;
    try {
      const obj = JSON.parse(await file.text()) as Partial<Config>;
      if (typeof obj !== "object" || obj === null) throw new Error(t("importInvalid"));
      // Preserve all workspace fields (accountId/project/owner/repo, any legacy inline
      // baseUrl/token) so migrateAccounts can convert old backups losslessly.
      const imported: Config = {
        workspaces: (Array.isArray(obj.workspaces) ? obj.workspaces : []).map((w) => ({
          ...w,
          id: w.id || makeId(),
          kind: getProvider(w.kind || "github").id,
          name: w.name || "",
        })),
        accounts: Array.isArray(obj.accounts) ? obj.accounts : [],
        types: Array.isArray(obj.types) && obj.types.length ? obj.types : config.types,
        lang: typeof obj.lang === "string" ? obj.lang : config.lang,
        titleTemplate: typeof obj.titleTemplate === "string" ? obj.titleTemplate : config.titleTemplate,
        bodyTemplate: typeof obj.bodyTemplate === "string" ? obj.bodyTemplate : config.bodyTemplate,
        aiTitlePrompt: typeof obj.aiTitlePrompt === "string" ? obj.aiTitlePrompt : config.aiTitlePrompt,
        aiComplaintPrompt: typeof obj.aiComplaintPrompt === "string" ? obj.aiComplaintPrompt : config.aiComplaintPrompt,
        aiVocabulary: Array.isArray(obj.aiVocabulary) ? obj.aiVocabulary : config.aiVocabulary,
        aiReasoning: typeof obj.aiReasoning === "string" ? obj.aiReasoning : config.aiReasoning,
        autoDictate: typeof obj.autoDictate === "boolean" ? obj.autoDictate : config.autoDictate,
        dictationLang: typeof obj.dictationLang === "string" ? obj.dictationLang : config.dictationLang,
        closeAfterSubmit: typeof obj.closeAfterSubmit === "boolean" ? obj.closeAfterSubmit : config.closeAfterSubmit,
        shortcutEnabled: typeof obj.shortcutEnabled === "boolean" ? obj.shortcutEnabled : config.shortcutEnabled,
        lastWorkspaceId: typeof obj.lastWorkspaceId === "string" ? obj.lastWorkspaceId : "",
        lastType: typeof obj.lastType === "string" ? obj.lastType : "",
      };
      const migrated = migrateAccounts(imported); // convert legacy inline-cred workspaces to accounts
      setLanguage(migrated.lang);
      await persistConfig(migrated);
      setDraft(migrated); // reload the draft from the imported config
      setSaveErr("");
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    } catch (e) {
      setSaveErr(t("importFailed", [e instanceof Error ? e.message : String(e)]));
    }
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
          <button key={tb.id} className={`s2i-tab${tab === tb.id ? " active" : ""}`} onClick={() => selectTab(tb.id)}>
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

          <div className="card">
            <h3>{t("backupHeading")}</h3>
            <p className="empty" style={{ textAlign: "left", padding: 0 }}>{t("backupHint")}</p>
            <div className="row" style={{ gap: 8 }}>
              <button onClick={exportConfig}>{t("exportConfig")}</button>
              <button onClick={() => importInputRef.current?.click()}>{t("importConfig")}</button>
              <input
                ref={importInputRef}
                type="file"
                accept="application/json,.json"
                style={{ display: "none" }}
                onChange={(e) => {
                  const file = e.target.files && e.target.files[0];
                  e.target.value = ""; // allow re-importing the same file
                  if (file) void importConfig(file);
                }}
              />
            </div>
          </div>
        </>
      )}

      <div className="s2i-save-bar">
        <button className="primary" onClick={() => void save()}>
          {t("save")}
        </button>
        {saved && <span className="s2i-set-ok">{t("saved")}</span>}
        {saveErr && <span className="s2i-set-error" role="alert">{saveErr}</span>}
      </div>
    </>
  );
}
