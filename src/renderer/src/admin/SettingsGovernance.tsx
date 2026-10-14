/**
 * Admin › Settings' Governance+ rows (docs/governance.md §1, §5; Phase 7 round 14h) over `GovernanceRepository`
 * (`store.governance`): Manage identity providers (IdP) — the "Identity providers" table, + Add IDP, Edit configuration
 * with the domains each serves, SCIM per IdP, More › Remove —; the IP allowlist; 2FA for Guests' confirm; Set default
 * duration for guest access; File exporting with workspace overrides; Network access restrictions; Internal policies;
 * Key management with its "Encrypting files…" loop. Figma's wording where it is published; the rest is ours (marked).
 */
import { useEffect, useRef, useState } from "react";
import { Badge, Banner, Button, Checkbox, CodeBlock, Dialog, RadioGroup, Select, Switch, TextArea, TextInput, showToast, type SelectOption } from "@/ds";
import {
  FILE_EXPORTING_LABEL, GUEST_EXPIRY_MAX_DAYS, POLICY_AUDIENCE_LABEL, POLICY_CADENCE_LABEL, POLICY_TEXT_MAX, POLICY_TITLE_MAX,
  NETWORK_TESTING_MIN_MS, ipInCidr, normalizeCidr,
  type EkmStatus, type FileExporting, type GovernanceOverview, type InternalPolicy, type NetworkRange, type NetworkRangeState, type PolicyAudience, type PolicyCadence,
} from "@shared/org/governance";
import { IDP_PROVIDER_LABEL, type IdpConfig, type IdpConfigInput, type IdpProvider, type ScimTokenCreated, type ScimTokenInfo } from "@shared/org/identity";
import type { OrgSettings, OrgWorkspace } from "@shared/org/types";
import { useAdmin, useLoad } from "./context";
import { NETWORK_STATE_LABEL, formatAgo, formatDate } from "./labels";
import { ConfirmDialog, Field, RowMenu, Table, styles, type Column } from "./parts";
import { CopyRow, errorParts } from "./SettingsLogin";
import { intlLocale, t, tp, tx, useT } from "@/i18n";

/** The overview (`GET admin/governance`) — null while loading or without `store.governance` */
export function useGovernance(): { overview: GovernanceOverview | null; on: boolean; available: boolean } {
  const { orgId, store } = useAdmin();
  const g = store.governance;
  const { data } = useLoad(() => (g ? g.overview(orgId) : Promise.resolve(null)), [orgId, g]);
  return { overview: data ?? null, on: data?.governancePlus ?? false, available: Boolean(g) };
}

/** The server's per-IdP SCIM row (ours, not in the shared type: docs/governance.md §9 14a) */
type IdpWithScim = IdpConfig & { scim?: { baseUrl: string; token: ScimTokenInfo | null } };
const idpName = (i: IdpConfig) => i.name?.trim() || t(IDP_PROVIDER_LABEL[i.provider]);

// ---- Manage identity providers (IdP) -----------------------------------------------------------------------------

export function IdpsDialog({ authMethod, onClose }: { authMethod: OrgSettings["authMethod"]; onClose: () => void }) {
  useT();
  const { orgId, store, run, changed, onTestSso } = useAdmin();
  const g = store.governance!;
  const { data: idps } = useLoad(() => g.idps(orgId), [orgId]);
  const [editing, setEditing] = useState<IdpWithScim | "new" | null>(null);
  const [scimOf, setScimOf] = useState<string | null>(null);
  const [removing, setRemoving] = useState<IdpWithScim | null>(null);
  const list = (idps ?? []) as IdpWithScim[];
  const test = async (i: IdpConfig) => {
    if (!onTestSso) return;
    try {
      await onTestSso(i.tenantId);
      const after = (await g.idps(orgId)).find((x) => x.tenantId === i.tenantId);
      changed();
      showToast(after?.testedAt ? { message: t("{name} works", { name: idpName(i) }) } : { message: t("The test sign-in didn't finish"), kind: "error" });
    } catch (e) {
      showToast({ message: errorParts(e).message, kind: "error" });
    }
  };
  const columns: Column<IdpWithScim>[] = [
    { id: "name", label: "Name", width: "minmax(160px, 1.5fr)", render: (i) => <span className={styles.whoText}><span className={styles.whoName}>{idpName(i)}</span><span className={styles.whoEmail}>{t(IDP_PROVIDER_LABEL[i.provider])}</span></span> },
    { id: "domains", label: "Domains", width: "minmax(140px, 1.5fr)", render: (i) => <span className={styles.muted}>{i.domains?.length ? i.domains.join(", ") : t("No domains")}</span> },
    { id: "status", label: "Status", width: 110, render: (i) => (i.testedAt ? <Badge tone="success">{t("Tested")}</Badge> : <Badge tone="warning">{t("Not tested")}</Badge>) },
    { id: "scim", label: "SCIM", width: 64, render: (i) => <span className={styles.muted}>{i.scim?.token ? t("On") : t("Off")}</span> },
    {
      id: "menu", label: "", width: 32, align: "end",
      render: (i) => (
        <RowMenu
          label={t("More for {name}", { name: idpName(i) })}
          entries={[
            { id: "edit", label: "Edit configuration" },
            { id: "test", label: "Test", disabled: !onTestSso },
            ...(i.metadataUrl ? [{ id: "refresh", label: "Refresh metadata" }] : []),
            { id: "scim", label: "SCIM provisioning" },
            "-",
            { id: "remove", label: "Remove", danger: true },
          ]}
          onSelect={(id) => {
            if (id === "edit") setEditing(i);
            else if (id === "test") void test(i);
            else if (id === "refresh") void run(() => g.refreshIdp(orgId, i.tenantId), "Metadata refreshed");
            else if (id === "scim") setScimOf(i.tenantId);
            else setRemoving(i);
          }}
        />
      ),
    },
  ];
  const scimIdp = list.find((i) => i.tenantId === scimOf);
  return (
    <>
      <Dialog title={t("Manage identity providers (IdP)")} open={!editing && !scimOf} size="large" onClose={onClose} footer={<Button variant="primary" onClick={onClose}>{t("Done")}</Button>}>
        <div className={styles.form} data-idps="">
          <div className={styles.note}>{t("Each domain uses one identity provider; an identity provider can serve several domains. Members on domains without one log in with the organization's other allowed methods.")}</div>
          <div className={styles.toolbar}>
            <span className={styles.spacer} />
            <Button variant="secondary" icon="24.plus.small" onClick={() => setEditing("new")}>{t("Add IDP")}</Button>
          </div>
          <div className={styles.inDialog}>
            <Table label={t("Identity providers")} rows={list} columns={columns} rowKey={(i) => i.tenantId} empty="No identity providers yet" />
          </div>
          {authMethod === "saml" && <div className={styles.note}>{t("Members must log in with SAML SSO: an identity provider with domains, or the only one, can't be changed or removed until they don't.")}</div>}
        </div>
      </Dialog>
      {editing && <IdpEditDialog idp={editing === "new" ? null : editing} idps={list} onClose={() => setEditing(null)} />}
      {scimIdp && <IdpScimDialog idp={scimIdp} onClose={() => setScimOf(null)} />}
      {removing && (
        <ConfirmDialog
          title={t("Remove {name}?", { name: idpName(removing) })} destructive confirm="Remove"
          body={t("Its domains stop using it for SAML SSO, and its SCIM token is revoked.")}
          onConfirm={() => void run(() => g.removeIdp(orgId, removing.tenantId), `${idpName(removing)} removed`)}
          onClose={() => setRemoving(null)}
        />
      )}
    </>
  );
}

