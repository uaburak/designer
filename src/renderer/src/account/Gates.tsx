/**
 * What an org's Governance+ settings put in front of a person (docs/governance.md §2.5, §2.6, §2.13, §5 "Clients"):
 * an internal policy to agree to, two-factor authentication guests must turn on, an IP allowlist, a network that only
 * allows work accounts, and a guest's access ending soon. Home mounts them from `OrgSummary.gate` and from the
 * server's 403 codes (files/governance.ts); they only draw what they are handed — no store calls here.
 *
 * All wording is ours and **unverified**: Figma publishes neither the policy modal's buttons nor these screens' texts.
 */
import { useState } from "react";
import { Banner, Button, Dialog, EmptyState } from "@/ds";
import { GOVERNANCE_SIGN_IN_ERROR_TEXT, GUEST_EXPIRY_WARNING_MS, type PolicyPrompt } from "@shared/org/governance";
import { t, tp, useT } from "@/i18n";
import styles from "./Gates.module.css";

/** An internal policy (§2.6): its title, its text, Cancel (back to Drafts) and Agree. Unverified labels. */
export function PolicyModal({ policy, onAgree, onCancel }: { policy: PolicyPrompt; onAgree: () => Promise<void>; onCancel: () => void }) {
  useT();
  const [busy, setBusy] = useState(false);
  const agree = async () => {
    setBusy(true);
    try {
      await onAgree();
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      title={policy.title}
      size="medium"
      open
      closeOnScrim={false}
      onClose={onCancel}
      footer={
        <>
          <Button variant="secondary" onClick={onCancel} data-policy-cancel="">
            {t("Cancel")}
          </Button>
          <Button variant="primary" loading={busy} onClick={() => void agree()} data-policy-agree="">
            {t("Agree")}
          </Button>
        </>
      }
    >
      <div className={styles.policyText} data-policy={policy.id}>
        {policy.text}
      </div>
    </Dialog>
  );
}

/** "2FA for Guests" is on and this guest has none (§2.4): the org's content waits until they set it up. Unverified. */
export function TwoFactorRequired({ orgName, onSetUp }: { orgName: string; onSetUp: () => void }) {
  useT();
  return (
    <div className={styles.gate} data-gate="two_factor">
      <EmptyState size="page" icon="24.lock.small" title={t("{org} requires two-factor authentication for guests.", { org: orgName })} body={t("Turn it on in Settings › Security, then come back here.")} action={{ label: t("Set up two-factor authentication"), onClick: onSetUp }} />
    </div>
  );
}

/** The org's IP allowlist doesn't include this network (§2.3). Unverified. */
export function IpBlocked({ orgName, ip }: { orgName: string; ip: string }) {
  useT();
  return (
    <div className={styles.gate} data-gate="ip">
      <EmptyState size="page" icon="24.globe" title={t("{org} only allows access from approved networks.", { org: orgName })} body={`${t("Switch to an approved network, or log in with another account.")}${ip ? ` ${t("Your IP address: {ip}", { ip })}` : ""}`} />
    </div>
  );
}

/** A network that only allows its org's accounts (§2.5, account-wide): the whole window, Log out. Unverified title. */
export function NetworkRestricted({ onLogOut }: { onLogOut: () => void }) {
  useT();
  return (
    <div className={styles.window} role="alertdialog" aria-modal="true" aria-labelledby="network-restricted-title" data-gate="network">
      <div className={styles.windowBody}>
        <h2 id="network-restricted-title" className={styles.windowTitle}>
          {t("Switch to your work account")}
        </h2>
        <p className={styles.windowText}>{t(GOVERNANCE_SIGN_IN_ERROR_TEXT.network_restricted)}</p>
        <Button variant="primary" size="large" onClick={onLogOut} data-network-log-out="">
          {t("Log out")}
        </Button>
      </div>
    </div>
  );
}

const DAY_MS = 86_400_000;

/** Days left of a guest's access, shown from 14 days before (§2.13); null: no banner. */
export function guestDaysLeft(expiresAt: number | null | undefined, now: number): number | null {
  if (!expiresAt || expiresAt <= now || expiresAt - now > GUEST_EXPIRY_WARNING_MS) return null;
  return Math.max(1, Math.ceil((expiresAt - now) / DAY_MS));
}

/** "Your guest access to ‹org› ends in ‹N› days." (ours, unverified) */
export function GuestExpiryBanner({ orgName, expiresAt, now }: { orgName: string; expiresAt: number | null | undefined; now: number }) {
  useT();
  const days = guestDaysLeft(expiresAt, now);
  if (days === null) return null;
  return (
    <Banner tone="warning" className={styles.banner} data-guest-expiry={days}>
      {tp(days, "Your guest access to {org} ends in 1 day.", "Your guest access to {org} ends in {n} days.", { org: orgName })}
    </Banner>
  );
}
