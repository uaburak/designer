/**
 * Admin › Settings, round 5: **Extensions** (help.figma.com 4404228724759: "Plugin approval" / "Widget approval",
 * "Only admin-approved plugins.", "Allow members to request plugins"; docs/plugins.md §10.2) and **Plan access tokens**
 * (docs/multiplayer.md §16.3; developers.figma.com plan-access-tokens: the token's name, an expiration up to a year,
 * scopes, the secret shown once): the org's tokens with Generate new token and Revoke, through
 * `AdminRepository.planTokens` / `createPlanToken` / `revokePlanToken`.
 */
import { useState } from "react";
import { Button, Checkbox, Dialog, RadioGroup, Select, TextInput, showToast } from "@/ds";
import { TOKEN_SCOPES, type AccessTokenInfo, type TokenScope } from "@shared/account";
import type { OrgSettings } from "@shared/org/types";
import type { PluginKind } from "@shared/plugins/types";
import { PLAN_TOKEN_SCOPES } from "@shared/rest/types";
import { useAdmin, useLoad } from "./context";
import { formatAgo, formatDate } from "./labels";
import { ConfirmDialog, Field, RowMenu, Table, byNumber, byText, styles, type Column } from "./parts";

const KEYS: Record<PluginKind, { approval: "pluginApproval" | "widgetApproval"; requests: "pluginRequests" | "widgetRequests"; many: string; title: string }> = {
  plugin: { approval: "pluginApproval", requests: "pluginRequests", many: "plugins", title: "Plugin approval" },
  widget: { approval: "widgetApproval", requests: "widgetRequests", many: "widgets", title: "Widget approval" },
};

/** The row's value: "All plugins", or "Only admin-approved plugins" and whether members may request */
export function approvalSummary(s: OrgSettings, kind: PluginKind): string[] {
  const k = KEYS[kind];
  if (s[k.approval] === "all") return [`All ${k.many}`];
  return [`Only admin-approved ${k.many}`, s[k.requests] ? `Members can request ${k.many}` : `Members can't request ${k.many}`];
}

/** Plugin approval / Widget approval: any, or only admin-approved — and whether members may request them */
export function ApprovalDialog({ kind, settings, onSave, onClose }: { kind: PluginKind; settings: OrgSettings; onSave: (patch: Partial<OrgSettings>) => void; onClose: () => void }) {
  const k = KEYS[kind];
  const [approval, setApproval] = useState(settings[k.approval]);
  const [requests, setRequests] = useState(settings[k.requests]);
  return (
    <Dialog
      title={k.title}
      open
      size="medium"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            onClick={() => {
              onSave({ [k.approval]: approval, [k.requests]: requests });
              onClose();
            }}
          >
            Save
          </Button>
        </>
      }
    >
      <div className={styles.form} data-approval-dialog={kind}>
        <RadioGroup
          label={k.title}
          value={approval}
          options={[
            { value: "all", label: `Allow all ${k.many}` },
            { value: "approved", label: `Only admin-approved ${k.many}.` },
          ]}
          onChange={(v) => setApproval(v === "approved" ? "approved" : "all")}
        />
        <div className={styles.option}>
          <Checkbox label={`Allow members to request ${k.many}`} checked={requests} disabled={approval !== "approved"} onChange={setRequests} />
          <span className={styles.optionDescription}>
            {`All organization admins get notified when someone sends a request. Approved ${k.many} are listed in Resources › ${kind === "widget" ? "Widgets" : "Plugins"}.`}
          </span>
        </div>
        <span className={styles.note}>{`Private ${k.many} published by members of the organization don't need approval.`}</span>
      </div>
    </Dialog>
  );
}

/** Expiration choices: Figma's plan tokens last up to a year */
const PLAN_EXPIRATIONS = [
  { days: 7, label: "7 days" },
  { days: 30, label: "30 days" },
  { days: 90, label: "90 days" },
  { days: 180, label: "180 days" },
  { days: 365, label: "1 year" },
];
const SCOPE_LABEL = new Map<string, string>(TOKEN_SCOPES.map((s) => [s.id, s.label]));

