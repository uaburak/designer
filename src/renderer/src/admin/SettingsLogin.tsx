/**
 * Admin › Settings › Login and provisioning (docs/multiplayer.md §15.3–§15.8; help.figma.com [F-auth], [F-okta],
 * [F-adfs], [F-scim], [F-idle], [F-domain]): Authentication, SAML SSO (Configure SAML → Review → Configure SAML SSO;
 * the SP values with Copy; Test; Refresh metadata; Remove), SCIM provisioning (the API token shown once, Revoke),
 * Idle session timeout, Manage domains (+ Domain, the TXT record, Verify, Remove, Domain capture).
 */
import { useState, type ReactNode } from "react";
import { Badge, Banner, Button, Checkbox, CodeBlock, Dialog, IconButton, RadioGroup, Select, Switch, TextArea, TextInput, showToast } from "@/ds";
import type { OrgSettings, PersonRef } from "@shared/org/types";
import { IDLE_DEFAULT_HOURS, IDLE_MAX_HOURS, IDLE_MIN_HOURS, IDP_PROVIDER_LABEL, type IdpConfig, type IdpConfigInput, type IdpProvider, type OrgDomain, type ScimTokenCreated } from "@shared/org/identity";
import { useAdmin, useLoad } from "./context";
import { AUTH_METHOD_LABEL, formatAgo, formatDate, formatHours } from "./labels";
import { ConfirmDialog, Field, RowMenu, Table, Who, styles, type Column } from "./parts";

// ---- shared bits -----------------------------------------------------------------------------------------------------

export function copyText(text: string, message = "Copied to clipboard"): void {
  void navigator.clipboard?.writeText(text).catch(() => {});
  showToast({ message });
}

/** An error's store code and detail (StoreError's shape; the server's identity codes, §15.13) */
export function errorParts(e: unknown): { message: string; code: string | null; detail: unknown } {
  const o = (typeof e === "object" && e !== null ? e : {}) as { message?: unknown; code?: unknown; detail?: unknown; found?: unknown };
  return { message: typeof o.message === "string" ? o.message : String(e), code: typeof o.code === "string" ? o.code : null, detail: o.detail ?? (o.found ? { found: o.found } : undefined) };
}

/** A label, its value and Copy (the SP values, the SCIM base URL) */
export function CopyRow({ label, value, copy = true }: { label: string; value: ReactNode; copy?: string | boolean }) {
  const text = typeof copy === "string" ? copy : typeof value === "string" ? value : "";
  return (
    <div className={styles.kv} data-kv={label}>
      <span className={styles.kvLabel}>{label}</span>
      <span className={styles.kvValue}>{value}</span>
      {copy && text ? <IconButton icon="24.copy.small" label={`Copy ${label}`} onClick={() => copyText(text)} /> : <span />}
    </div>
  );
}

// ---- Authentication ----------------------------------------------------------------------------------------------

export function AuthenticationDialog({ value, idp, onSave, onClose }: { value: OrgSettings["authMethod"]; idp: IdpConfig | null; onSave: (v: OrgSettings["authMethod"]) => void; onClose: () => void }) {
  const [v, setV] = useState(value);
  const samlReady = Boolean(idp?.testedAt);
  return (
    <Dialog
      title="Authentication" open size="medium" onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => { if (v !== value) onSave(v); onClose(); }}>Done</Button>
        </>
      }
    >
      <div className={styles.form}>
        <RadioGroup
          label="Authentication" value={v} onChange={(x) => setV(x as OrgSettings["authMethod"])}
          options={[
            { value: "any", label: `${AUTH_METHOD_LABEL.any} (default)` },
            { value: "google", label: AUTH_METHOD_LABEL.google },
            { value: "saml", label: AUTH_METHOD_LABEL.saml, disabled: !samlReady && value !== "saml" },
          ]}
        />
        {!samlReady && value !== "saml" && <div className={styles.note} data-note="saml-untested">{idp ? "Test SAML SSO before members must log in with it." : "Configure and test SAML SSO before members must log in with it."}</div>}
        <div className={styles.note}>Guests can always log in with Google SSO or email and password. A change applies at each member's next login.</div>
      </div>
    </Dialog>
  );
}

// ---- SAML SSO ----------------------------------------------------------------------------------------------------

type Source = "url" | "xml" | "manual";
const PROVIDERS = Object.keys(IDP_PROVIDER_LABEL) as IdpProvider[];
const SIGNING_LABEL: Record<IdpConfig["signing"], string> = { assertion: "Signed assertion", assertion_or_response: "Signed assertion or response" };