type Conn = "keep" | "url" | "xml" | "manual";

/** + Add IDP / Edit configuration: name, provider, the metadata (or keep it), the domains it serves */
function IdpEditDialog({ idp, idps, onClose }: { idp: IdpWithScim | null; idps: IdpWithScim[]; onClose: () => void }) {
  useT();
  const { orgId, store, run } = useAdmin();
  const g = store.governance!;
  const { data: ov } = useLoad(() => (store.identity ? store.identity.overview(orgId) : Promise.resolve(null)), [orgId, store.identity]);
  const [name, setName] = useState(idp?.name ?? "");
  const [provider, setProvider] = useState<IdpProvider>(idp?.provider ?? "okta");
  const [conn, setConn] = useState<Conn>(idp ? "keep" : "url");
  const [url, setUrl] = useState(idp?.metadataUrl ?? "");
  const [xml, setXml] = useState("");
  const [entityId, setEntityId] = useState(idp?.idpEntityId ?? "");
  const [ssoUrl, setSsoUrl] = useState(idp?.ssoUrl ?? "");
  const [certificate, setCertificate] = useState("");
  const [domains, setDomains] = useState<Set<string>>(() => new Set(idp?.domains ?? []));
  const verified = (ov?.domains ?? []).filter((d) => d.verified).map((d) => d.domain);
  const owner = (d: string) => idps.find((i) => i.tenantId !== idp?.tenantId && i.domains?.includes(d));
  const ready = conn === "keep" || (conn === "url" ? url.trim() !== "" : conn === "xml" ? xml.trim() !== "" : entityId.trim() !== "" && ssoUrl.trim() !== "" && certificate.trim() !== "");
  const save = async () => {
    const out = await run(async () => {
      let saved: IdpConfig;
      if (conn === "keep" && idp) {
        // The server's `{name}` alone renames (docs/governance.md §9, 14a)
        saved = name.trim() !== (idp.name ?? "") ? await g.saveIdp(orgId, idp.tenantId, { name: name.trim() } as IdpConfigInput) : idp;
      } else {
        const source = conn === "url" ? { metadataUrl: url.trim() } : conn === "xml" ? { metadataXml: xml } : { idpEntityId: entityId.trim(), ssoUrl: ssoUrl.trim(), certificate: certificate.trim() };
        saved = await g.saveIdp(orgId, idp?.tenantId ?? null, { provider, name: name.trim(), ...source });
      }
      const before = new Set(idp?.domains ?? []);
      for (const d of verified) {
        if (domains.has(d) && !before.has(d)) await g.mapDomain(orgId, d, saved.tenantId);
        else if (!domains.has(d) && before.has(d)) await g.mapDomain(orgId, d, null);
      }
      return saved;
    }, idp ? "Identity provider saved" : "Identity provider added");
    if (out) onClose();
  };
  return (
    <Dialog
      title={idp ? t("Edit configuration") : t("Add IDP")} open size="large" onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>{t("Cancel")}</Button>
          <Button variant="primary" disabled={!ready} onClick={() => void save()}>{idp ? t("Save") : t("Add IDP")}</Button>
        </>
      }
    >
      <div className={styles.form} data-idp-edit={idp?.tenantId ?? "new"}>
        <Field title={t("Name")}>
          <TextInput label={t("Name")} value={name} onChange={setName} placeholder={t("Okta (Europe)")} variant="outlined" autoFocus />
        </Field>
        <Field title={t("Identity provider")}>
          <Select label={t("Identity provider")} value={provider} disabled={conn === "keep"} options={(Object.keys(IDP_PROVIDER_LABEL) as IdpProvider[]).map((p) => ({ value: p, label: t(IDP_PROVIDER_LABEL[p]) }))} onChange={(v) => setProvider(v as IdpProvider)} />
        </Field>
        <RadioGroup
          label={t("How to connect")} value={conn} onChange={(v) => setConn(v as Conn)}
          options={[...(idp ? [{ value: "keep", label: t("Keep the current configuration") }] : []), { value: "url", label: t("IdP metadata URL") }, { value: "xml", label: t("IdP metadata XML") }, { value: "manual", label: t("Enter the IdP's values") }]}
        />
        {conn === "url" && <Field title={t("IdP metadata URL")}><TextInput label={t("IdP metadata URL")} value={url} onChange={setUrl} placeholder="https://" variant="outlined" /></Field>}
        {conn === "xml" && <Field title={t("IdP metadata XML")}><TextArea label={t("IdP metadata XML")} value={xml} onChange={setXml} placeholder="<EntityDescriptor …>" minRows={4} maxRows={8} /></Field>}
        {conn === "manual" && (
          <>
            <Field title={t("IdP Entity ID")}><TextInput label={t("IdP Entity ID")} value={entityId} onChange={setEntityId} variant="outlined" /></Field>
            <Field title={t("IdP SSO Target URL")}><TextInput label={t("IdP SSO Target URL")} value={ssoUrl} onChange={setSsoUrl} placeholder="https://" variant="outlined" /></Field>
            <Field title={t("Signing Certificate")}><TextArea label={t("Signing Certificate")} value={certificate} onChange={setCertificate} placeholder="-----BEGIN CERTIFICATE-----" minRows={3} maxRows={6} /></Field>
          </>
        )}
        {idp && conn !== "keep" && <div className={styles.note}>{t("A changed configuration has to be tested again before members must log in with it.")}</div>}
        <Field title={t("Domains")}>
          <div className={styles.form} data-idp-domains="">
            {verified.length === 0 && <div className={styles.note}>{t("Verify a domain in Manage domains first.")}</div>}
            {verified.map((d) => {
              const other = owner(d);
              return (
                <div key={d} className={styles.option}>
                  <Checkbox label={d} checked={domains.has(d)} onChange={(on) => setDomains((s) => { const n = new Set(s); if (on) n.add(d); else n.delete(d); return n; })} />
                  {other && <span className={styles.optionDescription}>{t("Uses {name} now; checking it moves it here.", { name: idpName(other) })}</span>}
                </div>
              );
            })}
          </div>
        </Field>
      </div>
    </Dialog>
  );
}