/** Settings › Plan access tokens: the list, Generate new token, Revoke */
export function PlanTokens() {
  const { orgId, store, run, now } = useAdmin();
  const { data, error } = useLoad(() => store.admin.planTokens(orgId), [orgId]);
  const [generating, setGenerating] = useState(false);
  const [revoking, setRevoking] = useState<AccessTokenInfo | null>(null);
  const columns: Column<AccessTokenInfo>[] = [
    { id: "name", label: "Name", width: "minmax(160px, 1.4fr)", compare: byText((t) => t.description), render: (t) => <span className={styles.whoName}>{t.description}</span> },
    { id: "scopes", label: "Scopes", width: "minmax(180px, 2fr)", render: (t) => <span className={styles.muted}>{t.scopes.join(", ")}</span> },
    { id: "created", label: "Created", width: 110, compare: byNumber((t) => t.createdAt), render: (t) => <span className={styles.muted}>{formatDate(t.createdAt)}</span> },
    { id: "expires", label: "Expires", width: 110, compare: byNumber((t) => t.expiresAt), render: (t) => <span className={t.expiresAt !== null && t.expiresAt <= now() ? styles.danger : styles.muted}>{t.expiresAt === null ? "Never" : t.expiresAt <= now() ? "Expired" : formatDate(t.expiresAt)}</span> },
    { id: "used", label: "Last used", width: 110, compare: byNumber((t) => t.lastUsedAt), render: (t) => <span className={styles.muted}>{formatAgo(t.lastUsedAt, now())}</span> },
    { id: "menu", label: "", width: 32, align: "end", render: (t) => <RowMenu label={`Actions for ${t.description}`} entries={[{ id: "revoke", label: "Revoke token", danger: true }]} onSelect={() => setRevoking(t)} /> },
  ];
  return (
    <>
      <div className={styles.settingRow} data-setting="planTokens">
        <span className={styles.settingText}>
          <span className={styles.settingLabel}>Plan access tokens</span>
          <span className={styles.settingDescription}>REST API tokens that belong to the organization, not to a person. They read activity logs, AI usage and library analytics, and manage webhooks. They last up to a year.</span>
        </span>
        <Button variant="secondary" onClick={() => setGenerating(true)} data-plan-tokens="generate">Generate new token</Button>
      </div>
      {error && <p className={styles.danger}>{error}</p>}
      <Table label="Plan access tokens" rows={data ?? []} columns={columns} rowKey={(t) => t.id} empty={data === undefined ? "Loading…" : "No plan access tokens"} />
      {generating && <GeneratePlanToken onClose={() => setGenerating(false)} />}
      {revoking && (
        <ConfirmDialog
          title="Revoke token?"
          body={`Anything using “${revoking.description}” will no longer be able to reach the organization's data through the API.`}
          confirm="Revoke token"
          destructive
          onConfirm={() => void run(() => store.admin.revokePlanToken(orgId, revoking.id), "Token revoked")}
          onClose={() => setRevoking(null)}
        />
      )}
    </>
  );
}

function GeneratePlanToken({ onClose }: { onClose: () => void }) {
  const { orgId, store, run } = useAdmin();
  const [name, setName] = useState("");
  const [days, setDays] = useState("90");
  const [scopes, setScopes] = useState<Set<TokenScope>>(new Set());
  const [busy, setBusy] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  if (token)
    return (
      <Dialog
        title="Copy your token"
        open
        size="medium"
        onClose={onClose}
        footer={
          <>
            <Button variant="secondary" onClick={() => void navigator.clipboard?.writeText(token).then(() => showToast({ message: "Copied to clipboard" }))}>Copy</Button>
            <Button variant="primary" onClick={onClose}>Done</Button>
          </>
        }
      >
        <div className={styles.form}>
          <p className={styles.note}>This is the only time your token secret is displayed.</p>
          <div className={styles.kvList}>
            <div className={styles.kv} data-new-plan-token="">
              <span className={styles.kvLabel}>{name.trim()}</span>
              <span className={styles.kvValue}>{token}</span>
              <span />
            </div>
          </div>
          <p className={`${styles.note} ${styles.muted}`}>Send it in the X-Figma-Token header.</p>
        </div>
      </Dialog>
    );
  const generate = async () => {
    setBusy(true);
    const out = await run(() => store.admin.createPlanToken(orgId, { description: name.trim(), expiresInDays: Number(days), scopes: [...scopes] }));
    setBusy(false);
    if (out) setToken(out.token);
  };
  return (
    <Dialog
      title="Generate new token"
      open
      size="medium"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!name.trim() || !scopes.size} loading={busy} onClick={() => void generate()} data-plan-tokens="create">Generate token</Button>
        </>
      }
    >
      <div className={styles.form}>
        <Field title="Token name">
          <TextInput label="Token name" value={name} onChange={setName} placeholder="Token name" autoFocus maxLength={100} variant="outlined" />
        </Field>
        <Field title="Expiration">
          <Select label="Expiration" value={days} options={PLAN_EXPIRATIONS.map((e) => ({ value: String(e.days), label: e.label }))} onChange={setDays} />
        </Field>
        <Field title="Scopes">
          <div className={styles.form}>
            {PLAN_TOKEN_SCOPES.map((id) => (
              <div key={id} className={styles.option} data-plan-scope={id}>
                <Checkbox
                  label={id}
                  checked={scopes.has(id as TokenScope)}
                  onChange={(on) =>
                    setScopes((cur) => {
                      const next = new Set(cur);
                      if (on) next.add(id as TokenScope);
                      else next.delete(id as TokenScope);
                      return next;
                    })
                  }
                />
                <span className={styles.optionDescription}>{SCOPE_LABEL.get(id) ?? ""}</span>
              </div>
            ))}
          </div>
        </Field>
      </div>
    </Dialog>
  );
}