export function SamlDialog({ authMethod, onClose }: { authMethod: OrgSettings["authMethod"]; onClose: () => void }) {
  const { orgId, store, run, changed, onTestSso } = useAdmin();
  const identity = store.identity!;
  const { data: ov } = useLoad(() => identity.overview(orgId), [orgId]);
  const idp = ov?.idp ?? null;
  const [mode, setMode] = useState<"view" | "configure" | "review">("view");
  const [removing, setRemoving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [form, setForm] = useState<{ provider: IdpProvider; source: Source; url: string; xml: string; entityId: string; ssoUrl: string; certificate: string; signing: IdpConfig["signing"] }>({ provider: "okta", source: "url", url: "", xml: "", entityId: "", ssoUrl: "", certificate: "", signing: "assertion" });
  const [correct, setCorrect] = useState(false);
  if (!ov) return null;
  const configuring = mode !== "view" || !idp;
  const editing = mode === "review" ? "review" : configuring ? "configure" : "view";
  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));
  const startEdit = () => {
    if (idp) set({ provider: idp.provider, source: idp.metadataUrl ? "url" : "manual", url: idp.metadataUrl ?? "", entityId: idp.idpEntityId, ssoUrl: idp.ssoUrl, signing: idp.signing });
    setCorrect(false);
    setMode("configure");
  };
  const ready = form.source === "url" ? form.url.trim() !== "" : form.source === "xml" ? form.xml.trim() !== "" : form.entityId.trim() !== "" && form.ssoUrl.trim() !== "" && form.certificate.trim() !== "";
  const input = (): IdpConfigInput => ({
    provider: form.provider, signing: form.signing,
    ...(form.source === "url" ? { metadataUrl: form.url.trim() } : form.source === "xml" ? { metadataXml: form.xml } : { idpEntityId: form.entityId.trim(), ssoUrl: form.ssoUrl.trim(), certificate: form.certificate.trim() }),
  });
  const configure = async () => {
    const out = await run(() => identity.saveIdp(orgId, input()), idp ? "SAML SSO updated" : "SAML SSO configured");
    if (out) setMode("view");
  };
  const test = async () => {
    if (!idp || !onTestSso) return;
    setTesting(true);
    try {
      await onTestSso(idp.tenantId);
      const after = await identity.overview(orgId);
      changed();
      showToast(after.idp?.testedAt ? { message: "SAML SSO works" } : { message: "The test sign-in didn't finish", kind: "error" });
    } catch (e) {
      showToast({ message: errorParts(e).message, kind: "error" });
    } finally {
      setTesting(false);
    }
  };

  let body: ReactNode;
  let footer: ReactNode;
  if (editing === "configure") {
    body = (
      <div className={styles.form} data-saml="configure">
        <Field title="Identity provider">
          <Select label="Identity provider" value={form.provider} options={PROVIDERS.map((p) => ({ value: p, label: IDP_PROVIDER_LABEL[p] }))} onChange={(v) => set({ provider: v as IdpProvider })} />
        </Field>
        <RadioGroup
          label="How to connect" value={form.source} onChange={(v) => set({ source: v as Source })}
          options={[{ value: "url", label: "IdP metadata URL" }, { value: "xml", label: "IdP metadata XML" }, { value: "manual", label: "Enter the IdP's values" }]}
        />
        {form.source === "url" && (
          <Field title="IdP metadata URL">
            <TextInput label="IdP metadata URL" value={form.url} onChange={(v) => set({ url: v })} placeholder="https://" variant="outlined" autoFocus />
          </Field>
        )}
        {form.source === "xml" && (
          <Field title="IdP metadata XML">
            <TextArea label="IdP metadata XML" value={form.xml} onChange={(v) => set({ xml: v })} placeholder="<EntityDescriptor …>" minRows={4} maxRows={8} />
          </Field>
        )}
        {form.source === "manual" && (
          <>
            <Field title="IdP Entity ID"><TextInput label="IdP Entity ID" value={form.entityId} onChange={(v) => set({ entityId: v })} variant="outlined" /></Field>
            <Field title="IdP SSO Target URL"><TextInput label="IdP SSO Target URL" value={form.ssoUrl} onChange={(v) => set({ ssoUrl: v })} placeholder="https://" variant="outlined" /></Field>
            <Field title="Signing Certificate"><TextArea label="Signing Certificate" value={form.certificate} onChange={(v) => set({ certificate: v })} placeholder="-----BEGIN CERTIFICATE-----" minRows={3} maxRows={6} /></Field>
          </>
        )}
        <Field title="Signing">
          <Select label="Signing" value={form.signing} options={(Object.keys(SIGNING_LABEL) as IdpConfig["signing"][]).map((v) => ({ value: v, label: SIGNING_LABEL[v] }))} onChange={(v) => set({ signing: v as IdpConfig["signing"] })} />
        </Field>
      </div>
    );
    footer = (
      <>
        <Button variant="secondary" onClick={() => (idp ? setMode("view") : onClose())}>Cancel</Button>
        <Button variant="primary" disabled={!ready} onClick={() => { setCorrect(false); setMode("review"); }}>Review</Button>
      </>
    );
  } else if (editing === "review") {
    const short = (t: string) => (t.length > 64 ? `${t.slice(0, 64)}…` : t);
    body = (
      <div className={styles.form} data-saml="review">
        <div className={styles.kvList}>
          <CopyRow label="Identity provider" value={IDP_PROVIDER_LABEL[form.provider]} copy={false} />
          {form.source === "url" && <CopyRow label="IdP metadata URL" value={form.url.trim()} copy={false} />}
          {form.source === "xml" && <CopyRow label="IdP metadata XML" value={short(form.xml.trim())} copy={false} />}
          {form.source === "manual" && (
            <>
              <CopyRow label="IdP Entity ID" value={form.entityId.trim()} copy={false} />
              <CopyRow label="IdP SSO Target URL" value={form.ssoUrl.trim()} copy={false} />
              <CopyRow label="Signing Certificate" value={short(form.certificate.trim())} copy={false} />
            </>
          )}
          <CopyRow label="Signing" value={SIGNING_LABEL[form.signing]} copy={false} />
        </div>
        <Checkbox label="This information is correct" checked={correct} onChange={setCorrect} />
        {idp && <div className={styles.note}>A changed configuration has to be tested again before members must log in with it.</div>}
      </div>
    );
    footer = (
      <>
        <Button variant="secondary" onClick={() => setMode("configure")}>Back</Button>
        <Button variant="primary" disabled={!correct} onClick={() => void configure()}>Configure SAML SSO</Button>
      </>
    );
  } else {
    const i = idp!;
    const cert = i.certificates[0];
    body = (
      <div className={styles.form} data-saml="view">
        <div className={styles.kvList}>
          <CopyRow label="Identity provider" value={IDP_PROVIDER_LABEL[i.provider]} copy={false} />
          <CopyRow label="Tenant ID" value={i.tenantId} />
          <CopyRow label="SP Entity ID" value={i.spEntityId} />
          <CopyRow label="SP ACS URL" value={i.spAcsUrl} />
          <CopyRow label="Start URL" value={i.startUrl} />
          <CopyRow label="IdP Entity ID" value={i.idpEntityId} copy={false} />
          <CopyRow label="IdP SSO Target URL" value={i.ssoUrl} copy={false} />
          {i.metadataUrl && <CopyRow label="IdP metadata URL" value={i.metadataUrl} copy={false} />}
          {cert && <CopyRow label="Signing Certificate" value={`${cert.subject} · Expires ${formatDate(cert.notAfter)}`} copy={false} />}
        </div>
        {i.testedAt ? (
          <div className={styles.note} data-saml-status="tested">Tested {formatDate(i.testedAt)}. Members can be required to log in with SAML SSO.</div>
        ) : (
          <Banner tone="warning" data-saml-status="untested">Not tested yet. Test SAML SSO before members must log in with it.</Banner>
        )}
        <div className={styles.note}>Members log in with SAML SSO from the login page's “Use single sign-on”, or from the start URL. Only emails on the organization's verified domains can use it.</div>
      </div>
    );
    footer = (
      <>
        <Button variant="destructive" onClick={() => setRemoving(true)} disabled={authMethod === "saml"} tooltip={authMethod === "saml" ? "Let members log in with any method first" : undefined}>Remove</Button>
        <span className={styles.spacer} />
        {i.metadataUrl && <Button variant="secondary" onClick={() => void run(() => identity.refreshIdpMetadata(orgId), "Metadata refreshed")}>Refresh metadata</Button>}
        <Button variant="secondary" onClick={startEdit}>Edit</Button>
        <Button variant="secondary" loading={testing} disabled={!onTestSso || testing} tooltip={onTestSso ? undefined : "Testing needs the desktop app"} onClick={() => void test()}>Test</Button>
        <Button variant="primary" onClick={onClose}>Done</Button>
      </>
    );
  }
  return (
    <>
      <Dialog title={editing === "view" ? "SAML SSO" : editing === "review" ? "Review SAML SSO" : "Configure SAML"} open size="large" onClose={onClose} footer={footer}>
        {body}
      </Dialog>
      {removing && (
        <ConfirmDialog
          title="Remove SAML SSO?" destructive confirm="Remove"
          body="Members will log in with Google or email and password. The SCIM provisioning token is revoked too."
          onConfirm={() => void run(() => identity.deleteIdp(orgId), "SAML SSO removed").then(() => setMode("view"))}
          onClose={() => setRemoving(false)}
        />
      )}
    </>
  );
}