/** SCIM provisioning for one IdP: its base URL, the token shown once, Revoke */
function IdpScimDialog({ idp, onClose }: { idp: IdpWithScim; onClose: () => void }) {
  useT();
  const { orgId, store, run, now } = useAdmin();
  const g = store.governance!;
  const [created, setCreated] = useState<ScimTokenCreated | null>(null);
  const [confirm, setConfirm] = useState<"regenerate" | "revoke" | null>(null);
  const token = idp.scim?.token ?? null;
  const generate = async () => {
    const out = await run(() => g.generateIdpScimToken(orgId, idp.tenantId), "API token generated");
    if (out) setCreated(out);
  };
  return (
    <>
      <Dialog title={`${t("SCIM provisioning")} · ${idpName(idp)}`} open={!confirm} size="large" onClose={onClose} footer={<Button variant="primary" onClick={onClose}>{t("Done")}</Button>}>
        <div className={styles.form} data-idp-scim={idp.tenantId}>
          <div className={styles.note}>{t("This identity provider adds, updates and removes the members on its domains. SCIM never changes guests.")}</div>
          <div className={styles.kvList}>
            {idp.scim && <CopyRow label={t("SCIM base URL")} value={idp.scim.baseUrl} />}
            <CopyRow label={t("Tenant ID")} value={idp.tenantId} />
          </div>
          {created ? (
            <div className={styles.form} data-scim-token="">
              <Field title={t("API token")}><CodeBlock code={created.token} /></Field>
              <Banner tone="warning">{t("Copy this token now. You won't be able to see it again.")}</Banner>
            </div>
          ) : token ? (
            <div className={styles.kvList}>
              <CopyRow label={t("API token")} value={token.createdBy ? t("Generated {date} by {name}", { date: formatDate(token.createdAt), name: token.createdBy.name ?? token.createdBy.email }) : t("Generated {date}", { date: formatDate(token.createdAt) })} copy={false} />
              <CopyRow label={t("Last used")} value={token.lastUsedAt ? formatAgo(token.lastUsedAt, now()) : t("Never")} copy={false} />
            </div>
          ) : null}
          <div className={styles.buttonRow}>
            {token || created ? (
              <>
                <Button variant="secondary" onClick={() => setConfirm("regenerate")}>{t("Generate new token")}</Button>
                <Button variant="destructive" onClick={() => setConfirm("revoke")}>{t("Revoke")}</Button>
              </>
            ) : (
              <Button variant="primary" onClick={() => void generate()}>{t("Generate API token")}</Button>
            )}
          </div>
        </div>
      </Dialog>
      {confirm === "regenerate" && <ConfirmDialog title={t("Generate a new API token?")} confirm="Generate API token" body={t("The current token stops working at once. Paste the new one into your identity provider.")} onConfirm={() => void generate()} onClose={() => setConfirm(null)} />}
      {confirm === "revoke" && <ConfirmDialog title={t("Revoke the API token?")} destructive confirm="Revoke" body={t("This identity provider can't provision members until you generate a new token.")} onConfirm={() => void run(() => g.revokeIdpScimToken(orgId, idp.tenantId), "API token revoked").then(() => setCreated(null))} onClose={() => setConfirm(null)} />}
    </>
  );
}

