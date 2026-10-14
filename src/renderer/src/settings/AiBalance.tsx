/**
 * "AI balance" (docs/ai.md §7; Figma's main menu › AI balance: credits used, remaining, the reset date — help
 * 33459875669015) and the meter Settings › AI shows. The month's credits come from the store's ledger
 * (`store.ai.balance`) against the allowance of Settings › AI, lowered by the organizations' Admin › Settings › AI
 * (`orgPolicy.ts`), as main's credits stop counts them. The usage history under it is ours. `openAiBalance()` opens
 * the modal in the view that calls it (the editor's main menu entry is 6a's); `SettingsHost` renders it.
 */
import { useEffect, useState, useSyncExternalStore } from "react";
import { Button, Dialog } from "@/ds";
import { getStoreClient } from "@/store";
import { AI_ACTION_LABEL, formatCredits } from "@shared/ai/labels";
import { allowanceOf, policyOf, type OrgAiPolicy } from "@shared/ai/orgPolicy";
import { DEFAULT_AI_SETTINGS, type AiBalance, type AiUsageEntry } from "@shared/ai/types";
import { aiSetupBridge } from "./bridge";
import styles from "./AiTab.module.css";
import { intlLocale, t, useT } from "@/i18n";

// ---- open / closed ----

let open = false;
const listeners = new Set<() => void>();
export function openAiBalance(): void {
  open = true;
  listeners.forEach((l) => l());
}
export function closeAiBalance(): void {
  open = false;
  listeners.forEach((l) => l());
}
const useOpen = () =>
  useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
    () => open,
  );

// ---- the numbers ----

/** The organizations' AI policy for the signed-in person (none when signed out or offline) */
export async function loadOrgPolicy(): Promise<OrgAiPolicy> {
  const store = getStoreClient();
  const orgs = await store.orgs.list().catch(() => []);
  const infos = await Promise.all(orgs.filter((o) => o.role !== "guest").map((o) => store.orgs.get(o.id).then((i) => ({ role: o.role, settings: i.settings }), () => null)));
  return policyOf(infos.filter((x): x is NonNullable<typeof x> => x !== null));
}

export interface BalanceView {
  balance: AiBalance;
  /** Settings › AI's monthly credits */
  own: number;
  policy: OrgAiPolicy;
}

/** The month's balance as the credits stop counts it */
export async function loadAiBalance(own?: number): Promise<BalanceView> {
  const monthly = own ?? (await aiSetupBridge()?.settings().catch(() => null))?.monthlyCredits ?? DEFAULT_AI_SETTINGS.monthlyCredits;
  const policy = await loadOrgPolicy();
  const balance = await getStoreClient().ai.balance(allowanceOf(monthly, policy));
  return { balance, own: monthly, policy };
}

export const resetDate = (at: number) => new Date(at).toLocaleDateString(intlLocale(), { month: "long", day: "numeric" });

/** "X of 4,250 credits used this month", the bar, and the org's word when it limits */
export function BalanceMeter({ view }: { view: BalanceView }) {
  useT();
  const { balance: b, own, policy } = view;
  const share = b.allowance > 0 ? Math.min(1, b.used / b.allowance) : 1;
  return (
    <div className={styles.meter} data-ai-meter="">
      <p className={styles.meterText}>
        <span data-ai-used="">{t("{used} of {allowance} credits used this month", { used: formatCredits(b.used), allowance: formatCredits(b.allowance) })}</span>
      </p>
      <div className={styles.bar} role="meter" aria-label={t("AI credits used")} aria-valuemin={0} aria-valuemax={b.allowance} aria-valuenow={Math.min(b.used, b.allowance)}>
        <div className={styles.fill} data-full={b.remaining <= 0 || undefined} style={{ width: `${share * 100}%` }} />
      </div>
      <p className={styles.caption}>{t("{credits} credits remaining · Resets {date}", { credits: formatCredits(b.remaining), date: resetDate(b.resetsAt) })}</p>
      {policy.disabled ? (
        <p className={styles.caption} data-ai-org="">{t("Your organization has turned off AI features.")}</p>
      ) : policy.limit !== null && policy.limit < own ? (
        <p className={styles.caption} data-ai-org="">{t("Your organization allows {credits} credits a month.", { credits: formatCredits(policy.limit) })}</p>
      ) : null}
    </div>
  );
}