// ---- SCIM provisioning -------------------------------------------------------------------------------------------

export function ScimDialog({ onClose }: { onClose: () => void }) {
  const { orgId, store, run, now } = useAdmin();
  const identity = store.identity!;
  const { data: ov } = useLoad(() => identity.overview(orgId), [orgId]);
  const [created, setCreated] = useState<ScimTokenCreated | null>(null);
  const [confirm, setConfirm] = useState<"regenerate" | "revoke" | null>(null);
  if (!ov) return null;
  const scim = ov.scim;
  const token = scim?.token ?? null;
  const generate = async () => {
    const out = await run(() => identity.generateScimToken(orgId), "API token generated");
    if (out) setCreated(out);
  };
  return (
    <>
      <Dialog title="SCIM provisioning" open size="large" onClose={onClose} footer={<Button variant="primary" onClick={onClose}>Done</Button>}>
        <div className={styles.form}>
          <div className={styles.note}>Your identity provider adds, updates and removes members, and links its groups to workspaces, billing groups and user groups. SCIM never changes guests.</div>
          {scim && ov.idp ? (
            <div className={styles.kvList}>
              <CopyRow label="SCIM base URL" value={scim.baseUrl} />
              <CopyRow label="Tenant ID" value={ov.idp.tenantId} />
            </div>
          ) : (
            <div className={styles.note}>Set up SAML SSO first.</div>
          )}
          {created ? (
            <div className={styles.form} data-scim-token="">
              <Field title="API token">
                <CodeBlock code={created.token} />
              </Field>
              <Banner tone="warning">Copy this token now. You won't be able to see it again.</Banner>
            </div>
          ) : token ? (
            <div className={styles.kvList}>
              <CopyRow label="API token" value={`Generated ${formatDate(token.createdAt)}${token.createdBy ? ` by ${token.createdBy.name ?? token.createdBy.email}` : ""}`} copy={false} />
              <CopyRow label="Last used" value={token.lastUsedAt ? formatAgo(token.lastUsedAt, now()) : "Never"} copy={false} />
            </div>
          ) : null}
          {scim && (
            <div className={styles.buttonRow}>
              {token ? (
                <>
                  <Button variant="secondary" onClick={() => setConfirm("regenerate")}>Generate new token</Button>
                  <Button variant="destructive" onClick={() => setConfirm("revoke")}>Revoke</Button>
                </>
              ) : (
                <Button variant="primary" onClick={() => void generate()}>Generate API token</Button>
              )}
            </div>
          )}
        </div>
      </Dialog>
      {confirm === "regenerate" && <ConfirmDialog title="Generate a new API token?" confirm="Generate API token" body="The current token stops working at once. Paste the new one into your identity provider." onConfirm={() => void generate()} onClose={() => setConfirm(null)} />}
      {confirm === "revoke" && <ConfirmDialog title="Revoke the API token?" destructive confirm="Revoke" body="Your identity provider can't provision members until you generate a new token." onConfirm={() => void run(() => identity.revokeScimToken(orgId), "API token revoked").then(() => setCreated(null))} onClose={() => setConfirm(null)} />}
    </>
  );
}

