// Settings → Accounts: ONE unified account list. GitHub accounts (github.com web
// session, added by signing in) sit in the SAME list as the token-based providers
// (GitLab / YouTrack) and are added from the SAME "Add account" flow: pick the GitHub
// kind, type a name, then Sign in. Workspaces bind to an account by id. All account
// edits (name/kind/token) live in the draft Config (via onConfig); a GitHub sign-in/out
// is immediate (it touches the Rust cookie store) and refreshes the signed-in list in place.

import { useEffect, useRef, useState } from "react";
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
  const [ghBusyId, setGhBusyId] = useState<string | null>(null);

  const kinds = accountKinds(); // account kinds: github (cookie) + gitlab / youtrack (token)
  const accounts = config.accounts;

  // Tracks the LATEST config/accounts every render, so async handlers that await a
  // long-running operation (OAuth webview, logout) can build their post-await patch from
  // ref.current instead of the render-time closure — avoiding clobbering edits made while
  // the await was in flight.
  const configRef = useRef(config);
  configRef.current = config;

  const patchAccount = (id: string, patch: Partial<Account>): void => {
    onConfig({ accounts: accounts.map((a) => (a.id === id ? { ...a, ...patch } : a)) });
  };
  const addAccount = (): void => {
    const kind = kinds[0] || "github";
    const acct: Account = { id: makeAccountId(), kind, name: "", baseUrl: "", token: "" };
    onConfig({ accounts: [...accounts, acct] });
  };
  const removeAccount = (id: string): void => {
    onConfig({
      accounts: accounts.filter((a) => a.id !== id),
      workspaces: config.workspaces.map((w) => (w.accountId === id ? { ...w, accountId: "" } : w)),
    });
  };

  const refreshGh = (): void => {
    githubAccounts().then(setGhAccounts).catch(() => {});
  };

  // On load: refresh the signed-in list AND backfill config.accounts from it. This is a
  // desktop-only migration for existing users whose GitHub sessions live only in the Rust
  // store (no config.accounts entry yet). Migrated ids == login, so any workspace bound by
  // githubAccountId (== login) still resolves. Kept out of shared core (Tauri-free).
  useEffect(() => {
    githubAccounts()
      .then((list) => {
        setGhAccounts(list);
        // The list() await can span a re-render, so build the patch from the LATEST
        // config (via ref), not the render-time `accounts` closure, to avoid clobbering
        // edits made while it was in flight.
        const latest = configRef.current.accounts;
        const known = new Set(latest.map((a) => a.id));
        const missing = list.filter((g) => !known.has(g.id));
        if (missing.length) {
          const added: Account[] = missing.map((g) => ({
            id: g.id,
            kind: "github",
            name: g.login,
            baseUrl: "",
            token: "",
          }));
          onConfig({ accounts: [...latest, ...added] });
        }
      })
      .catch(() => {});
    // Run once per mount; the config snapshot at mount is the migration baseline.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Sign in (or re-sign-in) a GitHub account by id; on success adopt the resolved login as the
  // display name when the user hasn't set one, and refresh the signed-in list.
  const signInGitHub = async (id: string): Promise<void> => {
    setGhBusyId(id);
    try {
      const acct = await githubLogin(id); // opens the login webview; upserts the session by id
      // The webview flow can run for many seconds — read the LATEST accounts via the ref
      // (not the render-time `accounts` closure) so edits made while it was open aren't lost.
      const latest = configRef.current.accounts;
      const current = latest.find((a) => a.id === id);
      if (current && !current.name.trim()) {
        onConfig({ accounts: latest.map((a) => (a.id === id ? { ...a, name: acct.login } : a)) });
      }
      refreshGh();
    } catch {
      /* user closed the webview, or no cookie captured */
    } finally {
      setGhBusyId(null);
    }
  };
  const removeGitHubAccount = async (id: string): Promise<void> => {
    // Drop the stored session (best-effort), the config entry, and unbind any workspace using it.
    await githubLogout(id).catch(() => {});
    refreshGh();
    // Build the patch from the LATEST config (via ref), not the render-time closure, so any
    // edits made while the logout awaited aren't clobbered.
    const latest = configRef.current;
    onConfig({
      accounts: latest.accounts.filter((a) => a.id !== id),
      workspaces: latest.workspaces.map((w) =>
        (w as { githubAccountId?: string }).githubAccountId === id ? { ...w, githubAccountId: "" } : w,
      ),
    });
  };

  const empty = accounts.length === 0;

  return (
    <div className="card">
      <h3>{t("accountsHeading")}</h3>
      <p className="empty" style={{ textAlign: "left", padding: 0 }}>{t("accountsHint")}</p>
      {empty && <p className="empty">{t("noAccounts")}</p>}

      {accounts.map((a) => {
        const provider = getProvider(a.kind);
        // GitHub (and any cookieAuth kind): a Sign-in button + signed-in state, NO token fields.
        if (provider.cookieAuth) {
          const gh = ghAccounts.find((g) => g.id === a.id);
          const busy = ghBusyId === a.id;
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
                <button className="danger" title={t("accountRemove")} onClick={() => void removeGitHubAccount(a.id)}>
                  ✕
                </button>
              </div>
              <div className="row">
                {gh ? (
                  <>
                    <span style={{ flex: 1 }}>{t("loginSignedInAs").replace("{0}", gh.login)}</span>
                    <button disabled={busy} onClick={() => void signInGitHub(a.id)}>
                      {busy ? t("aiConnecting") : t("ghReSignIn")}
                    </button>
                  </>
                ) : (
                  <button disabled={busy} onClick={() => void signInGitHub(a.id)}>
                    {busy ? t("aiConnecting") : t("ghSignIn")}
                  </button>
                )}
              </div>
            </div>
          );
        }

        // Token-based accounts (GitLab / YouTrack): name + kind + credential fields.
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
        <button onClick={addAccount}>{t("addAccount")}</button>
      </div>
    </div>
  );
}
