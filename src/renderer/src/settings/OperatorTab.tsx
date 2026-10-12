/**
 * Settings › Operator (ours; docs/multiplayer.md §17): shown only to the server's operators (`GET /me/usage`'s
 * `operator`). The spend guard (§17.1: the month's Cloudflare usage, the mode and thresholds, the server's storage cap),
 * who may sign up (Open / Invited people only / Closed, and the allowlist), and every account with its usage —
 * Suspend / Unsuspend, and Quota… to override one of its limits.
 */
import { useEffect, useState } from "react";
import { Button, Dialog, Select, Spinner, TextInput, showToast } from "@/ds";
import { ACCOUNT_QUOTA_KINDS, QUOTA_LABEL, QUOTA_LIMITS, SIGNUP_MODES, SIGNUP_MODE_LABEL, formatBytes, isByteQuota, type AccountQuotaKind, type AccountUsage, type OperatorAccount, type OperatorSettings, type SignupMode } from "@shared/quota";
import { SPEND_GUARD_MODES, SPEND_GUARD_MODE_LABEL, formatSpend, type SpendGuardMode, type SpendGuardStatus } from "@shared/spendGuard";
import { useAccount } from "../files/account";
import { Divider, Link, Section } from "./AccountTab";
import { accountCall } from "./bridge";
import styles from "./Settings.module.css";
import own from "./OperatorTab.module.css";

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const MB = 1024 * 1024;

/** Whether the signed-in account operates the server (asked once per account) */
export function useIsOperator(): boolean {
  const userId = useAccount().state?.user?.id ?? null;
  const [answer, setAnswer] = useState<{ userId: string; operator: boolean } | null>(null);
  useEffect(() => {
    if (!userId) return;
    let live = true;
    accountCall<AccountUsage>("GET", "/me/usage").then(
      (u) => live && setAnswer({ userId, operator: u.operator === true }),
      () => live && setAnswer({ userId, operator: false }),
    );
    return () => {
      live = false;
    };
  }, [userId]);
  return !!userId && answer?.userId === userId && answer.operator;
}

export function OperatorTab() {
  return (
    <div className={styles.page} data-settings-operator="">
      <SpendGuard />
      <Divider />
      <Signup />
      <Divider />
      <Accounts />
    </div>
  );
}

/** "12 Oct, 14:05" */
const checkedText = (at: number) => new Date(at).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

