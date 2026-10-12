/**
 * Admin › Settings' Governance+ rows (docs/governance.md §1, §5; Phase 7 round 14h) over `GovernanceRepository`
 * (`store.governance`): Manage identity providers (IdP) — the "Identity providers" table, + Add IDP, Edit configuration
 * with the domains each serves, SCIM per IdP, More › Remove —; the IP allowlist; 2FA for Guests' confirm; Set default
 * duration for guest access; File exporting with workspace overrides; Network access restrictions; Internal policies;
 * Key management with its "Encrypting files…" loop. Figma's wording where it is published; the rest is ours (marked).
 */
import { useEffect, useRef, useState } from "react";
import { Badge, Banner, Button, Checkbox, CodeBlock, Dialog, RadioGroup, Select, Switch, TextArea, TextInput, showToast } from "@/ds";
import {
  FILE_EXPORTING_LABEL, GUEST_EXPIRY_MAX_DAYS, POLICY_AUDIENCE_LABEL, POLICY_CADENCE_LABEL, POLICY_TEXT_MAX, POLICY_TITLE_MAX,
  ipInCidr, normalizeCidr,
  type EkmStatus, type FileExporting, type GovernanceOverview, type InternalPolicy, type NetworkRange, type NetworkRangeState, type PolicyAudience, type PolicyCadence,
} from "@shared/org/governance";
import { IDP_PROVIDER_LABEL, type IdpConfig, type IdpConfigInput, type IdpProvider, type ScimTokenCreated, type ScimTokenInfo } from "@shared/org/identity";
import type { OrgSettings, OrgWorkspace } from "@shared/org/types";
import { useAdmin, useLoad } from "./context";
import { NETWORK_STATE_LABEL, formatAgo, formatDate } from "./labels";
import { ConfirmDialog, Field, RowMenu, Table, styles, type Column } from "./parts";
import { CopyRow, errorParts } from "./SettingsLogin";

/** The overview (`GET admin/governance`) — null while loading or without `store.governance` */
export function useGovernance(): { overview: GovernanceOverview | null; on: boolean; available: boolean } {
  const { orgId, store } = useAdmin();
  const g = store.governance;
  const { data } = useLoad(() => (g ? g.overview(orgId) : Promise.resolve(null)), [orgId, g]);
  return { overview: data ?? null, on: data?.governancePlus ?? false, available: Boolean(g) };
}

/** The server's per-IdP SCIM row (ours, not in the shared type: docs/governance.md §9 14a) */
type IdpWithScim = IdpConfig & { scim?: { baseUrl: string; token: ScimTokenInfo | null } };
const idpName = (i: IdpConfig) => i.name?.trim() || IDP_PROVIDER_LABEL[i.provider];

// ---- Manage identity providers (IdP) -----------------------------------------------------------------------------