// ---- the modal ----

export function AiBalanceHost() {
  return useOpen() ? <AiBalanceDialog onClose={closeAiBalance} /> : null;
}

export function AiBalanceDialog({ onClose }: { onClose: () => void }) {
  useT();
  const [view, setView] = useState<BalanceView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<AiUsageEntry[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    loadAiBalance().then(
      (v) => live && setView(v),
      () => live && setError(t("The AI balance isn't available right now.")),
    );
    getStoreClient()
      .ai.history({ limit: 50 })
      .then(
        (h) => {
          if (!live) return;
          setHistory(h.entries);
          setCursor(h.cursor);
        },
        () => {},
      );
    return () => {
      live = false;
    };
  }, []);
  const more = () =>
    void getStoreClient()
      .ai.history({ limit: 50, cursor: cursor ?? undefined })
      .then((h) => {
        setHistory((x) => [...x, ...h.entries]);
        setCursor(h.cursor);
      });
  const b = view?.balance;
  return (
    <Dialog title={t("AI balance")} open size="medium" onClose={onClose} footer={<Button variant="secondary" size="large" onClick={onClose}>{t("Done")}</Button>}>
      <div className={styles.balance} data-ai-balance="">
        {error && <p className={styles.caption}>{error}</p>}
        {b && view && (
          <>
            <dl className={styles.figures}>
              <div>
                <dt>{t("Credits used")}</dt>
                <dd data-ai-figure="used">{formatCredits(b.used)}</dd>
              </div>
              <div>
                <dt>{t("Credits remaining")}</dt>
                <dd data-ai-figure="remaining">{formatCredits(b.remaining)}</dd>
              </div>
              <div>
                <dt>{t("Resets {date}", { date: resetDate(b.resetsAt) })}</dt>
                <dd data-ai-figure="allowance">{t("{credits} a month", { credits: formatCredits(b.allowance) })}</dd>
              </div>
            </dl>
            <BalanceMeter view={view} />
            {Object.keys(b.byAction).length > 0 && (
              <ul className={styles.byAction} aria-label={t("Credits by feature")}>
                {Object.entries(b.byAction)
                  .sort((x, y) => (y[1] ?? 0) - (x[1] ?? 0))
                  .map(([a, n]) => (
                    <li key={a}>
                      <span>{t(AI_ACTION_LABEL[a as keyof typeof AI_ACTION_LABEL] ?? a)}</span>
                      <span className={styles.num}>{formatCredits(n ?? 0)}</span>
                    </li>
                  ))}
              </ul>
            )}
          </>
        )}
        <h3 className={styles.subheading}>{t("Usage history")}</h3>
        {history.length === 0 ? (
          <p className={styles.caption}>{t("No AI used this month.")}</p>
        ) : (
          <table className={styles.history} data-ai-history="">
            <thead>
              <tr>
                <th>{t("Date")}</th>
                <th>{t("Feature")}</th>
                <th>{t("Model")}</th>
                <th className={styles.num}>{t("Credits")}</th>
              </tr>
            </thead>
            <tbody>
              {history.map((e) => (
                <tr key={e.id} data-ok={e.ok || undefined}>
                  <td>{new Date(e.at).toLocaleString(intlLocale(), { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</td>
                  <td>{t(AI_ACTION_LABEL[e.action] ?? e.action)}</td>
                  <td className={styles.muted}>{e.model ?? e.providerId}</td>
                  <td className={styles.num}>{formatCredits(e.credits)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {cursor && (
          <Button variant="secondary" onClick={more}>
            {t("Show more")}
          </Button>
        )}
      </div>
    </Dialog>
  );
}