function SpendGuard() {
  const [status, setStatus] = useState<SpendGuardStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [warn, setWarn] = useState("");
  const [guard, setGuard] = useState("");
  const [cap, setCap] = useState("");
  const show = (s: SpendGuardStatus) => {
    setStatus(s);
    setError(null);
    setWarn(String(s.warnPercent));
    setGuard(String(s.guardPercent));
    setCap(String(Math.round(s.serverStorageBytes / MB)));
  };
  const call = (method: "PATCH" | "POST", path: string, body?: Record<string, unknown>) => {
    setBusy(true);
    return accountCall<SpendGuardStatus>(method, path, body)
      .then(show, (e: unknown) => showToast({ kind: "error", message: errorText(e) }))
      .finally(() => setBusy(false));
  };
  useEffect(() => {
    accountCall<SpendGuardStatus>("GET", "/operator/spend-guard").then(show, (e: unknown) => setError(errorText(e)));
  }, []);
  const known = status?.usage.some((u) => u.used !== null) ?? false;
  const warnN = Number(warn);
  const guardN = Number(guard);
  const capN = Number(cap);
  const validThresholds = Number.isInteger(warnN) && Number.isInteger(guardN) && warnN >= 1 && guardN <= 100 && warnN <= guardN;
  const validCap = cap.trim() !== "" && Number.isInteger(capN) && capN >= 1;
  return (
    <Section heading="Spend guard" data-settings-section="spend-guard">
      <p className={styles.text}>Keeps the Cloudflare bill at the Workers Paid base. At the warning you get a notification; at the limit only operators can use the server until the 1st (UTC).</p>
      {error && <p className={styles.note}>{error}</p>}
      {!status && !error && <Spinner />}
      {status && (
        <>
          <p className={own.state} data-operator-guard-state={status.active ? "operator_only" : "normal"} data-active={status.active ? "" : undefined}>
            {status.active ? (status.reason === "forced" ? "Only operators can use the server (set by you)." : "Only operators can use the server: an included amount is used up.") : "Everyone can use the server."}
          </p>
          <div className={own.row}>
            <Select
              label="Spend guard"
              value={status.mode}
              options={SPEND_GUARD_MODES.map((m) => ({ value: m, label: SPEND_GUARD_MODE_LABEL[m] }))}
              onChange={(v) => void call("PATCH", "/operator/spend-guard", { mode: v as SpendGuardMode })}
              width={240}
              data-operator-guard-mode=""
            />
            <Button variant="secondary" loading={busy} onClick={() => void call("POST", "/operator/spend-guard/check")} data-operator-guard-check="">
              Check now
            </Button>
          </div>
          {known ? (
            <table className={own.table} data-operator-usage="">
              <thead>
                <tr>
                  <th>Metric</th>
                  <th>Used</th>
                  <th>Included</th>
                  <th>%</th>
                </tr>
              </thead>
              <tbody>
                {status.usage.map((u) => (
                  <tr key={u.metric} data-metric={u.metric} data-level={u.percent === null ? undefined : u.percent >= status.guardPercent ? "guard" : u.percent >= status.warnPercent ? "warn" : undefined}>
                    <td>{u.label}</td>
                    <td>{u.used === null ? "Unknown" : formatSpend(u.metric, u.used)}</td>
                    <td>{formatSpend(u.metric, u.included)}</td>
                    <td>{u.percent === null ? "–" : `${u.percent < 1 && u.percent > 0 ? "<1" : Math.floor(u.percent)}%`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className={styles.note} data-operator-usage-unknown="">
              Usage unknown{status.error ? `: ${status.error}` : ""}. The guard doesn’t enforce anything until it can read usage.
            </p>
          )}
          <p className={styles.note} data-operator-guard-checked="">
            {status.checkedAt ? `Last checked ${checkedText(status.checkedAt)}` : "Not checked yet"}
            {known && status.error ? ` · ${status.error}` : ""}
          </p>
          <h4 className={own.subheading}>Thresholds</h4>
          <div className={own.row}>
            <TextInput className={own.fill} label="Warn at (%)" value={warn} onChange={(v) => setWarn(v.replace(/[^\d]/g, ""))} variant="outlined" invalid={!validThresholds} data-operator-guard-warn="" />
            <TextInput className={own.fill} label="Only operators at (%)" value={guard} onChange={(v) => setGuard(v.replace(/[^\d]/g, ""))} variant="outlined" invalid={!validThresholds} data-operator-guard-limit="" />
            <Button variant="secondary" disabled={!validThresholds || busy} onClick={() => void call("PATCH", "/operator/spend-guard", { warnPercent: warnN, guardPercent: guardN })} data-operator-guard-save="">
              Save
            </Button>
          </div>
          <h4 className={own.subheading}>Server storage cap</h4>
          <p className={`${styles.text} ${styles.muted}`}>{`Every account’s stored files and previews together, in megabytes${status.serverStorageCustom ? "" : " (the default)"}. Workers Paid includes 1 GB of Durable Object storage.`}</p>
          <div className={own.row}>
            <TextInput className={own.fill} label="Storage cap (MB)" value={cap} onChange={(v) => setCap(v.replace(/[^\d]/g, ""))} variant="outlined" invalid={!validCap} data-operator-storage-cap="" />
            <Button variant="secondary" disabled={!validCap || busy} onClick={() => void call("PATCH", "/operator/spend-guard", { serverStorageBytes: capN * MB })} data-operator-storage-save="">
              Save
            </Button>
            {status.serverStorageCustom && (
              <Link tight onClick={() => void call("PATCH", "/operator/spend-guard", { serverStorageBytes: null })} data-operator-storage-reset="">
                Use default
              </Link>
            )}
          </div>
        </>
      )}
    </Section>
  );
}

function Signup() {
  const [settings, setSettings] = useState<OperatorSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const patch = (body: Record<string, unknown>) =>
    accountCall<OperatorSettings>("PATCH", "/operator/settings", body).then(
      (s) => {
        setSettings(s);
        setError(null);
        return true;
      },
      (e: unknown) => {
        showToast({ kind: "error", message: errorText(e) });
        return false;
      },
    );
  useEffect(() => {
    accountCall<OperatorSettings>("GET", "/operator/settings").then(setSettings, (e: unknown) => setError(errorText(e)));
  }, []);
  return (
    <Section heading="Sign-up" data-settings-section="signup">
      <p className={styles.text}>Who can create an account on this server. Existing accounts can always log in unless they are suspended.</p>
      {error && <p className={styles.note}>{error}</p>}
      {!settings && !error && <Spinner />}
      {settings && (
        <>
          <div className={own.row}>
            <Select
              label="Sign-up"
              value={settings.signupMode}
              options={SIGNUP_MODES.map((m) => ({ value: m, label: SIGNUP_MODE_LABEL[m] }))}
              onChange={(v) => void patch({ signupMode: v as SignupMode })}
              width={240}
              data-operator-signup-mode=""
            />
          </div>
          <p className={styles.note}>{`${settings.accounts} ${settings.accounts === 1 ? "account" : "accounts"} · ${formatBytes(settings.serverStorageBytes)} stored`}</p>
          <h4 className={own.subheading}>Allowlist</h4>
          <p className={`${styles.text} ${styles.muted}`}>With “{SIGNUP_MODE_LABEL.invite}”, these emails can sign up too, besides people invited to a file or an organization.</p>
          <div className={own.row}>
            <TextInput className={own.fill} label="Email" value={email} onChange={setEmail} placeholder="Email" variant="outlined" data-operator-allow-email="" />
            <Button
              variant="secondary"
              disabled={!email.trim()}
              onClick={() =>
                void patch({ allow: email.trim() }).then((ok) => {
                  if (ok) setEmail("");
                })
              }
              data-operator-allow=""
            >
              Allow
            </Button>
          </div>
          {settings.allowlist.length > 0 && (
            <ul className={own.list}>
              {settings.allowlist.map((e) => (
                <li key={e} className={own.listRow} data-operator-allowed={e}>
                  <span className={own.grow}>{e}</span>
                  <Link tight danger onClick={() => void patch({ disallow: e })}>
                    Remove
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </Section>
  );
}

function Accounts() {
  const [accounts, setAccounts] = useState<OperatorAccount[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [suspending, setSuspending] = useState<OperatorAccount | null>(null);
  const [quota, setQuota] = useState<OperatorAccount | null>(null);
  const load = (q: string, after: string | null) =>
    accountCall<{ accounts: OperatorAccount[]; cursor: string | null }>("GET", `/operator/accounts?text=${encodeURIComponent(q)}${after ? `&cursor=${after}` : ""}`).then(
      (r) => {
        setAccounts((prev) => (after && prev ? [...prev, ...r.accounts] : r.accounts));
        setCursor(r.cursor);
        setError(null);
      },
      (e: unknown) => setError(errorText(e)),
    );
  useEffect(() => {
    void load("", null);
  }, []);
  const replace = (a: OperatorAccount) => setAccounts((prev) => prev?.map((x) => (x.id === a.id ? a : x)) ?? null);
  const unsuspend = (a: OperatorAccount) =>
    accountCall<{ account: OperatorAccount }>("POST", `/operator/accounts/${a.id}/unsuspend`).then(
      (r) => replace(r.account),
      (e: unknown) => showToast({ kind: "error", message: errorText(e) }),
    );
  return (
    <Section heading="Accounts" data-settings-section="accounts">
      <div className={own.row}>
        <TextInput className={own.fill} label="Search accounts" value={text} onChange={setText} onCommit={(v) => void load(v, null)} placeholder="Search accounts" variant="outlined" data-operator-search="" />
        <Button variant="secondary" onClick={() => void load(text, null)}>
          Search
        </Button>
      </div>
      {error && <p className={styles.note}>{error}</p>}
      {!accounts && !error && <Spinner />}
      {accounts && (
        <ul className={own.list} data-operator-accounts="">
          {accounts.length === 0 && <li className={`${own.listRow} ${styles.muted}`}>No accounts</li>}
          {accounts.map((a) => (
            <li key={a.id} className={own.account} data-operator-account={a.id} data-suspended={a.suspendedAt !== null ? "" : undefined}>
              <span className={own.who}>
                <span className={own.ellipsis}>{a.name ? `${a.name} · ${a.email}` : a.email}</span>
                <span className={`${own.ellipsis} ${styles.muted}`}>
                  {`${a.sharedFiles} files · ${formatBytes(a.storageBytes)} · ${a.previews} previews · ${a.orgsCreated} orgs`}
                  {Object.keys(a.overrides).length > 0 ? " · custom limits" : ""}
                </span>
                {a.suspendedAt !== null && <span className={own.suspended}>{a.suspendedReason ? `Suspended: ${a.suspendedReason}` : "Suspended"}</span>}
              </span>
              <span className={own.actions}>
                <Link tight onClick={() => setQuota(a)} data-operator-quota="">
                  Quota…
                </Link>
                {a.operator ? (
                  <span className={styles.muted}>Operator</span>
                ) : a.suspendedAt !== null ? (
                  <Link tight onClick={() => void unsuspend(a)} data-operator-unsuspend="">
                    Unsuspend
                  </Link>
                ) : (
                  <Link tight danger onClick={() => setSuspending(a)} data-operator-suspend="">
                    Suspend
                  </Link>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
      {cursor && (
        <Link onClick={() => void load(text, cursor)} data-operator-more="">
          Show more
        </Link>
      )}
      {suspending && (
        <SuspendDialog
          account={suspending}
          onClose={() => setSuspending(null)}
          onDone={(a) => {
            replace(a);
            setSuspending(null);
          }}
        />
      )}
      {quota && (
        <QuotaDialog
          account={quota}
          onClose={() => setQuota(null)}
          onDone={(a) => {
            replace(a);
            setQuota(a);
          }}
        />
      )}
    </Section>
  );
}

function SuspendDialog({ account, onClose, onDone }: { account: OperatorAccount; onClose: () => void; onDone: (a: OperatorAccount) => void }) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const suspend = async () => {
    setBusy(true);
    try {
      onDone((await accountCall<{ account: OperatorAccount }>("POST", `/operator/accounts/${account.id}/suspend`, { reason: reason.trim() || undefined })).account);
    } catch (e) {
      showToast({ kind: "error", message: errorText(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      title="Suspend account"
      open
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="destructive" loading={busy} onClick={() => void suspend()} data-operator-suspend-confirm="">
            Suspend
          </Button>
        </>
      }
    >
      <div className={styles.form}>
        <p className={styles.text}>{`${account.email} will be logged out everywhere and can't log in or use the server until you unsuspend the account. Its files and previews stay, but aren't served.`}</p>
        <div className={styles.formRow}>
          <span className={styles.formLabel}>Reason (only you see it)</span>
          <TextInput label="Reason" value={reason} onChange={setReason} placeholder="Optional" variant="outlined" maxLength={500} />
        </div>
      </div>
    </Dialog>
  );
}

/** A limit as typed: megabytes for storage, a count otherwise */
const shown = (kind: AccountQuotaKind, n: number) => String(isByteQuota(kind) ? Math.round(n / MB) : n);

function QuotaDialog({ account, onClose, onDone }: { account: OperatorAccount; onClose: () => void; onDone: (a: OperatorAccount) => void }) {
  const [kind, setKind] = useState<AccountQuotaKind>("storage_bytes");
  const current = account.overrides[kind] ?? QUOTA_LIMITS[kind];
  const [value, setValue] = useState(() => shown("storage_bytes", account.overrides.storage_bytes ?? QUOTA_LIMITS.storage_bytes));
  const [busy, setBusy] = useState(false);
  const typed = Number(value);
  const valid = value.trim() !== "" && Number.isInteger(typed) && typed >= 0;
  const save = async (limit: number | null) => {
    setBusy(true);
    try {
      onDone((await accountCall<{ account: OperatorAccount }>("POST", `/operator/accounts/${account.id}/quota`, { kind, limit })).account);
      showToast({ kind: "success", message: limit === null ? "Back to the default limit" : "Limit saved" });
    } catch (e) {
      showToast({ kind: "error", message: errorText(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      title={`Limits for ${account.email}`}
      open
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" disabled={busy || account.overrides[kind] === undefined} onClick={() => void save(null)} data-operator-quota-reset="">
            Use default
          </Button>
          <Button variant="primary" loading={busy} disabled={!valid} onClick={() => void save(isByteQuota(kind) ? typed * MB : typed)} data-operator-quota-save="">
            Save
          </Button>
        </>
      }
    >
      <div className={styles.form}>
        <div className={styles.formRow}>
          <span className={styles.formLabel}>Limit</span>
          <Select
            label="Limit"
            value={kind}
            options={ACCOUNT_QUOTA_KINDS.map((k) => ({ value: k, label: QUOTA_LABEL[k] }))}
            onChange={(v) => {
              const k = v as AccountQuotaKind;
              setKind(k);
              setValue(shown(k, account.overrides[k] ?? QUOTA_LIMITS[k]));
            }}
            variant="outlined"
            data-operator-quota-kind=""
          />
        </div>
        <div className={styles.formRow}>
          <span className={styles.formLabel}>{isByteQuota(kind) ? "Megabytes" : "Number"}</span>
          <TextInput label="Value" value={value} onChange={(v) => setValue(v.replace(/[^\d]/g, ""))} variant="outlined" invalid={!valid} data-operator-quota-value="" />
          <span className={styles.formLabel}>{`Now ${isByteQuota(kind) ? formatBytes(current) : current}${account.overrides[kind] === undefined ? " (the default)" : ` (default ${isByteQuota(kind) ? formatBytes(QUOTA_LIMITS[kind]) : QUOTA_LIMITS[kind]})`}`}</span>
        </div>
      </div>
    </Dialog>
  );
}