// ---- Idle session timeout ----------------------------------------------------------------------------------------

/** hours → the dialog's number and unit (days when whole) */
function splitHours(h: number): { n: string; unit: "hours" | "days" } {
  return h % 24 === 0 ? { n: String(h / 24), unit: "days" } : { n: String(h), unit: "hours" };
}

export function IdleTimeoutDialog({ value, onSave, onClose }: { value: number | null; onSave: (h: number | null) => void; onClose: () => void }) {
  const [mode, setMode] = useState<"default" | "custom">(value === null ? "default" : "custom");
  const init = splitHours(value ?? 7 * 24);
  const [n, setN] = useState(init.n);
  const [unit, setUnit] = useState<"hours" | "days">(init.unit);
  const num = Number(n.trim());
  const hours = Number.isFinite(num) && n.trim() !== "" ? num * (unit === "days" ? 24 : 1) : NaN;
  const valid = Number.isInteger(hours) && hours >= IDLE_MIN_HOURS && hours <= IDLE_MAX_HOURS;
  const next = mode === "default" ? null : hours;
  return (
    <Dialog
      title="Idle session timeout" open size="medium" onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={mode === "custom" && !valid} onClick={() => { if (next !== value) onSave(next); onClose(); }}>Save</Button>
        </>
      }
    >
      <div className={styles.form}>
        <div className={styles.note}>Members who are inactive this long are logged out on every device. A minute before, they can choose to stay logged in. Guests aren't affected.</div>
        <RadioGroup label="Idle session timeout" value={mode} onChange={(v) => setMode(v as "default" | "custom")} options={[{ value: "default", label: `Default (${formatHours(IDLE_DEFAULT_HOURS)})` }, { value: "custom", label: "Custom timeout" }]} />
        {mode === "custom" && (
          <div className={styles.inlineRow}>
            <TextInput className={styles.numberField} label="Timeout" value={n} onChange={setN} variant="outlined" invalid={!valid} autoFocus />
            <Select label="Unit" width={100} value={unit} options={[{ value: "hours", label: "Hours" }, { value: "days", label: "Days" }]} onChange={(v) => setUnit(v as "hours" | "days")} />
          </div>
        )}
        {mode === "custom" && !valid && <div className={styles.error}>Choose between 12 hours and 14 days.</div>}
        <div className={styles.note}>Saving resets inactivity for everyone in your organization.</div>
      </div>
    </Dialog>
  );
}