// ---- IP allowlist ------------------------------------------------------------------------------------------------

/** "a, b c" → the entries as typed */
const entriesOf = (text: string) => text.split(/[\s,]+/).map((t) => t.trim()).filter(Boolean);

export function IpAllowlistDialog({ overview, onClose }: { overview: GovernanceOverview; onClose: () => void }) {
  useT();
  const { orgId, store, run } = useAdmin();
  const g = store.governance!;
  const [enabled, setEnabled] = useState(overview.ipAllowlist.enabled);
  const [text, setText] = useState(overview.ipAllowlist.ranges.map((r) => r.cidr).join(", "));
  const entries = entriesOf(text);
  const bad = entries.filter((e) => normalizeCidr(e, "allowlist") === null);
  const ranges = entries.map((e) => normalizeCidr(e, "allowlist")).filter((c): c is string => c !== null);
  const inList = ranges.some((c) => ipInCidr(overview.callerIp, c));
  const valid = bad.length === 0 && (!enabled || ranges.length > 0);
  const save = async () => {
    const out = await run(() => g.setIpAllowlist(orgId, { enabled, ranges: entries }), "IP allowlist saved");
    if (out) onClose();
  };
  return (
    <Dialog
      title={t("IP allowlist")} open size="medium" onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>{t("Cancel")}</Button>
          <Button variant="primary" disabled={!valid} onClick={() => void save()}>{t("Save")}</Button>
        </>
      }
    >
      <div className={styles.form} data-ip-allowlist="">
        <div className={styles.switchRow}>
          <span className={styles.settingText}>
            <span className={styles.settingLabel}>{t("Turn on IP allowlist")}</span>
            <span className={styles.settingDescription}>{t("Members can only reach the organization's content from these addresses. Guests and admins aren't affected. Every domain of the organization must be verified.")}</span>
          </span>
          <Switch label={t("Turn on IP allowlist")} checked={enabled} onChange={setEnabled} />
        </div>
        <Field title={t("IP addresses")}>
          <TextArea label={t("IP addresses")} value={text} onChange={setText} placeholder="192.0.2.0/24, 198.51.100.7" minRows={3} maxRows={8} />
        </Field>
        <div className={styles.note}>{t("IPv4 or IPv6 addresses and CIDR ranges, separated by commas.")}</div>
        {bad.map((b) => <div key={b} className={styles.error}>“{b}” isn't an IP address or range.</div>)}
        {enabled && entries.length === 0 && <div className={styles.error}>{t("Add at least one IP address or range.")}</div>}
        <div className={styles.kvList}>
          <CopyRow label={t("Your IP address")} value={overview.callerIp} />
        </div>
        {bad.length === 0 && ranges.length > 0 && (
          <div className={styles.note} data-caller-ip={inList ? "in" : "out"}>
            {inList ? t("Your IP address is in the list.") : t("Your IP address isn't in the list. You're an admin, so you can still reach the organization from here.")}
          </div>
        )}
      </div>
    </Dialog>
  );
}

// ---- Guest membership: 2FA for Guests, default duration -----------------------------------------------------------

/** "‹N› guests will be blocked" before 2FA for Guests is saved [G+] */
export function GuestTwoFactorDialog({ blocked, onSave, onClose }: { blocked: number; onSave: () => void; onClose: () => void }) {
  useT();
  return (
    <ConfirmDialog
      title={t("Require 2FA for guests?")} confirm="Save"
      body={
        <span data-guests-blocked={blocked}>
          {blocked === 0 ? t("No guests will be blocked: every guest uses two-factor authentication.") : tp(blocked, "{n} guest will be blocked. Guests without two-factor authentication lose access to the organization's content until they turn it on.", "{n} guests will be blocked. Guests without two-factor authentication lose access to the organization's content until they turn it on.")}
        </span>
      }
      onConfirm={onSave}
      onClose={onClose}
    />
  );
}

export function GuestExpiryDialog({ value, onSave, onClose }: { value: number | null; onSave: (days: number | null) => void; onClose: () => void }) {
  useT();
  const [mode, setMode] = useState<"none" | "days">(value === null ? "none" : "days");
  const [n, setN] = useState(String(value ?? 90));
  const days = Number(n.trim());
  const valid = mode === "none" || (n.trim() !== "" && Number.isInteger(days) && days >= 1 && days <= GUEST_EXPIRY_MAX_DAYS);
  const next = mode === "none" ? null : days;
  return (
    <Dialog
      title={t("Set default duration for guest access")} open size="medium" onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>{t("Cancel")}</Button>
          <Button variant="primary" disabled={!valid} onClick={() => { if (next !== value) onSave(next); onClose(); }}>{t("Save")}</Button>
        </>
      }
    >
      <div className={styles.form}>
        <div className={styles.note}>{t("Guests who join from now on lose access after this many days, and their seat is freed. Change a guest's date in People.")}</div>
        <RadioGroup label={t("Default duration for guest access")} value={mode} onChange={(v) => setMode(v as "none" | "days")} options={[{ value: "none", label: t("No expiration (default)") }, { value: "days", label: t("Guest access expires after") }]} />
        {mode === "days" && (
          <div className={styles.inlineRow}>
            <TextInput className={styles.numberField} label={t("Days")} value={n} onChange={setN} variant="outlined" invalid={!valid} autoFocus />
            <span className={styles.muted}>{t("days")}</span>
          </div>
        )}
        {!valid && <div className={styles.error}>{t("Choose between 1 and {max} days.", { max: GUEST_EXPIRY_MAX_DAYS.toLocaleString(intlLocale()) })}</div>}
      </div>
    </Dialog>
  );
}

