// The right-hand issue form: workspace + type selects, title + description, the AI assistant row
// (model / reasoning / Summarize-title / Smart-dictation), the submit buttons, and the
// status/result line. Presentation + field wiring only — EditorView owns all state and the AI /
// submit flows and passes them down. Refs to the title input and body textarea are forwarded so
// the AI bubble can anchor to them and streaming can write into them live.

import type { RefObject } from "react";
import type { IssueResult, Workspace } from "@shot2issue/core";

export interface FormState {
  workspaceId: string;
  type: string;
  title: string;
  body: string;
}

export default function IssueForm({
  t,
  workspaces,
  types,
  wsLabel,
  form,
  onForm,
  titleRef,
  bodyRef,
  loginHint,
  loginOk,
  aiConnected,
  models,
  model,
  reasoning,
  autoDictate,
  titleBusy,
  complaintBusy,
  aiLocked,
  submitting,
  status,
  statusKind,
  result,
  onModel,
  onReasoning,
  onAutoDictate,
  onSummarize,
  onDictate,
  onSubmit,
  onOpenIssue,
}: {
  t: (k: string, subs?: string | number | Array<string | number>) => string;
  workspaces: Workspace[];
  types: string[];
  wsLabel: (ws: Workspace) => string;
  form: FormState;
  onForm: (patch: Partial<FormState>) => void;
  titleRef: RefObject<HTMLInputElement>;
  bodyRef: RefObject<HTMLTextAreaElement>;
  loginHint: string;
  loginOk: boolean;
  aiConnected: boolean;
  models: string[];
  model: string;
  reasoning: string;
  autoDictate: boolean;
  titleBusy: boolean;
  complaintBusy: boolean;
  aiLocked: boolean;
  submitting: boolean;
  status: string;
  statusKind: "info" | "error" | "ok";
  result: IssueResult | null;
  onModel: (m: string) => void;
  onReasoning: (r: string) => void;
  onAutoDictate: (v: boolean) => void;
  onSummarize: () => void;
  onDictate: () => void;
  onSubmit: (withImage: boolean) => void;
  onOpenIssue: (url: string) => void;
}) {
  return (
    <div className="s2i-form-col">
      <label>{t("fieldWorkspace")}</label>
      <select
        value={form.workspaceId}
        disabled={aiLocked}
        onChange={(e) => onForm({ workspaceId: e.target.value })}
      >
        {workspaces.length === 0 && <option value="">{t("statusNeedWorkspace")}</option>}
        {workspaces.map((ws) => (
          <option key={ws.id} value={ws.id}>
            {wsLabel(ws)}
          </option>
        ))}
      </select>
      {loginHint && (
        <p className="s2i-login-hint" style={{ color: loginOk ? "var(--text-dim)" : "var(--error)" }}>
          {loginHint}
        </p>
      )}

      <label>{t("fieldType")}</label>
      <select value={form.type} disabled={aiLocked} onChange={(e) => onForm({ type: e.target.value })}>
        {types.map((ty) => (
          <option key={ty} value={ty}>
            {ty}
          </option>
        ))}
      </select>

      <label>{t("fieldTitle")}</label>
      <input
        ref={titleRef}
        type="text"
        value={form.title}
        placeholder={t("titlePlaceholder")}
        onChange={(e) => onForm({ title: e.target.value })}
      />

      <label>
        {t("fieldBody")} <span className="s2i-hint">{t("bodyHint")}</span>
      </label>
      <textarea
        ref={bodyRef}
        className="s2i-body"
        value={form.body}
        placeholder={t("bodyPlaceholder")}
        onChange={(e) => onForm({ body: e.target.value })}
      />

      <div className="s2i-ai-head">{t("aiActionsHeading")}</div>
      <div className="s2i-ai-actions">
        {aiConnected && models.length > 0 && (
          <div className="s2i-ai-row">
            <select className="s2i-ai-model" value={model} disabled={aiLocked} onChange={(e) => onModel(e.target.value)}>
              {models.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
            <select className="s2i-ai-reasoning" value={reasoning} disabled={aiLocked} onChange={(e) => onReasoning(e.target.value)}>
              <option value="off">{t("aiReasoningOff")}</option>
              <option value="low">{t("aiReasoningLow")}</option>
              <option value="medium">{t("aiReasoningMedium")}</option>
              <option value="high">{t("aiReasoningHigh")}</option>
            </select>
          </div>
        )}
        <div className="s2i-ai-row">
          <button
            className={`ghost${titleBusy ? " ai-busy" : ""}`}
            disabled={!aiConnected || (aiLocked && !titleBusy)}
            title={aiConnected ? t("aiTitleTitle") : t("aiTitleNeedConnect")}
            onClick={onSummarize}
          >
            {titleBusy ? t("aiStop") : t("aiTitle")}
          </button>
          <button
            className={`primary${complaintBusy ? " ai-busy" : ""}`}
            disabled={!aiConnected || (aiLocked && !complaintBusy)}
            title={aiConnected ? t("complaintTitle") : t("aiTitleNeedConnect")}
            onClick={onDictate}
          >
            {complaintBusy ? t("aiStop") : t("complaint")}
          </button>
          <label className="s2i-auto-dictate">
            <input type="checkbox" checked={autoDictate} onChange={(e) => onAutoDictate(e.target.checked)} />
            <span>{t("autoDictate")}</span>
          </label>
        </div>
      </div>

      <div className="s2i-actions">
        <button className="primary" disabled={submitting || aiLocked} onClick={() => onSubmit(true)}>
          {t("submit")}
        </button>
        <button className="ghost" disabled={submitting || aiLocked} title={t("submitNoImageTitle")} onClick={() => onSubmit(false)}>
          {t("submitNoImage")}
        </button>
      </div>

      {status && (
        <div className={`s2i-status ${statusKind}`}>
          {submitting && <span className="s2i-spin" />}
          {status}
        </div>
      )}
      {result && (
        <div className="s2i-result">
          <a href={result.url} target="_blank" rel="noreferrer">
            {result.url}
          </a>
          <button className="primary" style={{ marginLeft: 10 }} onClick={() => onOpenIssue(result.url)}>
            {t("openIssue")}
          </button>
        </div>
      )}
    </div>
  );
}
