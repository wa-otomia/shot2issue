// Settings → AI panel: connect the OpenAI Codex / ChatGPT assistant (core ai.connect, which
// drives the Rust 127.0.0.1:1455 loopback + the system browser), show the connected account /
// plan / model / usage, and edit the title + dictation prompts, reasoning effort, dictation
// language, and the voice-input vocabulary. Live-persisted via the patchConfig prop (prompts /
// reasoning / vocab) and ai.* (model / sign-out).

import { useState } from "react";
import { ai, clearAiAuth, patchAiAuth, setAiAuth, DICTATION_LANGS, type AiAuth, type Config } from "@shot2issue/core";

export default function AiPanel({
  t,
  config,
  auth,
  onConfig,
  onAuth,
}: {
  t: (k: string, subs?: string | number | Array<string | number>) => string;
  config: Config;
  auth: AiAuth | null;
  onConfig: (patch: Partial<Config>) => void;
  onAuth: (a: AiAuth | null) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ text: string; kind: "ok" | "error" | "info" }>({ text: "", kind: "info" });
  const [newVocab, setNewVocab] = useState("");

  const connect = async (): Promise<void> => {
    setBusy(true);
    setStatus({ text: t("aiConnecting"), kind: "info" });
    try {
      const a = await ai.connect();
      onAuth(a);
      setStatus({ text: t("aiConnectedOk", [a.email || a.accountId || ""]), kind: "ok" });
    } catch (e) {
      setStatus({ text: t("aiConnectFailed", [e instanceof Error ? e.message : String(e)]), kind: "error" });
    } finally {
      setBusy(false);
    }
  };

  const signOut = async (): Promise<void> => {
    await clearAiAuth().catch(() => {});
    onAuth(null);
    setStatus({ text: t("aiSignedOut"), kind: "info" });
  };

  const refresh = async (): Promise<void> => {
    if (!auth) return;
    setBusy(true);
    try {
      const models = await ai.fetchModels(auth);
      const next = { ...auth, models, model: auth.model && models.includes(auth.model) ? auth.model : models[0] };
      await setAiAuth(next);
      onAuth(next);
      setStatus({ text: t("aiRefreshed"), kind: "ok" });
    } finally {
      setBusy(false);
    }
  };

  const addVocab = (): void => {
    const term = newVocab.trim();
    if (!term || config.aiVocabulary.includes(term)) {
      setNewVocab("");
      return;
    }
    onConfig({ aiVocabulary: [...config.aiVocabulary, term] });
    setNewVocab("");
  };

  return (
    <div className="card">
      <h3>{t("aiHeading")}</h3>
      <p className="empty" style={{ textAlign: "left", padding: 0 }}>{t("aiHint")}</p>

      {!auth ? (
        <div className="row">
          <button className="primary" disabled={busy} onClick={() => void connect()}>
            {busy ? t("aiConnecting") : t("aiConnect")}
          </button>
        </div>
      ) : (
        <div className="s2i-ai-connected">
          <div className="row"><span className="s2i-k">{t("aiAccount")}</span> <span>{auth.email || auth.accountId || ""}</span></div>
          <div className="row"><span className="s2i-k">{t("aiPlan")}</span> <span>{auth.planType || "—"}</span></div>
          <div className="row">
            <span className="s2i-k">{t("aiModel")}</span>
            <select
              value={auth.model || (auth.models ?? [])[0] || ""}
              onChange={(e) => {
                const next = { ...auth, model: e.target.value };
                onAuth(next);
                void patchAiAuth({ model: e.target.value });
              }}
            >
              {(auth.models ?? []).map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </div>
          <div className="row">
            <span className="s2i-k">{t("aiUsage")}</span>
            <span>
              {auth.quota?.primaryUsedPercent != null
                ? `${t("aiUsage5h")}: ${auth.quota.primaryUsedPercent}% · ${t("aiUsageWeek")}: ${auth.quota.secondaryUsedPercent ?? 0}%`
                : t("aiUsageUnknown")}
            </span>
          </div>
          <div className="row" style={{ marginTop: 10 }}>
            <button disabled={busy} onClick={() => void refresh()}>{t("aiRefresh")}</button>
            <button className="danger" onClick={() => void signOut()}>{t("aiSignOut")}</button>
          </div>
        </div>
      )}
      {status.text && (
        <p className={status.kind === "error" ? "s2i-set-error" : status.kind === "ok" ? "s2i-set-ok" : "empty"} style={{ textAlign: "left", padding: "6px 0" }}>
          {status.text}
        </p>
      )}

      <div className="field">
        <label>{t("aiReasoningLabel")}</label>
        <select value={config.aiReasoning || "off"} onChange={(e) => onConfig({ aiReasoning: e.target.value })} style={{ maxWidth: 200 }}>
          <option value="off">{t("aiReasoningOff")}</option>
          <option value="low">{t("aiReasoningLow")}</option>
          <option value="medium">{t("aiReasoningMedium")}</option>
          <option value="high">{t("aiReasoningHigh")}</option>
        </select>
      </div>

      <div className="field">
        <label>{t("dictationLangLabel")}</label>
        <select value={config.dictationLang || "auto"} onChange={(e) => onConfig({ dictationLang: e.target.value })} style={{ maxWidth: 240 }}>
          {DICTATION_LANGS.map(([code, name]) => (
            <option key={code} value={code}>
              {code === "auto" ? t("dictationAuto") : `${name} (${code})`}
            </option>
          ))}
        </select>
      </div>

      <div className="field">
        <label>{t("aiPromptLabel")}</label>
        <p className="s2i-hint">{t("aiPromptHint")}</p>
        <textarea
          rows={4}
          value={config.aiTitlePrompt}
          placeholder={t("aiTitlePromptDefault")}
          onChange={(e) => onConfig({ aiTitlePrompt: e.target.value })}
        />
        <div className="row" style={{ marginTop: 6 }}>
          <button onClick={() => onConfig({ aiTitlePrompt: "" })}>{t("aiPromptRestore")}</button>
        </div>
      </div>

      <div className="field">
        <label>{t("aiComplaintPromptLabel")}</label>
        <textarea
          rows={4}
          value={config.aiComplaintPrompt}
          placeholder={t("aiComplaintPromptDefault")}
          onChange={(e) => onConfig({ aiComplaintPrompt: e.target.value })}
        />
        <div className="row" style={{ marginTop: 6 }}>
          <button onClick={() => onConfig({ aiComplaintPrompt: "" })}>{t("aiPromptRestore")}</button>
        </div>
      </div>

      <div className="field">
        <label>{t("aiVocabHeading")}</label>
        <p className="s2i-hint">{t("aiVocabHint")}</p>
        <div className="s2i-chips">
          {config.aiVocabulary.map((term) => (
            <span key={term} className="s2i-chip">
              {term}
              <button onClick={() => onConfig({ aiVocabulary: config.aiVocabulary.filter((x) => x !== term) })}>✕</button>
            </span>
          ))}
        </div>
        <div className="row">
          <input
            type="text"
            value={newVocab}
            placeholder={t("aiVocabPlaceholder")}
            style={{ maxWidth: 260 }}
            onChange={(e) => setNewVocab(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addVocab()}
          />
          <button onClick={addVocab}>{t("addType")}</button>
        </div>
      </div>
    </div>
  );
}