// ---- File exporting ----------------------------------------------------------------------------------------------

const EXPORTING = Object.keys(FILE_EXPORTING_LABEL) as FileExporting[];

export function FileExportingDialog({ settings, onClose }: { settings: OrgSettings; onClose: () => void }) {
  useT();
  const { orgId, store, run } = useAdmin();
  const { data: workspaces } = useLoad(() => store.admin.workspaces(orgId), [orgId]);
  const [value, setValue] = useState<FileExporting>(settings.fileExporting);
  const [ws, setWs] = useState<Record<string, FileExporting | "org">>({});
  const wsValue = (w: OrgWorkspace) => ws[w.id] ?? w.sharing?.fileExporting ?? "org";
  const save = async () => {
    await run(async () => {
      if (value !== settings.fileExporting) await store.admin.updateSettings(orgId, { fileExporting: value });
      for (const w of workspaces ?? []) {
        const next = ws[w.id];
        if (next === undefined || next === (w.sharing?.fileExporting ?? "org")) continue;
        const { fileExporting: _old, ...rest } = w.sharing ?? {};
        const sharing = next === "org" ? rest : { ...rest, fileExporting: next };
        await store.admin.updateWorkspace(w.id, { sharing: Object.keys(sharing).length ? sharing : null });
      }
    }, "File exporting saved");
    onClose();
  };
  return (
    <Dialog
      title={t("File exporting")} open size="medium" onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>{t("Cancel")}</Button>
          <Button variant="primary" onClick={() => void save()}>{t("Save")}</Button>
        </>
      }
    >
      <div className={styles.form}>
        <RadioGroup label={t("File exporting")} value={value} onChange={(v) => setValue(v as FileExporting)} options={EXPORTING.map((e) => ({ value: e, label: e === "all" ? t("{label} (default)", { label: t(FILE_EXPORTING_LABEL[e]) }) : t(FILE_EXPORTING_LABEL[e]) }))} />
        <div className={styles.note}>{t("Editors can always export. Viewers who can't export can't copy layers, duplicate the file, download assets or save a local copy.")}</div>
        {(workspaces ?? []).length > 0 && (
          <div className={styles.form} data-exporting="workspaces">
            <h3 className={styles.settingsSubTitle}>{t("Custom settings for workspaces")}</h3>
            <div className={styles.note}>{t("A workspace's setting overrides the organization's for files in its teams.")}</div>
            {(workspaces ?? []).map((w) => (
              <div key={w.id} className={styles.settingRow} data-workspace-exporting={w.id}>
                <span className={styles.settingText}><span className={styles.settingLabel}>{w.name}</span></span>
                <Select
                  label={t("File exporting for {name}", { name: w.name })} width={260} value={wsValue(w)}
                  options={[{ value: "org", label: t("Organization setting ({value})", { value: t(FILE_EXPORTING_LABEL[value]) }) }, ...EXPORTING.map((e) => ({ value: e, label: t(FILE_EXPORTING_LABEL[e]) }))]}
                  onChange={(v) => setWs((s) => ({ ...s, [w.id]: v as FileExporting | "org" }))}
                />
              </div>
            ))}
          </div>
        )}
      </div>
    </Dialog>
  );
}

// ---- Network access restrictions ---------------------------------------------------------------------------------

const STATES = Object.keys(NETWORK_STATE_LABEL) as NetworkRangeState[];
export const wouldBlockText = (n: number) => tp(n, "{n} account would have been blocked in the last 7 days", "{n} accounts would have been blocked in the last 7 days");

/** A range's earliest Enforced (ms): Testing for NETWORK_TESTING_MIN_MS — since it was added, or later when known */
export const enforceableAt = (r: NetworkRange, known?: number): number | null =>
  r.state === "testing" ? Math.max(r.createdAt + NETWORK_TESTING_MIN_MS, known ?? 0) : r.state === "enforced" ? 0 : null;