// ---- Manage domains ----------------------------------------------------------------------------------------------

export function DomainsDialog({ onClose }: { onClose: () => void }) {
  const { orgId, store, run, changed } = useAdmin();
  const identity = store.identity!;
  const { data: ov } = useLoad(() => identity.overview(orgId), [orgId]);
  const [adding, setAdding] = useState<string | null>(null);
  const [failed, setFailed] = useState<Record<string, string[]>>({});
  const [removing, setRemoving] = useState<OrgDomain | null>(null);
  const [capturing, setCapturing] = useState(false);
  const [accountsOf, setAccountsOf] = useState<string | null>(null);
  const { data: accounts } = useLoad<PersonRef[] | null>(() => (accountsOf ? identity.domainAccounts(orgId, accountsOf) : Promise.resolve(null)), [orgId, accountsOf]);
  if (!ov) return null;
  const domains = ov.domains;
  const allVerified = domains.length > 0 && domains.every((d) => d.verified);
  const verify = async (domain: string): Promise<boolean> => {
    try {
      await identity.verifyDomain(orgId, domain);
      setFailed(({ [domain]: _, ...rest }) => rest);
      changed();
      showToast({ message: `${domain} verified` });
      return true;
    } catch (e) {
      const { message, code, detail } = errorParts(e);
      if (code === "domain_unverified") {
        const found = (detail as { found?: unknown } | undefined)?.found;
        setFailed((f) => ({ ...f, [domain]: Array.isArray(found) ? found.map(String) : [] }));
      } else showToast({ message, kind: "error" });
      return false;
    }
  };
  const add = async () => {
    const text = adding?.trim() ?? "";
    if (!text) return;
    const d = await run(() => identity.addDomain(orgId, text), ov.domainCapture ? undefined : "Domain added");
    if (!d) return;
    setAdding(null);
    // With capture on, Figma's button is "Verify and add"
    if (ov.domainCapture) await verify(d.domain);
  };
  const columns: Column<OrgDomain>[] = [
    { id: "domain", label: "Domain", render: (d) => <span className={styles.whoName}>{d.domain}</span> },
    { id: "status", label: "Status", width: 120, render: (d) => (d.verified ? <Badge tone="success">Verified</Badge> : <Badge tone="warning">Unverified</Badge>) },
    { id: "added", label: "Added", width: 120, render: (d) => <span className={styles.muted}>{formatDate(d.createdAt)}</span> },
    { id: "verify", label: "", width: 88, align: "end", render: (d) => (d.verified ? null : <Button variant="secondary" onClick={() => void verify(d.domain)}>Verify</Button>) },
    {
      id: "menu", label: "", width: 32, align: "end",
      render: (d) => (
        <RowMenu
          label={`More for ${d.domain}`}
          entries={[{ id: "copy", label: "Copy TXT record" }, { id: "accounts", label: "Accounts outside the organization" }, "-", { id: "remove", label: "Remove", danger: true }]}
          onSelect={(id) => (id === "copy" ? copyText(d.txtRecord) : id === "accounts" ? setAccountsOf(d.domain) : setRemoving(d))}
        />
      ),
    },
  ];
  const unverified = domains.filter((d) => !d.verified);
  return (
    <>
      <Dialog title="Manage domains" open size="large" onClose={onClose} footer={<Button variant="primary" onClick={onClose}>Done</Button>}>
        <div className={styles.form}>
          <div className={styles.captureBanner} data-capture={ov.domainCapture ? "on" : "off"}>
            <span className={styles.settingText}>
              <span className={styles.settingLabel}>Domain capture</span>
              <span className={styles.settingDescription}>
                {allVerified || ov.domainCapture
                  ? "People with an email on your domains join the organization when they sign up. Existing accounts join as members with a View seat."
                  : "Verify every domain to turn on domain capture."}
              </span>
            </span>
            <Switch
              label="Domain capture" checked={ov.domainCapture} disabled={!ov.domainCapture && !allVerified}
              onChange={(on) => (on ? setCapturing(true) : void run(() => store.admin.updateSettings(orgId, { domainCapture: false }), "Domain capture turned off"))}
            />
          </div>
          <div className={styles.toolbar}>
            {adding === null ? (
              <Button variant="secondary" icon="24.plus.small" onClick={() => setAdding("")}>Domain</Button>
            ) : (
              <>
                <TextInput className={styles.search} label="Domain" value={adding} onChange={setAdding} placeholder="example.com" variant="outlined" autoFocus onExit={(r) => (r === "escape" ? setAdding(null) : r === "enter" ? void add() : undefined)} />
                <Button variant="secondary" onClick={() => setAdding(null)}>Cancel</Button>
                <Button variant="primary" disabled={!adding.trim()} onClick={() => void add()}>{ov.domainCapture ? "Verify and add" : "Add"}</Button>
              </>
            )}
          </div>
          <div className={styles.inDialog}>
            <Table label="Domains" rows={domains} columns={columns} rowKey={(d) => d.domain} empty="No domains yet" />
          </div>
          {unverified.map((d) => (
            <div key={d.domain} className={styles.form} data-txt={d.domain}>
              <div className={styles.note}>To verify {d.domain}, create a TXT record on it at your domain provider with this value, then click Verify. Each subdomain is verified on its own.</div>
              <CodeBlock code={d.txtRecord} />
              {failed[d.domain] && (
                <div className={styles.error} data-found={d.domain}>
                  {failed[d.domain].length === 0 ? `No TXT records were found on ${d.domain}. DNS changes can take a while to show.` : `The record wasn't found. TXT records on ${d.domain}: ${failed[d.domain].join(", ")}`}
                </div>
              )}
            </div>
          ))}
          {accountsOf && (
            <div className={styles.form} data-accounts={accountsOf}>
              <div className={styles.sectionHeader}>
                <h3 className={styles.settingsSubTitle}>Accounts on {accountsOf} outside the organization</h3>
                <Button variant="secondary" onClick={() => setAccountsOf(null)}>Hide</Button>
              </div>
              {accounts && accounts.length === 0 && <div className={styles.note}>Everyone on {accountsOf} is a member.</div>}
              {accounts?.map((p) => <Who key={p.id} person={p} />)}
            </div>
          )}
        </div>
      </Dialog>
      {removing && (
        <ConfirmDialog
          title={`Remove ${removing.domain}?`} destructive confirm="Remove"
          body={`Members whose email is on ${removing.domain} become guests.${ov.domainCapture && domains.filter((d) => d.verified && d !== removing).length === 0 ? " Domain capture turns off." : ""}`}
          onConfirm={() => void run(() => identity.removeDomain(orgId, removing.domain), "Domain removed")}
          onClose={() => setRemoving(null)}
        />
      )}
      {capturing && (
        <ConfirmDialog
          title="Turn on domain capture?" confirm="Turn on"
          body="Existing accounts with an email on your verified domains join the organization as members with a View seat, and new sign-ups join automatically."
          onConfirm={() => void run(() => store.admin.updateSettings(orgId, { domainCapture: true }), "Domain capture turned on")}
          onClose={() => setCapturing(false)}
        />
      )}
    </>
  );
}
