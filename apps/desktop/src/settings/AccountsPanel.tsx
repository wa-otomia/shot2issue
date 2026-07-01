// Settings → Accounts: ONE unified account list. GitHub accounts (github.com web
// session, added by signing in) sit in the SAME list as the token-based providers
// (GitLab / YouTrack) — no separate GitHub section. Workspaces bind to an account
// by id. Token-account edits live in the draft Config (via onConfig); GitHub
// sign-in/out are immediate (they touch the Rust cookie store) and refresh in place.

import { useEffect, useState } from "react";
import {
  accountKinds,
  getProvider,
  makeAccountId,
  type Account,
  type Config,
  type ProviderField,
} from "@shot2issue/core";
import { githubAccounts, githubLogin, githubLogout, type GithubAccount } from "../providers/github";

export default function AccountsPanel({
  t,
  config,
  onConfig,
}: {
  t: (k: string) => string;
  config: Config;
  onConfig: (patch: Partial<Config>) => void;
}) {
  const [ghAccounts, setGhAccounts] = useState<GithubAccount[]>([]);
  const [ghBusy, setGhBusy] = useState(false);

  const refreshGh = (): void => {
    githubAccounts().then(setGhAccounts).catch(() => {});
  };
  useEffect(refreshGh, []);

  const addGitHub = async (): Promise<void> => {
    setGhBusy(true);
    try {
      await githubLogin(); // opens the login webview; upserts the signed-in account by login
      refreshGh();
    } catch {
      /* user closed the webview, or no cookie captured */
    } finally {
      setGhBusy(false);
    }
  };
  const signOutGitHub = async (id: string): Promise<void> => {
    await githubLogout(id);
    refreshGh();
  };

  const kinds = accountKinds(); // token-based providers (gitlab, youtrack)
  const accounts = config.accounts;

  const patchAccount = (id: string, patch: Partial<Account>): void => {
    onConfig({ accounts: accounts.map((a) => (a.id === id ? { ...a, ...patch } : a)) });
  };
  const addAccount = (): void => {
    const kind = kinds[0] || "gitlab";
    const acct: Account = { id: makeAccountId(), kind, name: "", baseUrl: "", token: "" };
    onConfig({ accounts: [...accounts, acct] });
  };
  const removeAccount = (id: string): void => {
    onConfig({ accounts: accounts.filter((a) => a.id !== id) });
  };

  const empty = ghAccounts.length === 0 && accounts.length === 0;

  return (
    <div className="card">
      <h3>{t("accountsHeading")}</h3>
      <p className="empty" style={{ textAlign: "left", padding: 0 }}>{t("accountsHint")}</p>
      {empty && <p className="empty">{t("noAccounts")}</p>}

      {/* GitHub accounts (cookie sessions) — same list as the token accounts below. */}
      {ghAccounts.map((a) => (
        <div key={`gh-${a.id}`} className="s2i-set-card">
          <div className="row">
            <span className="s2i-k">GitHub</span>
            <span style={{ flex: 1 }}>{a.login}</span>
            <button className="danger" title={t("ghSignOut")} onClick={() => void signOutGitHub(a.id)}>
              ✕
            </button>
          </div>
        </div>
      ))}

      {/* Token-based accounts (GitLab / YouTrack). */}
      {accounts.map((a) => {
        const provider = getProvider(a.kind);
        const fields = provider.accountFields ?? [];
        return (
          <div key={a.id} className="s2i-set-card">
            <div className="row">
              <input
                type="text"
                placeholder={t("accountNamePlaceholder")}
                value={a.name}
                style={{ flex: 1 }}
                onChange={(e) => patchAccount(a.id, { name: e.target.value })}
              />
              <select value={a.kind} onChange={(e) => patchAccount(a.id, { kind: e.target.value })} style={{ maxWidth: 160 }}>
                {kinds.map((k) => (
                  <option key={k} value={k}>
                    {getProvider(k).label}
                  </option>
                ))}
              </select>
              <button className="danger" title={t("accountRemove")} onClick={() => removeAccount(a.id)}>
                ✕
              </button>
            </div>
            <div className="s2i-set-grid">
              {fields.map((f: ProviderField) => (
                <div key={f.key} className={f.full ? "s2i-set-full field" : "field"}>
                  <label>{t(f.labelKey)}</label>
                  <input
                    type={f.type === "password" ? "password" : "text"}
                    placeholder={f.placeholderKey ? t(f.placeholderKey) : f.placeholder}
                    value={(a as unknown as Record<string, string>)[f.key] || ""}
                    onChange={(e) => patchAccount(a.id, { [f.key]: e.target.value } as Partial<Account>)}
                  />
                </div>
              ))}
            </div>
          </div>
        );
      })}

      <div className="row">
        <button disabled={ghBusy} onClick={() => void addGitHub()}>
          {ghBusy ? t("aiConnecting") : t("ghAddAccount")}
        </button>
        <button onClick={addAccount}>{t("addAccount")}</button>
      </div>
    </div>
  );
}