/** The Status options of a range: Enforced only from Testing, 24 hours in (§2.2; the server refuses earlier with 409) */
export function rangeStateOptions(r: NetworkRange, at: number | null, now: number): SelectOption[] {
  return STATES.map((s) => {
    if (s !== "enforced" || r.state === "enforced") return { value: s, label: t(NETWORK_STATE_LABEL[s]) };
    if (at === null) return { value: s, label: t(NETWORK_STATE_LABEL[s]), disabled: true, hint: t("Set to Testing first") };
    return at > now ? { value: s, label: t(NETWORK_STATE_LABEL[s]), disabled: true, hint: t("Can be enforced after {date}", { date: formatDateTime(at) }) } : { value: s, label: t(NETWORK_STATE_LABEL[s]) };
  });
}

const formatDateTime = (ms: number) => new Date(ms).toLocaleString(intlLocale(), { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

export function NetworkRangesDialog({ onClose }: { onClose: () => void }) {
  useT();
  const { orgId, store, run, now } = useAdmin();
  const g = store.governance!;
  const { overview } = useGovernance();
  // When a range can be enforced, as the server last said (its 409's `enforceableAt`) or as set here (Testing now)
  const [known, setKnown] = useState<Readonly<Record<string, number>>>({});
  const setState = async (r: NetworkRange, state: NetworkRangeState) => {
    try {
      await g.setNetworkRange(orgId, r.id, state);
    } catch (e) {
      const at = (e as { detail?: { enforceableAt?: unknown } } | null)?.detail?.enforceableAt;
      if (typeof at === "number") setKnown((k) => ({ ...k, [r.id]: at }));
      // The 409 itself ("…enforced after at least 24 hours in testing") through run's toast
      await run(() => Promise.reject(e));
      return;
    }
    if (state === "testing") setKnown((k) => ({ ...k, [r.id]: now() + NETWORK_TESTING_MIN_MS }));
    await run(async () => undefined, `${r.cidr}: ${t(NETWORK_STATE_LABEL[state])}`);
  };
  const [cidr, setCidr] = useState("");
  const [removing, setRemoving] = useState<NetworkRange | null>(null);
  const normalized = cidr.trim() ? normalizeCidr(cidr, "network") : null;
  const add = async () => {
    if (!normalized) return;
    const out = await run(() => g.addNetworkRange(orgId, cidr.trim()), t("{range} added in Testing", { range: normalized }));
    if (out) setCidr("");
  };
  const columns: Column<NetworkRange>[] = [
    { id: "range", label: "IP range", width: "minmax(200px, 2fr)", render: (r) => <span className={styles.whoText}><span className={styles.whoName}>{r.cidr}</span><span className={styles.whoEmail} data-would-block={r.wouldBlock7d}>{wouldBlockText(r.wouldBlock7d)}</span></span> },
    {
      id: "state", label: "Status", width: 140,
      render: (r) => <Select label={t("Status of {range}", { range: r.cidr })} width={124} value={r.state} options={rangeStateOptions(r, enforceableAt(r, known[r.id]), now())} onChange={(v) => void setState(r, v as NetworkRangeState)} />,
    },
    { id: "added", label: "Added", width: 110, render: (r) => <span className={styles.muted}>{formatDate(r.createdAt)}</span> },
    { id: "menu", label: "", width: 32, align: "end", render: (r) => <RowMenu label={t("More for {name}", { name: r.cidr })} entries={[{ id: "remove", label: "Remove", danger: true }]} onSelect={() => setRemoving(r)} /> },
  ];
  return (
    <>
      <Dialog title={t("Network access restrictions")} open size="large" onClose={onClose} footer={<Button variant="primary" onClick={onClose}>{t("Done")}</Button>}>
        <div className={styles.form} data-network="">
          <div className={styles.note}>{t("Restrict external account access on this network: from these IP ranges, only accounts on the organization's domains and its guests can log in. Everyone else is asked to switch to their work account, and invites can't be accepted.")}</div>
          <div className={styles.note}>{t("A new range starts in Testing: nobody is blocked, and the count shows who would have been. Ranges are IPv4 /16 or narrower, or IPv6 /32 or narrower.")}</div>
          <div className={styles.toolbar}>
            <TextInput className={styles.search} label={t("IP range")} value={cidr} onChange={setCidr} placeholder="192.0.2.0/24" variant="outlined" invalid={cidr.trim() !== "" && !normalized} onExit={(r) => (r === "enter" ? void add() : undefined)} />
            <Button variant="secondary" disabled={!normalized} onClick={() => void add()}>{t("Add range")}</Button>
          </div>
          {cidr.trim() !== "" && !normalized && <div className={styles.error}>{t("Use an IPv4 range of /16 or narrower, or an IPv6 range of /32 or narrower.")}</div>}
          <div className={styles.inDialog}>
            <Table label={t("Network ranges")} rows={overview?.networkRanges ?? []} columns={columns} rowKey={(r) => r.id} empty="No ranges yet" />
          </div>
        </div>
      </Dialog>
      {removing && <ConfirmDialog title={t("Remove {name}?", { name: removing.cidr })} destructive confirm="Remove" body={t("People on this range are no longer restricted.")} onConfirm={() => void run(() => g.removeNetworkRange(orgId, removing.id), t("{name} removed", { name: removing.cidr }))} onClose={() => setRemoving(null)} />}
    </>
  );
}

// ---- Internal policies -------------------------------------------------------------------------------------------

const enabledNow = (p: InternalPolicy) => p.enabledAt !== null && p.disabledAt === null;

export function PoliciesDialog({ onClose }: { onClose: () => void }) {
  useT();
  const { orgId, store, run } = useAdmin();
  const g = store.governance!;
  const { data: policies } = useLoad(() => g.policies(orgId), [orgId]);
  const [creating, setCreating] = useState(false);
  const [viewing, setViewing] = useState<InternalPolicy | null>(null);
  const columns: Column<InternalPolicy>[] = [
    { id: "title", label: "Policy", width: "minmax(200px, 2fr)", render: (p) => <span className={styles.whoText}><span className={styles.whoName}>{p.title}</span><span className={styles.whoEmail}>{t(POLICY_AUDIENCE_LABEL[p.audience])} · {t(POLICY_CADENCE_LABEL[p.cadence])}</span></span> },
    { id: "agreed", label: "Agreed", width: 80, render: (p) => <span data-acknowledged={p.acknowledgedCount}>{p.acknowledgedCount}</span> },
    { id: "status", label: "Status", width: 100, render: (p) => (enabledNow(p) ? <Badge tone="success">{t("Enabled")}</Badge> : <Badge>{t("Disabled")}</Badge>) },
    {
      id: "action", label: "", width: 96, align: "end",
      render: (p) => <Button variant="secondary" onClick={() => void run(() => g.setPolicyEnabled(orgId, p.id, !enabledNow(p)), enabledNow(p) ? "Policy disabled" : "Policy enabled")}>{enabledNow(p) ? t("Disable") : t("Enable")}</Button>,
    },
  ];
  return (
    <>
      <Dialog title={t("Internal policies")} open={!creating && !viewing} size="large" onClose={onClose} footer={<Button variant="primary" onClick={onClose}>{t("Done")}</Button>}>
        <div className={styles.form} data-policies="">
          <div className={styles.note}>{t("The next time someone opens the organization's content, they see each enabled policy that applies to them and must agree to it.")}</div>
          <div className={styles.toolbar}>
            <span className={styles.spacer} />
            <Button variant="secondary" icon="24.plus.small" onClick={() => setCreating(true)}>{t("New policy")}</Button>
          </div>
          <div className={styles.inDialog}>
            <Table label={t("Internal policies")} rows={policies ?? []} columns={columns} rowKey={(p) => p.id} onRowClick={setViewing} empty="No policies yet" />
          </div>
        </div>
      </Dialog>
      {creating && <NewPolicyDialog onClose={() => setCreating(false)} />}
      {viewing && (
        <Dialog title={viewing.title} open size="medium" onClose={() => setViewing(null)} footer={<Button variant="primary" onClick={() => setViewing(null)}>{t("Done")}</Button>}>
          <div className={styles.form}>
            <div className={styles.note}>{t(POLICY_AUDIENCE_LABEL[viewing.audience])} · {t(POLICY_CADENCE_LABEL[viewing.cadence])} · {viewing.createdBy ? t("Created {date} by {name}", { date: formatDate(viewing.createdAt), name: viewing.createdBy.name ?? viewing.createdBy.email }) : t("Created {date}", { date: formatDate(viewing.createdAt) })}</div>
            <div className={styles.policyText}>{viewing.text}</div>
          </div>
        </Dialog>
      )}
    </>
  );
}

function NewPolicyDialog({ onClose }: { onClose: () => void }) {
  useT();
  const { orgId, store, run } = useAdmin();
  const g = store.governance!;
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [audience, setAudience] = useState<PolicyAudience>("everyone");
  const [cadence, setCadence] = useState<PolicyCadence>("yearly");
  const valid = title.trim() !== "" && title.trim().length <= POLICY_TITLE_MAX && text.trim() !== "" && text.length <= POLICY_TEXT_MAX;
  const create = async () => {
    const out = await run(() => g.createPolicy(orgId, { title: title.trim(), text, audience, cadence }), "Policy created");
    if (out) onClose();
  };
  return (
    <Dialog
      title={t("New policy")} open size="large" onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>{t("Cancel")}</Button>
          <Button variant="primary" disabled={!valid} onClick={() => void create()}>{t("Create policy")}</Button>
        </>
      }
    >
      <div className={styles.form}>
        <Field title={t("Title")}><TextInput label={t("Title")} value={title} onChange={setTitle} maxLength={POLICY_TITLE_MAX} variant="outlined" autoFocus /></Field>
        <Field title={t("Policy text")}><TextArea label={t("Policy text")} value={text} onChange={setText} minRows={6} maxRows={14} /></Field>
        <div className={styles.inlineRow}>
          <Field title={t("Audience")}>
            <Select label={t("Audience")} width={160} value={audience} options={(Object.keys(POLICY_AUDIENCE_LABEL) as PolicyAudience[]).map((a) => ({ value: a, label: t(POLICY_AUDIENCE_LABEL[a]) }))} onChange={(v) => setAudience(v as PolicyAudience)} />
          </Field>
          <Field title={t("Ask to agree")}>
            <Select label={t("Ask to agree")} width={160} value={cadence} options={(Object.keys(POLICY_CADENCE_LABEL) as PolicyCadence[]).map((c) => ({ value: c, label: t(POLICY_CADENCE_LABEL[c]) }))} onChange={(v) => setCadence(v as PolicyCadence)} />
          </Field>
        </div>
        {text.length > POLICY_TEXT_MAX && <div className={styles.error}>{t("The text can be at most {max} characters.", { max: POLICY_TEXT_MAX.toLocaleString(intlLocale()) })}</div>}
        <div className={styles.note}>{t("A policy can't be edited once it's created. To change one, disable it and create a new one: everyone agrees again.")}</div>
      </div>
    </Dialog>
  );
}

// ---- Key management ----------------------------------------------------------------------------------------------

export const ekmSummary = (e: EkmStatus): string =>
  !e.enabled ? t("Off") : e.state === "unavailable" ? t("Key unavailable") : e.files.encrypted < e.files.total ? `${t("On")} · ${t("{done} of {total} files encrypted", { done: e.files.encrypted, total: e.files.total })}` : t("On");

export function KeyManagementDialog({ onClose }: { onClose: () => void }) {
  useT();
  const { orgId, store, run, changed } = useAdmin();
  const g = store.governance!;
  const { data: loaded } = useLoad(() => g.ekm(orgId), [orgId]);
  const [status, setStatus] = useState<EkmStatus | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [encrypting, setEncrypting] = useState(false);
  const alive = useRef(true);
  // Set again on mount: StrictMode's dev double mount runs the cleanup once before the real mount
  useEffect(() => {
    alive.current = true;
    return () => void (alive.current = false);
  }, []);
  const st = status ?? loaded ?? null;
  if (!st) return null;
  const { total, encrypted } = st.files;
  /** `POST admin/key-management/encrypt-next` until `encrypting` is null — only while this dialog is open (§2.10) */
  const encryptAll = async (start?: EkmStatus) => {
    setEncrypting(true);
    try {
      let s = start ?? st;
      for (;;) {
        s = await g.encryptNext(orgId);
        if (!alive.current) return;
        setStatus(s);
        if (s.encrypting === null) break;
      }
      changed();
      showToast({ message: s.files.encrypted === s.files.total ? t("Every file is encrypted") : t("Some files couldn't be encrypted") });
    } catch (e) {
      if (alive.current) showToast({ message: errorParts(e).message, kind: "error" });
    } finally {
      if (alive.current) setEncrypting(false);
    }
  };
  const turnOn = async () => {
    const s = await run(() => g.enableEkm(orgId, { source: "managed" }), "Key management turned on");
    if (!s || !alive.current) return;
    setStatus(s);
    await encryptAll(s);
  };
  return (
    <>
      <Dialog
        title={t("Key management")} open={!confirming} size="medium" onClose={onClose}
        footer={
          encrypting ? (
            <Button variant="secondary" onClick={onClose}>{t("Close")}</Button>
          ) : st.enabled ? (
            <>
              {encrypted < total && <Button variant="secondary" onClick={() => void encryptAll()}>{t("Encrypt existing files")}</Button>}
              <span className={styles.spacer} />
              <Button variant="primary" onClick={onClose}>{t("Done")}</Button>
            </>
          ) : (
            <>
              <Button variant="secondary" onClick={onClose}>{t("Cancel")}</Button>
              <Button variant="primary" onClick={() => setConfirming(true)}>{t("Turn on")}</Button>
            </>
          )
        }
      >
        <div className={styles.form} data-ekm={st.enabled ? "on" : "off"}>
          <div className={styles.note}>{t("File content — checkpoints, version history, images and video — is encrypted with the organization's own key. Comments, file names and other metadata aren't. New files are encrypted at once; existing files one by one.")}</div>
          {/* ours: the managed key's limit, said plainly (docs/governance.md §2.10) */}
          <div className={styles.note} data-ekm-note="">{t("Managed keys protect the organization's stored data, but not against the server's operator, who holds the key that wraps it.")}</div>
          {st.enabled && (
            <div className={styles.kvList}>
              <CopyRow label={tx("encryption", "Key")} value={t("Managed key")} copy={false} />
              <CopyRow label={t("Status")} value={st.state === "unavailable" ? t("Unavailable: the organization's files can't be opened") : t("Available")} copy={false} />
            </div>
          )}
          {st.enabled && (encrypting || encrypted < total) && (
            <div className={styles.form} data-ekm-progress="">
              <div className={styles.progress} role="progressbar" aria-label={t("Encrypting files")} aria-valuemin={0} aria-valuemax={total} aria-valuenow={encrypted}>
                <span className={styles.progressBar} style={{ width: `${total ? (encrypted / total) * 100 : 100}%` }} />
              </div>
              <div className={styles.note}>{encrypting ? t("Encrypting files… {done} of {total}", { done: encrypted, total }) : tp(total - encrypted, "{n} file isn't encrypted yet. Each is also encrypted the next time it's opened.", "{n} files aren't encrypted yet. Each is also encrypted the next time it's opened.")}</div>
            </div>
          )}
          {st.enabled && !encrypting && encrypted === total && <div className={styles.note}>{t("Every file is encrypted.")}</div>}
          {encrypting && <div className={styles.note}>{t("Closing this stops encrypting existing files; it can be resumed.")}</div>}
          {!st.enabled && <Banner tone="warning">{t("Key management can't be turned off. While it's on, Governance+ can't be removed.")}</Banner>}
        </div>
      </Dialog>
      {confirming && (
        <ConfirmDialog
          title={t("Turn on key management?")} confirm="Turn on"
          body={t("This can't be undone: key management can't be turned off, and Governance+ can't be removed while it's on. Existing files are encrypted next.")}
          onConfirm={() => void turnOn()}
          onClose={() => setConfirming(false)}
        />
      )}
    </>
  );
}