export function IdpsDialog({ authMethod, onClose }: { authMethod: OrgSettings["authMethod"]; onClose: () => void }) {
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
      showToast(after?.testedAt ? { message: `${idpName(i)} works` } : { message: "The test sign-in didn't finish", kind: "error" });
    } catch (e) {
      showToast({ message: errorParts(e).message, kind: "error" });
    }
  };
  const columns: Column<IdpWithScim>[] = [
    { id: "name", label: "Name", width: "minmax(160px, 1.5fr)", render: (i) => <span className={styles.whoText}><span className={styles.whoName}>{idpName(i)}</span><span className={styles.whoEmail}>{IDP_PROVIDER_LABEL[i.provider]}</span></span> },
    { id: "domains", label: "Domains", width: "minmax(140px, 1.5fr)", render: (i) => <span className={styles.muted}>{i.domains?.length ? i.domains.join(", ") : "No domains"}</span> },
    { id: "status", label: "Status", width: 110, render: (i) => (i.testedAt ? <Badge tone="success">Tested</Badge> : <Badge tone="warning">Not tested</Badge>) },
    { id: "scim", label: "SCIM", width: 64, render: (i) => <span className={styles.muted}>{i.scim?.token ? "On" : "Off"}</span> },
    {
      id: "menu", label: "", width: 32, align: "end",
      render: (i) => (
        <RowMenu
          label={`More for ${idpName(i)}`}
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
      <Dialog title="Manage identity providers (IdP)" open={!editing && !scimOf} size="large" onClose={onClose} footer={<Button variant="primary" onClick={onClose}>Done</Button>}>
        <div className={styles.form} data-idps="">
          <div className={styles.note}>Each domain uses one identity provider; an identity provider can serve several domains. Members on domains without one log in with the organization's other allowed methods.</div>
          <div className={styles.toolbar}>
            <span className={styles.spacer} />
            <Button variant="secondary" icon="24.plus.small" onClick={() => setEditing("new")}>Add IDP</Button>
          </div>
          <div className={styles.inDialog}>
            <Table label="Identity providers" rows={list} columns={columns} rowKey={(i) => i.tenantId} empty="No identity providers yet" />
          </div>
          {authMethod === "saml" && <div className={styles.note}>Members must log in with SAML SSO: an identity provider with domains, or the only one, can't be changed or removed until they don't.</div>}
        </div>
      </Dialog>
      {editing && <IdpEditDialog idp={editing === "new" ? null : editing} idps={list} onClose={() => setEditing(null)} />}
      {scimIdp && <IdpScimDialog idp={scimIdp} onClose={() => setScimOf(null)} />}
      {removing && (
        <ConfirmDialog
          title={`Remove ${idpName(removing)}?`} destructive confirm="Remove"
          body="Its domains stop using it for SAML SSO, and its SCIM token is revoked."
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
      title={idp ? "Edit configuration" : "Add IDP"} open size="large" onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!ready} onClick={() => void save()}>{idp ? "Save" : "Add IDP"}</Button>
        </>
      }
    >
      <div className={styles.form} data-idp-edit={idp?.tenantId ?? "new"}>
        <Field title="Name">
          <TextInput label="Name" value={name} onChange={setName} placeholder="Okta (Europe)" variant="outlined" autoFocus />
        </Field>
        <Field title="Identity provider">
          <Select label="Identity provider" value={provider} disabled={conn === "keep"} options={(Object.keys(IDP_PROVIDER_LABEL) as IdpProvider[]).map((p) => ({ value: p, label: IDP_PROVIDER_LABEL[p] }))} onChange={(v) => setProvider(v as IdpProvider)} />
        </Field>
        <RadioGroup
          label="How to connect" value={conn} onChange={(v) => setConn(v as Conn)}
          options={[...(idp ? [{ value: "keep", label: "Keep the current configuration" }] : []), { value: "url", label: "IdP metadata URL" }, { value: "xml", label: "IdP metadata XML" }, { value: "manual", label: "Enter the IdP's values" }]}
        />
        {conn === "url" && <Field title="IdP metadata URL"><TextInput label="IdP metadata URL" value={url} onChange={setUrl} placeholder="https://" variant="outlined" /></Field>}
        {conn === "xml" && <Field title="IdP metadata XML"><TextArea label="IdP metadata XML" value={xml} onChange={setXml} placeholder="<EntityDescriptor …>" minRows={4} maxRows={8} /></Field>}
        {conn === "manual" && (
          <>
            <Field title="IdP Entity ID"><TextInput label="IdP Entity ID" value={entityId} onChange={setEntityId} variant="outlined" /></Field>
            <Field title="IdP SSO Target URL"><TextInput label="IdP SSO Target URL" value={ssoUrl} onChange={setSsoUrl} placeholder="https://" variant="outlined" /></Field>
            <Field title="Signing Certificate"><TextArea label="Signing Certificate" value={certificate} onChange={setCertificate} placeholder="-----BEGIN CERTIFICATE-----" minRows={3} maxRows={6} /></Field>
          </>
        )}
        {idp && conn !== "keep" && <div className={styles.note}>A changed configuration has to be tested again before members must log in with it.</div>}
        <Field title="Domains">
          <div className={styles.form} data-idp-domains="">
            {verified.length === 0 && <div className={styles.note}>Verify a domain in Manage domains first.</div>}
            {verified.map((d) => {
              const other = owner(d);
              return (
                <div key={d} className={styles.option}>
                  <Checkbox label={d} checked={domains.has(d)} onChange={(on) => setDomains((s) => { const n = new Set(s); if (on) n.add(d); else n.delete(d); return n; })} />
                  {other && <span className={styles.optionDescription}>Uses {idpName(other)} now; checking it moves it here.</span>}
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
      <Dialog title={`SCIM provisioning · ${idpName(idp)}`} open={!confirm} size="large" onClose={onClose} footer={<Button variant="primary" onClick={onClose}>Done</Button>}>
        <div className={styles.form} data-idp-scim={idp.tenantId}>
          <div className={styles.note}>This identity provider adds, updates and removes the members on its domains. SCIM never changes guests.</div>
          <div className={styles.kvList}>
            {idp.scim && <CopyRow label="SCIM base URL" value={idp.scim.baseUrl} />}
            <CopyRow label="Tenant ID" value={idp.tenantId} />
          </div>
          {created ? (
            <div className={styles.form} data-scim-token="">
              <Field title="API token"><CodeBlock code={created.token} /></Field>
              <Banner tone="warning">Copy this token now. You won't be able to see it again.</Banner>
            </div>
          ) : token ? (
            <div className={styles.kvList}>
              <CopyRow label="API token" value={`Generated ${formatDate(token.createdAt)}${token.createdBy ? ` by ${token.createdBy.name ?? token.createdBy.email}` : ""}`} copy={false} />
              <CopyRow label="Last used" value={token.lastUsedAt ? formatAgo(token.lastUsedAt, now()) : "Never"} copy={false} />
            </div>
          ) : null}
          <div className={styles.buttonRow}>
            {token || created ? (
              <>
                <Button variant="secondary" onClick={() => setConfirm("regenerate")}>Generate new token</Button>
                <Button variant="destructive" onClick={() => setConfirm("revoke")}>Revoke</Button>
              </>
            ) : (
              <Button variant="primary" onClick={() => void generate()}>Generate API token</Button>
            )}
          </div>
        </div>
      </Dialog>
      {confirm === "regenerate" && <ConfirmDialog title="Generate a new API token?" confirm="Generate API token" body="The current token stops working at once. Paste the new one into your identity provider." onConfirm={() => void generate()} onClose={() => setConfirm(null)} />}
      {confirm === "revoke" && <ConfirmDialog title="Revoke the API token?" destructive confirm="Revoke" body="This identity provider can't provision members until you generate a new token." onConfirm={() => void run(() => g.revokeIdpScimToken(orgId, idp.tenantId), "API token revoked").then(() => setCreated(null))} onClose={() => setConfirm(null)} />}
    </>
  );
}

// ---- IP allowlist ------------------------------------------------------------------------------------------------

/** "a, b c" → the entries as typed */
const entriesOf = (text: string) => text.split(/[\s,]+/).map((t) => t.trim()).filter(Boolean);

export function IpAllowlistDialog({ overview, onClose }: { overview: GovernanceOverview; onClose: () => void }) {
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
      title="IP allowlist" open size="medium" onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!valid} onClick={() => void save()}>Save</Button>
        </>
      }
    >
      <div className={styles.form} data-ip-allowlist="">
        <div className={styles.switchRow}>
          <span className={styles.settingText}>
            <span className={styles.settingLabel}>Turn on IP allowlist</span>
            <span className={styles.settingDescription}>Members can only reach the organization's content from these addresses. Guests and admins aren't affected. Every domain of the organization must be verified.</span>
          </span>
          <Switch label="Turn on IP allowlist" checked={enabled} onChange={setEnabled} />
        </div>
        <Field title="IP addresses">
          <TextArea label="IP addresses" value={text} onChange={setText} placeholder="192.0.2.0/24, 198.51.100.7" minRows={3} maxRows={8} />
        </Field>
        <div className={styles.note}>IPv4 or IPv6 addresses and CIDR ranges, separated by commas.</div>
        {bad.map((b) => <div key={b} className={styles.error}>“{b}” isn't an IP address or range.</div>)}
        {enabled && entries.length === 0 && <div className={styles.error}>Add at least one IP address or range.</div>}
        <div className={styles.kvList}>
          <CopyRow label="Your IP address" value={overview.callerIp} />
        </div>
        {bad.length === 0 && ranges.length > 0 && (
          <div className={styles.note} data-caller-ip={inList ? "in" : "out"}>
            {inList ? "Your IP address is in the list." : "Your IP address isn't in the list. You're an admin, so you can still reach the organization from here."}
          </div>
        )}
      </div>
    </Dialog>
  );
}

// ---- Guest membership: 2FA for Guests, default duration -----------------------------------------------------------

/** "‹N› guests will be blocked" before 2FA for Guests is saved [G+] */
export function GuestTwoFactorDialog({ blocked, onSave, onClose }: { blocked: number; onSave: () => void; onClose: () => void }) {
  return (
    <ConfirmDialog
      title="Require 2FA for guests?" confirm="Save"
      body={
        <span data-guests-blocked={blocked}>
          {blocked === 0 ? "No guests will be blocked: every guest uses two-factor authentication." : `${blocked === 1 ? "1 guest" : `${blocked} guests`} will be blocked. Guests without two-factor authentication lose access to the organization's content until they turn it on.`}
        </span>
      }
      onConfirm={onSave}
      onClose={onClose}
    />
  );
}

export function GuestExpiryDialog({ value, onSave, onClose }: { value: number | null; onSave: (days: number | null) => void; onClose: () => void }) {
  const [mode, setMode] = useState<"none" | "days">(value === null ? "none" : "days");
  const [n, setN] = useState(String(value ?? 90));
  const days = Number(n.trim());
  const valid = mode === "none" || (n.trim() !== "" && Number.isInteger(days) && days >= 1 && days <= GUEST_EXPIRY_MAX_DAYS);
  const next = mode === "none" ? null : days;
  return (
    <Dialog
      title="Set default duration for guest access" open size="medium" onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!valid} onClick={() => { if (next !== value) onSave(next); onClose(); }}>Save</Button>
        </>
      }
    >
      <div className={styles.form}>
        <div className={styles.note}>Guests who join from now on lose access after this many days, and their seat is freed. Change a guest's date in People.</div>
        <RadioGroup label="Default duration for guest access" value={mode} onChange={(v) => setMode(v as "none" | "days")} options={[{ value: "none", label: "No expiration (default)" }, { value: "days", label: "Guest access expires after" }]} />
        {mode === "days" && (
          <div className={styles.inlineRow}>
            <TextInput className={styles.numberField} label="Days" value={n} onChange={setN} variant="outlined" invalid={!valid} autoFocus />
            <span className={styles.muted}>days</span>
          </div>
        )}
        {!valid && <div className={styles.error}>Choose between 1 and {GUEST_EXPIRY_MAX_DAYS.toLocaleString("en-US")} days.</div>}
      </div>
    </Dialog>
  );
}

// ---- File exporting ----------------------------------------------------------------------------------------------

const EXPORTING = Object.keys(FILE_EXPORTING_LABEL) as FileExporting[];

export function FileExportingDialog({ settings, onClose }: { settings: OrgSettings; onClose: () => void }) {
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
      title="File exporting" open size="medium" onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => void save()}>Save</Button>
        </>
      }
    >
      <div className={styles.form}>
        <RadioGroup label="File exporting" value={value} onChange={(v) => setValue(v as FileExporting)} options={EXPORTING.map((e) => ({ value: e, label: e === "all" ? `${FILE_EXPORTING_LABEL[e]} (default)` : FILE_EXPORTING_LABEL[e] }))} />
        <div className={styles.note}>Editors can always export. Viewers who can't export can't copy layers, duplicate the file, download assets or save a local copy.</div>
        {(workspaces ?? []).length > 0 && (
          <div className={styles.form} data-exporting="workspaces">
            <h3 className={styles.settingsSubTitle}>Custom settings for workspaces</h3>
            <div className={styles.note}>A workspace's setting overrides the organization's for files in its teams.</div>
            {(workspaces ?? []).map((w) => (
              <div key={w.id} className={styles.settingRow} data-workspace-exporting={w.id}>
                <span className={styles.settingText}><span className={styles.settingLabel}>{w.name}</span></span>
                <Select
                  label={`File exporting for ${w.name}`} width={260} value={wsValue(w)}
                  options={[{ value: "org", label: `Organization setting (${FILE_EXPORTING_LABEL[value]})` }, ...EXPORTING.map((e) => ({ value: e, label: FILE_EXPORTING_LABEL[e] }))]}
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
export const wouldBlockText = (n: number) => `${n === 1 ? "1 account" : `${n} accounts`} would have been blocked in the last 7 days`;

export function NetworkRangesDialog({ onClose }: { onClose: () => void }) {
  const { orgId, store, run } = useAdmin();
  const g = store.governance!;
  const { overview } = useGovernance();
  const [cidr, setCidr] = useState("");
  const [removing, setRemoving] = useState<NetworkRange | null>(null);
  const normalized = cidr.trim() ? normalizeCidr(cidr, "network") : null;
  const add = async () => {
    if (!normalized) return;
    const out = await run(() => g.addNetworkRange(orgId, cidr.trim()), `${normalized} added in Testing`);
    if (out) setCidr("");
  };
  const columns: Column<NetworkRange>[] = [
    { id: "range", label: "IP range", width: "minmax(200px, 2fr)", render: (r) => <span className={styles.whoText}><span className={styles.whoName}>{r.cidr}</span><span className={styles.whoEmail} data-would-block={r.wouldBlock7d}>{wouldBlockText(r.wouldBlock7d)}</span></span> },
    {
      id: "state", label: "Status", width: 140,
      render: (r) => <Select label={`Status of ${r.cidr}`} width={124} value={r.state} options={STATES.map((s) => ({ value: s, label: NETWORK_STATE_LABEL[s] }))} onChange={(v) => void run(() => g.setNetworkRange(orgId, r.id, v as NetworkRangeState), `${r.cidr}: ${NETWORK_STATE_LABEL[v as NetworkRangeState]}`)} />,
    },
    { id: "added", label: "Added", width: 110, render: (r) => <span className={styles.muted}>{formatDate(r.createdAt)}</span> },
    { id: "menu", label: "", width: 32, align: "end", render: (r) => <RowMenu label={`More for ${r.cidr}`} entries={[{ id: "remove", label: "Remove", danger: true }]} onSelect={() => setRemoving(r)} /> },
  ];
  return (
    <>
      <Dialog title="Network access restrictions" open size="large" onClose={onClose} footer={<Button variant="primary" onClick={onClose}>Done</Button>}>
        <div className={styles.form} data-network="">
          <div className={styles.note}>Restrict external account access on this network: from these IP ranges, only accounts on the organization's domains and its guests can log in. Everyone else is asked to switch to their work account, and invites can't be accepted.</div>
          <div className={styles.note}>A new range starts in Testing: nobody is blocked, and the count shows who would have been. Ranges are IPv4 /16 or narrower, or IPv6 /32 or narrower.</div>
          <div className={styles.toolbar}>
            <TextInput className={styles.search} label="IP range" value={cidr} onChange={setCidr} placeholder="192.0.2.0/24" variant="outlined" invalid={cidr.trim() !== "" && !normalized} onExit={(r) => (r === "enter" ? void add() : undefined)} />
            <Button variant="secondary" disabled={!normalized} onClick={() => void add()}>Add range</Button>
          </div>
          {cidr.trim() !== "" && !normalized && <div className={styles.error}>Use an IPv4 range of /16 or narrower, or an IPv6 range of /32 or narrower.</div>}
          <div className={styles.inDialog}>
            <Table label="Network ranges" rows={overview?.networkRanges ?? []} columns={columns} rowKey={(r) => r.id} empty="No ranges yet" />
          </div>
        </div>
      </Dialog>
      {removing && <ConfirmDialog title={`Remove ${removing.cidr}?`} destructive confirm="Remove" body="People on this range are no longer restricted." onConfirm={() => void run(() => g.removeNetworkRange(orgId, removing.id), `${removing.cidr} removed`)} onClose={() => setRemoving(null)} />}
    </>
  );
}

// ---- Internal policies -------------------------------------------------------------------------------------------

const enabledNow = (p: InternalPolicy) => p.enabledAt !== null && p.disabledAt === null;

export function PoliciesDialog({ onClose }: { onClose: () => void }) {
  const { orgId, store, run } = useAdmin();
  const g = store.governance!;
  const { data: policies } = useLoad(() => g.policies(orgId), [orgId]);
  const [creating, setCreating] = useState(false);
  const [viewing, setViewing] = useState<InternalPolicy | null>(null);
  const columns: Column<InternalPolicy>[] = [
    { id: "title", label: "Policy", width: "minmax(200px, 2fr)", render: (p) => <span className={styles.whoText}><span className={styles.whoName}>{p.title}</span><span className={styles.whoEmail}>{POLICY_AUDIENCE_LABEL[p.audience]} · {POLICY_CADENCE_LABEL[p.cadence]}</span></span> },
    { id: "agreed", label: "Agreed", width: 80, render: (p) => <span data-acknowledged={p.acknowledgedCount}>{p.acknowledgedCount}</span> },
    { id: "status", label: "Status", width: 100, render: (p) => (enabledNow(p) ? <Badge tone="success">Enabled</Badge> : <Badge>Disabled</Badge>) },
    {
      id: "action", label: "", width: 96, align: "end",
      render: (p) => <Button variant="secondary" onClick={() => void run(() => g.setPolicyEnabled(orgId, p.id, !enabledNow(p)), enabledNow(p) ? "Policy disabled" : "Policy enabled")}>{enabledNow(p) ? "Disable" : "Enable"}</Button>,
    },
  ];
  return (
    <>
      <Dialog title="Internal policies" open={!creating && !viewing} size="large" onClose={onClose} footer={<Button variant="primary" onClick={onClose}>Done</Button>}>
        <div className={styles.form} data-policies="">
          <div className={styles.note}>The next time someone opens the organization's content, they see each enabled policy that applies to them and must agree to it.</div>
          <div className={styles.toolbar}>
            <span className={styles.spacer} />
            <Button variant="secondary" icon="24.plus.small" onClick={() => setCreating(true)}>New policy</Button>
          </div>
          <div className={styles.inDialog}>
            <Table label="Internal policies" rows={policies ?? []} columns={columns} rowKey={(p) => p.id} onRowClick={setViewing} empty="No policies yet" />
          </div>
        </div>
      </Dialog>
      {creating && <NewPolicyDialog onClose={() => setCreating(false)} />}
      {viewing && (
        <Dialog title={viewing.title} open size="medium" onClose={() => setViewing(null)} footer={<Button variant="primary" onClick={() => setViewing(null)}>Done</Button>}>
          <div className={styles.form}>
            <div className={styles.note}>{POLICY_AUDIENCE_LABEL[viewing.audience]} · {POLICY_CADENCE_LABEL[viewing.cadence]} · Created {formatDate(viewing.createdAt)}{viewing.createdBy ? ` by ${viewing.createdBy.name ?? viewing.createdBy.email}` : ""}</div>
            <div className={styles.policyText}>{viewing.text}</div>
          </div>
        </Dialog>
      )}
    </>
  );
}

function NewPolicyDialog({ onClose }: { onClose: () => void }) {
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
      title="New policy" open size="large" onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!valid} onClick={() => void create()}>Create policy</Button>
        </>
      }
    >
      <div className={styles.form}>
        <Field title="Title"><TextInput label="Title" value={title} onChange={setTitle} maxLength={POLICY_TITLE_MAX} variant="outlined" autoFocus /></Field>
        <Field title="Policy text"><TextArea label="Policy text" value={text} onChange={setText} minRows={6} maxRows={14} /></Field>
        <div className={styles.inlineRow}>
          <Field title="Audience">
            <Select label="Audience" width={160} value={audience} options={(Object.keys(POLICY_AUDIENCE_LABEL) as PolicyAudience[]).map((a) => ({ value: a, label: POLICY_AUDIENCE_LABEL[a] }))} onChange={(v) => setAudience(v as PolicyAudience)} />
          </Field>
          <Field title="Ask to agree">
            <Select label="Ask to agree" width={160} value={cadence} options={(Object.keys(POLICY_CADENCE_LABEL) as PolicyCadence[]).map((c) => ({ value: c, label: POLICY_CADENCE_LABEL[c] }))} onChange={(v) => setCadence(v as PolicyCadence)} />
          </Field>
        </div>
        {text.length > POLICY_TEXT_MAX && <div className={styles.error}>The text can be at most {POLICY_TEXT_MAX.toLocaleString("en-US")} characters.</div>}
        <div className={styles.note}>A policy can't be edited once it's created. To change one, disable it and create a new one: everyone agrees again.</div>
      </div>
    </Dialog>
  );
}

// ---- Key management ----------------------------------------------------------------------------------------------

export const ekmSummary = (e: EkmStatus): string =>
  !e.enabled ? "Off" : e.state === "unavailable" ? "Key unavailable" : e.files.encrypted < e.files.total ? `On · ${e.files.encrypted} of ${e.files.total} files encrypted` : "On";

export function KeyManagementDialog({ onClose }: { onClose: () => void }) {
  const { orgId, store, run, changed } = useAdmin();
  const g = store.governance!;
  const { data: loaded } = useLoad(() => g.ekm(orgId), [orgId]);
  const [status, setStatus] = useState<EkmStatus | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [encrypting, setEncrypting] = useState(false);
  const alive = useRef(true);
  useEffect(() => () => void (alive.current = false), []);
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
      showToast({ message: s.files.encrypted === s.files.total ? "Every file is encrypted" : "Some files couldn't be encrypted" });
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
        title="Key management" open={!confirming} size="medium" onClose={onClose}
        footer={
          encrypting ? (
            <Button variant="secondary" onClick={onClose}>Close</Button>
          ) : st.enabled ? (
            <>
              {encrypted < total && <Button variant="secondary" onClick={() => void encryptAll()}>Encrypt existing files</Button>}
              <span className={styles.spacer} />
              <Button variant="primary" onClick={onClose}>Done</Button>
            </>
          ) : (
            <>
              <Button variant="secondary" onClick={onClose}>Cancel</Button>
              <Button variant="primary" onClick={() => setConfirming(true)}>Turn on</Button>
            </>
          )
        }
      >
        <div className={styles.form} data-ekm={st.enabled ? "on" : "off"}>
          <div className={styles.note}>File content — checkpoints, version history, images and video — is encrypted with the organization's own key. Comments, file names and other metadata aren't. New files are encrypted at once; existing files one by one.</div>
          {/* ours: the managed key's limit, said plainly (docs/governance.md §2.10) */}
          <div className={styles.note} data-ekm-note="">Managed keys protect the organization's stored data, but not against the server's operator, who holds the key that wraps it.</div>
          {st.enabled && (
            <div className={styles.kvList}>
              <CopyRow label="Key" value="Managed key" copy={false} />
              <CopyRow label="Status" value={st.state === "unavailable" ? "Unavailable: the organization's files can't be opened" : "Available"} copy={false} />
            </div>
          )}
          {st.enabled && (encrypting || encrypted < total) && (
            <div className={styles.form} data-ekm-progress="">
              <div className={styles.progress} role="progressbar" aria-label="Encrypting files" aria-valuemin={0} aria-valuemax={total} aria-valuenow={encrypted}>
                <span className={styles.progressBar} style={{ width: `${total ? (encrypted / total) * 100 : 100}%` }} />
              </div>
              <div className={styles.note}>{encrypting ? `Encrypting files… ${encrypted} of ${total}` : `${total - encrypted === 1 ? "1 file isn't" : `${total - encrypted} files aren't`} encrypted yet. Each is also encrypted the next time it's opened.`}</div>
            </div>
          )}
          {st.enabled && !encrypting && encrypted === total && <div className={styles.note}>Every file is encrypted.</div>}
          {encrypting && <div className={styles.note}>Closing this stops encrypting existing files; it can be resumed.</div>}
          {!st.enabled && <Banner tone="warning">Key management can't be turned off. While it's on, Governance+ can't be removed.</Banner>}
        </div>
      </Dialog>
      {confirming && (
        <ConfirmDialog
          title="Turn on key management?" confirm="Turn on"
          body="This can't be undone: key management can't be turned off, and Governance+ can't be removed while it's on. Existing files are encrypted next."
          onConfirm={() => void turnOn()}
          onClose={() => setConfirming(false)}
        />
      )}
    </>
  );
}
