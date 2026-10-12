/**
 * A shared file the server refuses (docs/governance.md §2.5, §2.10; §9 "As built — 14e": `FileShareState.blocked`):
 * instead of a file that seems to reconnect forever, the editor says why and what to do — an internal policy to
 * agree to (Home's PolicyModal; Agree → `governance.acknowledgePolicy`, after which the store lets the link try
 * again), two-factor authentication guests must turn on (Settings › Security), the org's IP allowlist, a network
 * that only allows work accounts (Log out), or the org's encryption key that can't be reached. The local copy stays
 * under it; the state goes when the store clears `blocked`. All wording ours, unverified.
 */
import { useEffect, useState } from "react";
import { EmptyState } from "@/ds";
import { getStoreClient } from "@/store";
import type { FileShareState } from "@shared/multiplayer/types";
import { IpBlocked, NetworkRestricted, PolicyModal, TwoFactorRequired } from "../../account/Gates";
import { accountBridge } from "../../files/account";
import { openSettings } from "../../settings/bridge";
import styles from "./Multiplayer.module.css";

/** `key_unavailable` (ours) */
export const KEY_UNAVAILABLE_TEXT = "This file is unavailable because its encryption key can’t be reached.";

/** What FileBlocked asks of the store and the account (tests pass their own). */
export interface FileBlockedDeps {
  /** The file's org (its linked copy's `FileMeta.space`) and its name; null: unknown */
  orgOf(fileKey: string): Promise<{ id: string; name: string } | null>;
  acknowledgePolicy(orgId: string, policyId: string): Promise<void>;
  signOut(): void;
  openSecurity(): void;
}

const storeDeps: FileBlockedDeps = {
  orgOf: async (fileKey) => {
    const client = getStoreClient();
    const orgId = (await client.workspace.getFile(fileKey).catch(() => null))?.space?.orgId;
    if (!orgId) return null;
    const info = await client.orgs.get(orgId).catch(() => null);
    return { id: orgId, name: info?.name ?? "" };
  },
  acknowledgePolicy: (orgId, policyId) => getStoreClient().governance.acknowledgePolicy(orgId, policyId),
  signOut: () => void accountBridge()?.signOut(),
  openSecurity: () => openSettings("security"),
};

export function FileBlocked({ fileKey, blocked, deps = storeDeps }: { fileKey: string | null; blocked: NonNullable<FileShareState["blocked"]>; deps?: FileBlockedDeps }) {
  const [org, setOrg] = useState<{ id: string; name: string } | null>(null);
  const [agreed, setAgreed] = useState<ReadonlySet<string>>(() => new Set());
  const [reviewing, setReviewing] = useState(true);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!fileKey) return;
    let live = true;
    void deps.orgOf(fileKey).then((o) => live && setOrg(o), () => {});
    return () => {
      live = false;
    };
  }, [fileKey, deps]);

  const orgName = org?.name || "This organization";
  const gate = blocked.gate;

  if (blocked.code === "network_restricted") return <NetworkRestricted onLogOut={deps.signOut} />;

  let content: React.ReactNode = null;
  let modal: React.ReactNode = null;
  if (blocked.code === "key_unavailable") {
    content = <EmptyState size="page" icon="24.lock.small" title={KEY_UNAVAILABLE_TEXT} body="Your copy stays on this computer. It opens again once your organization’s key can be reached." />;
  } else if (gate?.kind === "two_factor") {
    content = <TwoFactorRequired orgName={orgName} onSetUp={deps.openSecurity} />;
  } else if (gate?.kind === "ip") {
    content = <IpBlocked orgName={orgName} ip={gate.ip} />;
  } else if (gate?.kind === "policy") {
    const policy = gate.policies.find((p) => !agreed.has(p.id)) ?? null;
    content = (
      <EmptyState
        size="page"
        icon="24.lock.small"
        title={`Agree to ${orgName === "This organization" ? "your organization’s" : `${orgName}’s`} policies to open this file.`}
        body={error ?? (policy ? undefined : "Opening the file…")}
        action={policy && !reviewing ? { label: "Review policies", onClick: () => setReviewing(true) } : undefined}
      />
    );
    if (policy && reviewing)
      modal = (
        <PolicyModal
          key={policy.id}
          policy={policy}
          onCancel={() => setReviewing(false)}
          onAgree={async () => {
            if (!org) return void setError("This file’s organization isn’t known yet. Try again in a moment.");
            try {
              await deps.acknowledgePolicy(org.id, policy.id);
              setError(null);
              setAgreed((a) => new Set(a).add(policy.id));
            } catch (e) {
              setError(e instanceof Error ? e.message : String(e));
              setReviewing(false);
            }
          }}
        />
      );
  } else {
    return null;
  }
  return (
    <>
      <div className={styles.blocked} role="alert" data-file-blocked={blocked.code}>
        {content}
      </div>
      {modal}
    </>
  );
}
