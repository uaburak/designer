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
import { t, tp, useT } from "@/i18n";

const KEYS: Record<PluginKind, { approval: "pluginApproval" | "widgetApproval"; requests: "pluginRequests" | "widgetRequests"; many: string; title: string }> = {
  plugin: { approval: "pluginApproval", requests: "pluginRequests", many: "plugins", title: "Plugin approval" },
  widget: { approval: "widgetApproval", requests: "widgetRequests", many: "widgets", title: "Widget approval" },
};

/** The row's value: "All plugins", or "Only admin-approved plugins" and whether members may request */
export function approvalSummary(s: OrgSettings, kind: PluginKind): string[] {
  const k = KEYS[kind];
  const plugins = kind === "plugin";
  if (s[k.approval] === "all") return [plugins ? t("All plugins") : t("All widgets")];
  return [
    plugins ? t("Only admin-approved plugins") : t("Only admin-approved widgets"),
    s[k.requests] ? (plugins ? t("Members can request plugins") : t("Members can request widgets")) : plugins ? t("Members can't request plugins") : t("Members can't request widgets"),
  ];
}

/** Plugin approval / Widget approval: any, or only admin-approved — and whether members may request them */
export function ApprovalDialog({ kind, settings, onSave, onClose }: { kind: PluginKind; settings: OrgSettings; onSave: (patch: Partial<OrgSettings>) => void; onClose: () => void }) {
  useT();
  const k = KEYS[kind];
  const [approval, setApproval] = useState(settings[k.approval]);
  const [requests, setRequests] = useState(settings[k.requests]);
  return (
    <Dialog
      title={t(k.title)}
      open
      size="medium"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>{t("Cancel")}</Button>
          <Button
            variant="primary"
            onClick={() => {
              onSave({ [k.approval]: approval, [k.requests]: requests });
              onClose();
            }}
          >
            {t("Save")}
          </Button>
        </>
      }
    >
      <div className={styles.form} data-approval-dialog={kind}>
        <RadioGroup
          label={t(k.title)}
          value={approval}
          options={[
            { value: "all", label: kind === "widget" ? t("Allow all widgets") : t("Allow all plugins") },
            { value: "approved", label: kind === "widget" ? t("Only admin-approved widgets.") : t("Only admin-approved plugins.") },
          ]}
          onChange={(v) => setApproval(v === "approved" ? "approved" : "all")}
        />
        <div className={styles.option}>
          <Checkbox label={kind === "widget" ? t("Allow members to request widgets") : t("Allow members to request plugins")} checked={requests} disabled={approval !== "approved"} onChange={setRequests} />
          <span className={styles.optionDescription}>
            {kind === "widget" ? t("All organization admins get notified when someone sends a request. Approved widgets are listed in Resources › Widgets.") : t("All organization admins get notified when someone sends a request. Approved plugins are listed in Resources › Plugins.")}
          </span>
        </div>
        <span className={styles.note}>{kind === "widget" ? t("Private widgets published by members of the organization don't need approval.") : t("Private plugins published by members of the organization don't need approval.")}</span>
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
  useT();
  const { orgId, store, run, now } = useAdmin();
  const { data, error } = useLoad(() => store.admin.planTokens(orgId), [orgId]);
  const [generating, setGenerating] = useState(false);
  const [revoking, setRevoking] = useState<AccessTokenInfo | null>(null);
  const columns: Column<AccessTokenInfo>[] = [
    { id: "name", label: "Name", width: "minmax(160px, 1.4fr)", compare: byText((tok) => tok.description), render: (tok) => <span className={styles.whoName}>{tok.description}</span> },
    { id: "scopes", label: "Scopes", width: "minmax(180px, 2fr)", render: (tok) => <span className={styles.muted}>{tok.scopes.join(", ")}</span> },
    { id: "created", label: "Created", width: 110, compare: byNumber((tok) => tok.createdAt), render: (tok) => <span className={styles.muted}>{formatDate(tok.createdAt)}</span> },
    { id: "expires", label: "Expires", width: 110, compare: byNumber((tok) => tok.expiresAt), render: (tok) => <span className={tok.expiresAt !== null && tok.expiresAt <= now() ? styles.danger : styles.muted}>{tok.expiresAt === null ? t("Never") : tok.expiresAt <= now() ? t("Expired") : formatDate(tok.expiresAt)}</span> },
    { id: "used", label: "Last used", width: 110, compare: byNumber((tok) => tok.lastUsedAt), render: (tok) => <span className={styles.muted}>{formatAgo(tok.lastUsedAt, now())}</span> },
    { id: "menu", label: "", width: 32, align: "end", render: (tok) => <RowMenu label={t("Actions for {name}", { name: tok.description })} entries={[{ id: "revoke", label: "Revoke token", danger: true }]} onSelect={() => setRevoking(tok)} /> },
  ];
  return (
    <>
      <div className={styles.settingRow} data-setting="planTokens">
        <span className={styles.settingText}>
          <span className={styles.settingLabel}>{t("Plan access tokens")}</span>
          <span className={styles.settingDescription}>{t("REST API tokens that belong to the organization, not to a person. They read activity logs, AI usage and library analytics, and manage webhooks. They last up to a year.")}</span>
        </span>
        <Button variant="secondary" onClick={() => setGenerating(true)} data-plan-tokens="generate">{t("Generate new token")}</Button>
      </div>
      {error && <p className={styles.danger}>{error}</p>}
      <Table label={t("Plan access tokens")} rows={data ?? []} columns={columns} rowKey={(tok) => tok.id} empty={data === undefined ? t("Loading…") : t("No plan access tokens")} />
      {generating && <GeneratePlanToken onClose={() => setGenerating(false)} />}
      {revoking && (
        <ConfirmDialog
          title={t("Revoke token?")}
          body={t("Anything using “{name}” will no longer be able to reach the organization's data through the API.", { name: revoking.description })}
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
  useT();
  const { orgId, store, run } = useAdmin();
  const [name, setName] = useState("");
  const [days, setDays] = useState("90");
  const [scopes, setScopes] = useState<Set<TokenScope>>(new Set());
  const [busy, setBusy] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  if (token)
    return (
      <Dialog
        title={t("Copy your token")}
        open
        size="medium"
        onClose={onClose}
        footer={
          <>
            <Button variant="secondary" onClick={() => void navigator.clipboard?.writeText(token).then(() => showToast({ message: t("Copied to clipboard") }))}>{t("Copy")}</Button>
            <Button variant="primary" onClick={onClose}>{t("Done")}</Button>
          </>
        }
      >
        <div className={styles.form}>
          <p className={styles.note}>{t("This is the only time your token secret is displayed.")}</p>
          <div className={styles.kvList}>
            <div className={styles.kv} data-new-plan-token="">
              <span className={styles.kvLabel}>{name.trim()}</span>
              <span className={styles.kvValue}>{token}</span>
              <span />
            </div>
          </div>
          <p className={`${styles.note} ${styles.muted}`}>{t("Send it in the X-Figma-Token header.")}</p>
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
      title={t("Generate new token")}
      open
      size="medium"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>{t("Cancel")}</Button>
          <Button variant="primary" disabled={!name.trim() || !scopes.size} loading={busy} onClick={() => void generate()} data-plan-tokens="create">{t("Generate token")}</Button>
        </>
      }
    >
      <div className={styles.form}>
        <Field title={t("Token name")}>
          <TextInput label={t("Token name")} value={name} onChange={setName} placeholder={t("Token name")} autoFocus maxLength={100} variant="outlined" />
        </Field>
        <Field title={t("Expiration")}>
          <Select label={t("Expiration")} value={days} options={PLAN_EXPIRATIONS.map((e) => ({ value: String(e.days), label: e.days === 365 ? t("1 year") : tp(e.days, "{n} day", "{n} days") }))} onChange={setDays} />
        </Field>
        <Field title={t("Scopes")}>
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
                <span className={styles.optionDescription}>{t(SCOPE_LABEL.get(id) ?? "")}</span>
              </div>
            ))}
          </div>
        </Field>
      </div>
    </Dialog>
  );
}
