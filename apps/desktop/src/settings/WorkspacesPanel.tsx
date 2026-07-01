// Settings → Workspaces panel: add / edit / remove issue targets. Each workspace binds to a
// provider kind; GitHub workspaces have owner/repo fields, account-based ones (GitLab/YouTrack)
// pick an Account + project. Also hosts the Types editor (the editor's Type dropdown + default
// title suffix). Edits live in the draft Config (via onConfig); SettingsView persists on Save.

import { useEffect, useState } from "react";
import {
  getProvider,
  isAccountBased,
  makeId,
  PROVIDER_LIST,
  type Config,
  type ProviderField,
  type Workspace,
} from "@shot2issue/core";
import { githubAccounts, type GithubAccount } from "../providers/github";

export default function WorkspacesPanel({
  t,
  config,
  onConfig,
}: {
  t: (k: string) => string;
  config: Config;
  onConfig: (patch: Partial<Config>) => void;
}) {
  const [newType, setNewType] = useState("");
  const [ghAccounts, setGhAccounts] = useState<GithubAccount[]>([]);
  useEffect(() => {
    githubAccounts().then(setGhAccounts).catch(() => {});
  }, []);
  const workspaces = config.workspaces;

  const patchWs = (id: string, patch: Partial<Workspace>): void => {
    onConfig({ workspaces: workspaces.map((w) => (w.id === id ? ({ ...w, ...patch } as Workspace) : w)) });
  };
  const addWs = (): void => {
    const kind = PROVIDER_LIST[0]?.id || "github";
    onConfig({ workspaces: [...workspaces, { id: makeId(), kind, name: "" } as Workspace] });
  };
  const removeWs = (id: string): void => {
    onConfig({ workspaces: workspaces.filter((w) => w.id !== id) });
  };

  const addType = (): void => {
    const ty = newType.trim();
    if (!ty || config.types.includes(ty)) {
      setNewType("");
      return;
    }
    onConfig({ types: [...config.types, ty] });
    setNewType("");
  };
  const removeType = (ty: string): void => {
    if (config.types.length <= 1) return; // keep at least one
    onConfig({ types: config.types.filter((x) => x !== ty) });
  };

  return (
    <div className="card">
      <h3>{t("workspacesHeading")}</h3>
      <p className="empty" style={{ textAlign: "left", padding: 0 }}>{t("workspacesHint")}</p>
      {workspaces.length === 0 && <p className="empty">{t("noWorkspaces")}</p>}
      {workspaces.map((w) => {
        const kind = w.kind || "github";
        const provider = getProvider(kind);
        const accountBased = isAccountBased(provider);
        const acctsForKind = config.accounts.filter((a) => a.kind === kind);
        return (
          <div key={w.id} className="s2i-set-card">
            <div className="row">
              <input
                type="text"
                placeholder={t("wsNamePlaceholder")}
                value={w.name}
                style={{ flex: 1 }}
                onChange={(e) => patchWs(w.id, { name: e.target.value })}
              />
              <select value={kind} onChange={(e) => patchWs(w.id, { kind: e.target.value })} style={{ maxWidth: 160 }}>
                {PROVIDER_LIST.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
              <button className="danger" title={t("wsRemove")} onClick={() => removeWs(w.id)}>
                ✕
              </button>
            </div>
            <div className="s2i-set-grid">
              {/* GitHub (and any non-account provider): the per-workspace fields. */}
              {provider.fields.map((f: ProviderField) => (
                <div key={f.key} className={f.full ? "s2i-set-full field" : "field"}>
                  <label>{t(f.labelKey)}</label>
                  <input
                    type={f.type === "password" ? "password" : "text"}
                    placeholder={f.placeholderKey ? t(f.placeholderKey) : f.placeholder}
                    value={(w as Record<string, string>)[f.key] || ""}
                    onChange={(e) => patchWs(w.id, { [f.key]: e.target.value } as Partial<Workspace>)}
                  />
                </div>
              ))}
              {/* GitHub: bind the workspace to a signed-in GitHub account (multi-account). */}
              {kind === "github" && (
                <div className="field">
                  <label>{t("wsGithubAccount")}</label>
                  <select
                    value={(w as Record<string, string>).githubAccountId || ""}
                    onChange={(e) => patchWs(w.id, { githubAccountId: e.target.value } as Partial<Workspace>)}
                  >
                    <option value="">{t("accountNone")}</option>
                    {ghAccounts.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.login}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              {/* Account-based: pick an account + the project field. */}
              {accountBased && (
                <div className="field">
                  <label>{t("wsAccount")}</label>
                  <select value={(w as Record<string, string>).accountId || ""} onChange={(e) => patchWs(w.id, { accountId: e.target.value })}>
                    <option value="">{t("accountNone")}</option>
                    {acctsForKind.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name || a.baseUrl}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              {accountBased && provider.projectField && (
                <div className="field">
                  <label>{t(provider.projectField.labelKey)}</label>
                  <input
                    type="text"
                    placeholder={provider.projectField.placeholderKey ? t(provider.projectField.placeholderKey) : provider.projectField.placeholder}
                    value={(w as Record<string, string>)[provider.projectField.key] || ""}
                    onChange={(e) => provider.projectField && patchWs(w.id, { [provider.projectField.key]: e.target.value } as Partial<Workspace>)}
                  />
                </div>
              )}
            </div>
          </div>
        );
      })}
      <div className="row">
        <button onClick={addWs}>{t("addWorkspace")}</button>
      </div>

      <h3 style={{ marginTop: "1.25rem" }}>{t("typesHeading")}</h3>
      <p className="empty" style={{ textAlign: "left", padding: 0 }}>{t("typesHint")}</p>
      <div className="s2i-chips">
        {config.types.map((ty) => (
          <span key={ty} className="s2i-chip">
            {ty}
            <button onClick={() => removeType(ty)}>✕</button>
          </span>
        ))}
      </div>
      <div className="row">
        <input
          type="text"
          value={newType}
          placeholder={t("newTypePlaceholder")}
          style={{ maxWidth: 240 }}
          onChange={(e) => setNewType(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && addType()}
        />
        <button onClick={addType}>{t("addType")}</button>
      </div>
    </div>
  );
}
