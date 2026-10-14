/**
 * Admin › Settings (docs/multiplayer.md §15.6; research docs/research/figma/R19-admin.md §7, §10): Figma's sections —
 * Login and provisioning, External access, Team management, Content, Communication, Data, Billing, Other — each a list of rows
 * (the setting's name and description at the left, its value and Change — or a toggle — at the right). Every row is
 * live: the org's settings through `AdminRepository.updateSettings`, the login side, domains and the data region
 * through `IdentityRepository` (`store.identity`; absent, those rows say they're unavailable). Round 14h adds the
 * Governance+ rows (docs/governance.md §5, `SettingsGovernance.tsx`) over `store.governance`: each disabled with
 * "Requires Governance+" while the add-on is off, which Billing › Governance+ adds or removes.
 */
import { useState, type ReactNode } from "react";
import { Button, Switch } from "@/ds";
import { FILE_EXPORTING_LABEL, REQUIRES_GOVERNANCE_PLUS } from "@shared/org/governance";
import type { OrgSettings, Seat } from "@shared/org/types";
import { DATA_REGION_LABEL, IDLE_DEFAULT_HOURS, IDP_PROVIDER_LABEL } from "@shared/org/identity";
import { SeatApprovalDialog } from "./Dashboard";
import { useAdmin, useLoad } from "./context";
import { AUTH_METHOD_SHORT, GUEST_MEMBERSHIP_LABEL, SEATS, SEAT_APPROVAL_LABEL, SEAT_DESCRIPTION, SEAT_LABEL, TEAM_CREATION_LABEL, formatHours } from "./labels";
import { ChoiceDialog, ConfirmDialog, NameDialog, styles } from "./parts";
import { DeleteOrgDialog, IconDialog } from "@/files/orgDialogs";
import { TeamIcon } from "@/files/parts";
import { AuthenticationDialog, DomainsDialog, IdleTimeoutDialog, SamlDialog, ScimDialog } from "./SettingsLogin";
import { DataRegionDialog, PublicSharingDialog, sharingSummary } from "./SettingsContent";
import { ApprovalDialog, PlanTokens, approvalSummary } from "./SettingsExtensions";
import { CreditLimitDialog, creditLimitSummary } from "./SettingsAi";
import { FileExportingDialog, GuestExpiryDialog, GuestTwoFactorDialog, IdpsDialog, IpAllowlistDialog, KeyManagementDialog, NetworkRangesDialog, PoliciesDialog, ekmSummary, useGovernance } from "./SettingsGovernance";
import { t, tp, useT } from "@/i18n";

type Editing =
  | "orgName" | "orgIcon" | "deleteOrg"
  | "authentication" | "saml" | "scim" | "idle" | "domains"
  | "guestMembership" | "teamCreation" | "groupCreation"
  | "publicSharing" | "passwordMode" | "externalContent"
  | "dataRegion"
  | "defaultSeat" | "seatApproval"
  | "pluginApproval" | "widgetApproval"
  | "aiCreditLimit"
  // Round 14h (Governance+)
  | "idps" | "ipAllowlist" | "guestTwoFactor" | "guestExpiry" | "fileExporting" | "networkRanges" | "policies" | "keyManagement" | "removeGovernancePlus"
  | null;

/** Enterprise installer › Download (docs/desktop.md §12.5): there is no hosted build */
export const INSTALLER_TOOLTIP = "Built with npm run dist:msi";

export function SettingsTab() {
  useT();
  const { orgId, store, run } = useAdmin();
  const { data: s } = useLoad(() => store.admin.settings(orgId), [orgId]);
  const identity = store.identity;
  const { data: ov } = useLoad(() => (identity ? identity.overview(orgId) : Promise.resolve(null)), [orgId, identity]);
  const { data: region } = useLoad(() => (identity ? identity.dataRegion(orgId) : Promise.resolve(null)), [orgId, identity]);
  const { data: workspaces } = useLoad(() => store.admin.workspaces(orgId), [orgId]);
  const [editing, setEditing] = useState<Editing>(null);
  const { overview: gov, on: gp, available: govAvailable } = useGovernance();
  const governance = store.governance;
  const { data: idps } = useLoad(() => (governance && gp ? governance.idps(orgId) : Promise.resolve(null)), [orgId, governance, gp]);
  const orgs = store.orgs;
  const { data: org } = useLoad(() => (orgs ? orgs.get(orgId) : Promise.resolve(null)), [orgId, orgs]);
  if (!s) return null;
  /** A Governance+ row's value: "Unavailable" without the repository, "Requires Governance+" without the add-on */
  const gValue = (v: ReactNode) => (!govAvailable ? t("Unavailable") : !gp ? t(REQUIRES_GOVERNANCE_PLUS) : v);
  const gOff = !govAvailable || !gp;
  const exportOverrides = (workspaces ?? []).filter((w) => w.sharing?.fileExporting).length;
  const enabledPolicies = (gov?.policies ?? []).filter((p) => p.enabledAt !== null && p.disabledAt === null).length;
  const enforced = (gov?.networkRanges ?? []).filter((r) => r.state === "enforced").length;
  const save = (patch: Partial<OrgSettings>, done = "Settings saved") => run(() => store.admin.updateSettings(orgId, patch), done);
  const close = () => setEditing(null);
  const approval = (["full", "dev", "collab"] as const).map((k) => `${t(SEAT_LABEL[k])}: ${t(SEAT_APPROVAL_LABEL[s.seatApproval[k]])}`);
  const unavailable = !identity;
  const idp = ov?.idp ?? null;
  const verified = ov?.domains.filter((d) => d.verified).length ?? 0;
  const overrides = (workspaces ?? []).filter((w) => w.sharing && Object.keys(w.sharing).some((k) => k !== "fileExporting")).length;
  return (
    <>
      {/* The organization's name and icon (docs/multiplayer.md §14.16; Figma: its avatar is changed in admin settings —
          help.figma.com 4404108672663; the group and row names are ours) */}
      <Group title={t("Organization")}>
        <Row id="orgName" label={t("Organization name")} description={t("Shown in the space switcher, on Home and in invitations.")} disabled={!orgs} value={orgs ? (org?.name ?? "") : "Unavailable"} onChange={() => setEditing("orgName")} />
        <Row
          id="orgIcon" label={t("Organization icon")} description={t("Shown next to the organization's name. Use a square image; it's cropped to a square.")}
          disabled={!orgs} value={org ? <TeamIcon name={org.name} iconUrl={org.iconUrl} size={24} /> : orgs ? "" : "Unavailable"}
          onChange={() => setEditing("orgIcon")}
        />
      </Group>

      <Group title={t("Login and provisioning")}>
        <Row
          id="authentication" label={t("Authentication")} description={t("Choose how members log in. Guests can always log in with Google SSO or email and password.")}
          value={AUTH_METHOD_SHORT[s.authMethod]} onChange={() => setEditing("authentication")}
        />
        <Row
          id="idps" label={t("Manage identity providers (IdP)")} description={t("Connect several identity providers and choose the domains each one serves, each with its own SCIM provisioning.")}
          disabled={gOff} value={gValue(idps ? tp(idps.length, "{n} identity provider", "{n} identity providers") : "")}
          action="Manage" onChange={() => setEditing("idps")}
        />
        <Row
          id="saml" label="SAML SSO" description={t("Let members log in through your identity provider.")}
          disabled={unavailable}
          value={unavailable ? "Unavailable" : idp ? `${t(IDP_PROVIDER_LABEL[idp.provider])} · ${idp.testedAt ? t("Tested") : t("Not tested")}` : "Off"}
          action={idp ? "Manage" : "Configure SAML"} onChange={() => setEditing("saml")}
        />
        <Row
          id="scim" label={t("SCIM provisioning")} description={idp || unavailable ? t("Provision and deprovision members from your identity provider.") : t("Set up SAML SSO before SCIM provisioning.")}
          disabled={unavailable || !idp}
          value={unavailable ? "Unavailable" : ov?.scim?.token ? "On" : "Off"} onChange={() => setEditing("scim")}
        />
        <Row
          id="idle" label={t("Session timeout")} description={t("Log members out after a period of inactivity, on every device.")}
          value={s.idleSessionTimeoutHours === null ? t("{time} (default)", { time: formatHours(IDLE_DEFAULT_HOURS) }) : formatHours(s.idleSessionTimeoutHours)} onChange={() => setEditing("idle")}
        />
        <Row
          id="domains" label={t("Manage domains")} description={t("Add and verify the domains your organization owns, and turn on domain capture.")}
          disabled={unavailable}
          value={unavailable ? "Unavailable" : ov ? [tp(ov.domains.length, "{n} domain", "{n} domains"), t("{n} verified", { n: verified }), ...(ov.domainCapture ? [t("Domain capture on")] : [])].join(" · ") : ""}
          action="Manage" onChange={() => setEditing("domains")}
        />
        <Row
          id="ipAllowlist" label={t("IP allowlist")} description={t("Only let members reach the organization's content from these IP addresses. Guests and admins aren't affected.")}
          disabled={gOff} value={gValue(gov ? (gov.ipAllowlist.enabled ? `${t("On")} · ${tp(gov.ipAllowlist.ranges.length, "{n} address or range", "{n} addresses or ranges")}` : t("Off")) : "")}
          onChange={() => setEditing("ipAllowlist")}
        />
      </Group>

      <Group title={t("External access")}>
        <SubTitle>{t("Guest membership")}</SubTitle>
        <Row id="guestMembership" label={t("Guest membership")} description={t("Choose who can invite external users to files, folders and teams.")} value={t(GUEST_MEMBERSHIP_LABEL[s.guestMembership])} onChange={() => setEditing("guestMembership")} />
        <Row
          id="guestTwoFactor" label={t("2FA for Guests")} description={t("Guests must use two-factor authentication to open the organization's content. Guests without it are blocked until they turn it on.")}
          value={gOff ? gValue("") : undefined}
          control={<Switch label={t("2FA for Guests")} checked={!gOff && s.twoFactorForGuests} disabled={gOff} onChange={(on) => (on ? setEditing("guestTwoFactor") : void save({ twoFactorForGuests: false }, "2FA for guests turned off"))} />}
        />
        <Row
          id="guestExpiry" label={t("Set default duration for guest access")} description={t("Guests who join from now on lose access after this many days.")}
          disabled={gOff} value={gValue(s.guestExpiryDays === null ? t("No expiration") : tp(s.guestExpiryDays, "{n} day", "{n} days"))}
          onChange={() => setEditing("guestExpiry")}
        />
        <SubTitle>{t("File exporting")}</SubTitle>
        <Row
          id="fileExporting" label={t("File exporting")} description={t("Choose whether viewers can export, copy and save local copies of files. Editors can always export.")}
          disabled={gOff}
          value={gValue(<span className={styles.whoText}><span>{t(FILE_EXPORTING_LABEL[s.fileExporting])}</span>{exportOverrides > 0 && <span>{tp(exportOverrides, "{n} workspace with custom settings", "{n} workspaces with custom settings")}</span>}</span>)}
          onChange={() => setEditing("fileExporting")}
        />
        <SubTitle>{t("Network access")}</SubTitle>
        <Row
          id="networkRanges" label={t("Network access restrictions")} description={t("Restrict external account access on your networks: only the organization's accounts and guests can log in from these IP ranges.")}
          disabled={gOff} value={gValue(gov ? (gov.networkRanges.length ? `${tp(gov.networkRanges.length, "{n} range", "{n} ranges")} · ${t("{n} enforced", { n: enforced })}` : t("Off")) : "")}
          action="Manage" onChange={() => setEditing("networkRanges")}
        />
      </Group>

      <Group title={t("Team management")}>
        <Row id="teamCreation" label={t("Creating teams")} description={t("Who can create teams in the organization.")} value={t(TEAM_CREATION_LABEL[s.teamCreation])} onChange={() => setEditing("teamCreation")} />
        <Row id="groupCreation" label={t("Creating user groups")} description={t("Who can create user groups in the organization.")} value={t(TEAM_CREATION_LABEL[s.groupCreation])} onChange={() => setEditing("groupCreation")} />
      </Group>

      <Group title={t("Content")}>
        <SubTitle>{t("Sharing and publishing")}</SubTitle>
        <Row
          id="publicSharing" label={t("Public sharing")} description={t("Control public links, passwords and link expiration for files in the organization.")}
          value={<span className={styles.whoText}>{sharingSummary(s).map((line) => <span key={line}>{line}</span>)}{overrides > 0 && <span>{tp(overrides, "{n} workspace with custom settings", "{n} workspaces with custom settings")}</span>}</span>}
          onChange={() => setEditing("publicSharing")}
        />
        <Row id="passwordMode" label={t("Password protection options")} description={t("Choose what type of passwords can be added to files.")} value={s.passwordMode === "autogenerated" ? "Autogenerated passwords only" : "Any password"} onChange={() => setEditing("passwordMode")} />
        <Row
          id="openSessions" label={t("FigJam open sessions")} description={t("Let anyone with the link join FigJam boards to edit them for 24 hours.")}
          control={<Switch label={t("FigJam open sessions")} checked={s.openSessions} onChange={(on) => void save({ openSessions: on }, on ? "FigJam open sessions turned on" : "FigJam open sessions turned off")} />}
        />
        <SubTitle>{t("Content access")}</SubTitle>
        <Row
          id="externalContent" label={t("Access to external content")}
          description={s.domainCapture ? t("Choose whether members can create, edit and comment on content outside the organization.") : t("Turn on domain capture to restrict access to external content.")}
          disabled={!s.domainCapture && s.externalContent === "allowed"}
          value={s.externalContent === "restricted" ? "Restricted" : "Allowed"} onChange={() => setEditing("externalContent")}
        />
      </Group>

      <Group title={t("Communication")}>
        <Row
          id="cursorChat" label={t("Cursor chat")} description={t("Let people send messages with their cursor in Figma Design and FigJam files.")}
          control={<Switch label={t("Cursor chat")} checked={s.cursorChat} onChange={(on) => void save({ cursorChat: on }, on ? "Cursor chat turned on" : "Cursor chat turned off")} />}
        />
      </Group>

      <Group title={t("Data")}>
        <Row
          id="dataRegion" label={t("Data storage localization")} description={t("Where the content of the organization's files is stored.")}
          disabled={unavailable}
          value={unavailable ? "Unavailable" : region ? (region.available ? t(DATA_REGION_LABEL[region.region]) : `${t(DATA_REGION_LABEL[region.region])} · ${t("Not available")}`) : ""}
          onChange={() => setEditing("dataRegion")}
        />
        <Row
          id="keyManagement" label={t("Key management")} description={t("Encrypt the content of the organization's files with its own key.")}
          disabled={gOff} value={gValue(gov ? ekmSummary(gov.ekm) : "")}
          action={gov?.ekm.enabled ? "Manage" : "Turn on"} onChange={() => setEditing("keyManagement")}
        />
      </Group>

      <Group title={t("Billing")}>
        <Row id="seatApproval" label={t("Seat approval settings")} description={t("How requests for paid seats are approved.")} value={<span className={styles.whoText}>{approval.map((a) => <span key={a}>{a}</span>)}</span>} onChange={() => setEditing("seatApproval")} />
        <Row id="defaultSeat" label={t("Default seat")} description={t("The seat new people get when they join.")} value={t(SEAT_LABEL[s.defaultSeat])} onChange={() => setEditing("defaultSeat")} />
        {governance && (
          <Row
            id="governancePlus" label={t("Governance+")}
            description={t("The Enterprise add-on for security and compliance: IP allowlist, network access restrictions, 2FA for guests, multiple identity providers, internal policies, key management, Discovery, developer logs and guest expiration. There's no charge here.")}
            value={gov ? (gp ? "Added" : "Not added") : ""}
            control={
              gp ? (
                <Button variant="secondary" disabled={!gov || gov.ekm.enabled} tooltip={gov?.ekm.enabled ? t("Key management can't be turned off") : undefined} onClick={() => setEditing("removeGovernancePlus")}>{t("Remove")}</Button>
              ) : (
                <Button variant="primary" disabled={!gov} onClick={() => void run(() => governance.setGovernancePlus(orgId, true), "Governance+ added")}>{t("Add")}</Button>
              )
            }
          />
        )}
      </Group>

      <Group title={t("Extensions")}>
        <Row
          id="pluginApproval" label={t("Plugin approval")} description={t("Choose which plugins members can use in the organization's files.")}
          value={<span className={styles.whoText}>{approvalSummary(s, "plugin").map((line) => <span key={line}>{line}</span>)}</span>} onChange={() => setEditing("pluginApproval")}
        />
        <Row
          id="widgetApproval" label={t("Widget approval")} description={t("Choose which widgets members can use in the organization's files.")}
          value={<span className={styles.whoText}>{approvalSummary(s, "widget").map((line) => <span key={line}>{line}</span>)}</span>} onChange={() => setEditing("widgetApproval")}
        />
      </Group>

      <Group title="AI">
        <Row
          id="aiEnabled" label={t("AI features")} description={t("Let members use AI features — actions, image tools, visual search and agents — in the organization's files.")}
          control={<Switch label={t("AI features")} checked={s.aiEnabled} onChange={(on) => void save({ aiEnabled: on }, on ? "AI features turned on" : "AI features turned off")} />}
        />
        <Row id="aiCreditLimit" label={t("AI credit limit")} description={t("The AI credits each member can use a month.")} value={creditLimitSummary(s)} disabled={!s.aiEnabled} onChange={() => setEditing("aiCreditLimit")} />
      </Group>

      <Group title={t("Plan access tokens")}>
        <PlanTokens />
      </Group>

      <Group title={t("Other")}>
        <Row
          id="policies" label={t("Internal policies")} description={t("Ask people to agree to the organization's policies before they open its content.")}
          disabled={gOff} value={gValue(enabledPolicies ? tp(enabledPolicies, "{n} policy enabled", "{n} policies enabled") : t("Off"))}
          action="Manage" onChange={() => setEditing("policies")}
        />
        <Row
          id="discovery" label={t("Discovery")}
          description={t("Let admins export everyone's text — file content, comments, cursor chat and AI prompts — through the Discovery API. While it's on, everyone's text in the organization is recorded.")}
          value={gOff ? gValue("") : undefined}
          control={<Switch label={t("Discovery")} checked={!gOff && s.discovery} disabled={gOff} onChange={(on) => void save({ discovery: on }, on ? "Discovery turned on" : "Discovery turned off")} />}
        />
        <Row
          id="audio" label={t("Audio")} description={t("Let members and guests talk in the organization's files.")}
          control={<Switch label={t("Audio")} checked={s.audio} onChange={(on) => void save({ audio: on }, on ? "Audio turned on" : "Audio turned off")} />}
        />
        <Row
          id="installer" label={t("Enterprise installer")} description={t("An MSI installer that installs the desktop app for every user of a Windows computer.")}
          control={<Button variant="secondary" disabled tooltip={INSTALLER_TOOLTIP}>{t("Download")}</Button>}
        />
      </Group>

      {/* Ours (docs/multiplayer.md §14.17): Figma deletes an organization through its support */}
      <Group title={t("Danger zone")}>
        <Row
          id="deleteOrg" label={t("Delete organization")}
          description={t("Delete the organization with its teams, folders, files, libraries and fonts. Admins can restore it for 14 days; after that it's gone for good.")}
          disabled={!orgs || !org}
          control={<Button variant="destructive" disabled={!orgs || !org} onClick={() => setEditing("deleteOrg")}>{t("Delete organization")}</Button>}
        />
      </Group>

      {editing === "authentication" && <AuthenticationDialog value={s.authMethod} idp={idp} onSave={(v) => save({ authMethod: v }, "Authentication changed")} onClose={close} />}
      {editing === "saml" && <SamlDialog authMethod={s.authMethod} onClose={close} />}
      {editing === "scim" && <ScimDialog onClose={close} />}
      {editing === "idle" && <IdleTimeoutDialog value={s.idleSessionTimeoutHours} governancePlus={gp} onSave={(h) => save({ idleSessionTimeoutHours: h }, "Session timeout saved")} onClose={close} />}
      {editing === "idps" && <IdpsDialog authMethod={s.authMethod} onClose={close} />}
      {editing === "ipAllowlist" && gov && <IpAllowlistDialog overview={gov} onClose={close} />}
      {editing === "guestTwoFactor" && <GuestTwoFactorDialog blocked={gov?.guestsWithout2fa ?? 0} onSave={() => void save({ twoFactorForGuests: true }, "2FA for guests turned on")} onClose={close} />}
      {editing === "guestExpiry" && <GuestExpiryDialog value={s.guestExpiryDays} onSave={(d) => void save({ guestExpiryDays: d }, "Default duration for guest access saved")} onClose={close} />}
      {editing === "fileExporting" && <FileExportingDialog settings={s} onClose={close} />}
      {editing === "networkRanges" && <NetworkRangesDialog onClose={close} />}
      {editing === "policies" && <PoliciesDialog onClose={close} />}
      {editing === "keyManagement" && <KeyManagementDialog onClose={close} />}
      {editing === "removeGovernancePlus" && governance && (
        <ConfirmDialog
          title={t("Remove Governance+?")} destructive confirm="Remove"
          body={t("Its settings are kept but stop applying. A session timeout under 12 hours goes back to 12 hours.")}
          onConfirm={() => void run(() => governance.setGovernancePlus(orgId, false), "Governance+ removed")}
          onClose={close}
        />
      )}
      {editing === "domains" && <DomainsDialog onClose={close} />}
      {editing === "publicSharing" && <PublicSharingDialog settings={s} onClose={close} />}
      {editing === "dataRegion" && <DataRegionDialog onClose={close} />}
      {editing === "passwordMode" && (
        <ChoiceDialog
          title={t("Password protection options")} label={t("Password protection options")} intro="Choose what type of passwords can be added to files."
          choices={[
            { value: "any", label: "Any password", description: "People can type a password or generate one." },
            { value: "autogenerated", label: "Autogenerated passwords only", description: "Passwords are four random words generated by the app." },
          ]}
          value={s.passwordMode} onSave={(v) => save({ passwordMode: v as OrgSettings["passwordMode"] })} onClose={close}
        />
      )}
      {editing === "externalContent" && (
        <ChoiceDialog
          title={t("Access to external content")} label={t("Access to external content")}
          intro="Members on your verified domains can be kept to the organization's own files. Guests and drafts inside the organization aren't affected."
          choices={[
            { value: "allowed", label: "Allow access to external content", description: "Members can create, edit and comment on files outside the organization." },
            { value: "restricted", label: "Restrict access to external content", disabled: !s.domainCapture, description: "Members can't create files outside the organization, edit or comment on files shared from outside, or accept outside invites. Public and password-protected files open view-only." },
          ]}
          value={s.externalContent} onSave={(v) => save({ externalContent: v as OrgSettings["externalContent"] })} onClose={close}
        />
      )}
      {editing === "guestMembership" && (
        <ChoiceDialog
          title={t("Guest membership")}
          label={t("Guest membership")}
          intro="Choose who can invite external users to files, folders and teams."
          choices={(Object.keys(GUEST_MEMBERSHIP_LABEL) as OrgSettings["guestMembership"][]).map((v) => ({ value: v, label: v === "allow" ? t("{label} (default)", { label: t(GUEST_MEMBERSHIP_LABEL[v]) }) : GUEST_MEMBERSHIP_LABEL[v], description: GUEST_MEMBERSHIP_DESCRIPTION[v] }))}
          value={s.guestMembership}
          onSave={(v) => save({ guestMembership: v as OrgSettings["guestMembership"] })}
          onClose={close}
        />
      )}
      {(editing === "teamCreation" || editing === "groupCreation") && (
        <ChoiceDialog
          title={editing === "teamCreation" ? "Creating teams" : "Creating user groups"}
          label={editing === "teamCreation" ? "Creating teams" : "Creating user groups"}
          choices={[
            { value: "anyone", label: "Anyone", description: editing === "teamCreation" ? "Any member of the organization can create teams." : "Any member of the organization can create user groups." },
            { value: "admins", label: "Admins only", description: editing === "teamCreation" ? "Only organization and workspace admins can create teams." : "Only organization admins can create user groups." },
          ]}
          value={s[editing]}
          onSave={(v) => save({ [editing]: v as OrgSettings["teamCreation"] })}
          onClose={close}
        />
      )}
      {editing === "orgName" && orgs && org && (
        <NameDialog title={t("Organization name")} label={t("Organization name")} value={org.name} confirm="Save" onSave={(name) => void run(() => orgs.update(orgId, { name }), "Organization renamed")} onClose={close} />
      )}
      {editing === "orgIcon" && orgs && org && (
        <IconDialog
          title={t("Organization icon")}
          name={org.name}
          iconUrl={org.iconUrl}
          onClose={close}
          onSave={async (image) => {
            if (await run(() => orgs.setIcon(orgId, image), "Icon changed")) close();
          }}
          onRemove={async () => {
            if (await run(() => orgs.removeIcon(orgId), "Icon removed")) close();
          }}
        />
      )}
      {editing === "deleteOrg" && orgs && org && (
        <DeleteOrgDialog
          name={org.name}
          onClose={close}
          onDelete={() => {
            close();
            // Home leaves Admin for the deleted org's page (Restore) once the org reads as deleted
            void run(() => orgs.remove(orgId, org.name), t("{name} deleted", { name: org.name }));
          }}
        />
      )}
      {editing === "defaultSeat" && (
        <ChoiceDialog title={t("Default seat")} label={t("Default seat")} choices={SEATS.map((v) => ({ value: v, label: SEAT_LABEL[v], description: SEAT_DESCRIPTION[v] }))} value={s.defaultSeat} onSave={(v) => save({ defaultSeat: v as Seat })} onClose={close} />
      )}
      {editing === "seatApproval" && <SeatApprovalDialog onClose={close} />}
      {editing === "aiCreditLimit" && <CreditLimitDialog value={s.aiCreditLimit} onSave={(v) => void save({ aiCreditLimit: v }, "AI credit limit saved")} onClose={close} />}
      {(editing === "pluginApproval" || editing === "widgetApproval") && (
        <ApprovalDialog kind={editing === "widgetApproval" ? "widget" : "plugin"} settings={s} onSave={(patch) => void save(patch)} onClose={close} />
      )}
    </>
  );
}

/** [F-guestctl] what each option does (Figma's three sentences, shortened) */
const GUEST_MEMBERSHIP_DESCRIPTION: Record<OrgSettings["guestMembership"], string> = {
  allow: "Members can invite external users. They confirm before sharing with an outside email.",
  approval: "Invites to external users need an admin's approval. The guest can ask to be added; only the first invite needs approval.",
  block: "Members can't invite external users. The invite isn't sent and the inviter is told guest access is disabled.",
};

function Group({ title, children }: { title: string; children: ReactNode }) {
  useT();
  return (
    <section className={styles.settingsGroup} data-settings-group={title}>
      <h2 className={styles.settingsGroupTitle}>{title}</h2>
      {children}
    </section>
  );
}

function SubTitle({ children }: { children: ReactNode }) {
  useT();
  return <h3 className={styles.settingsSubTitle}>{children}</h3>;
}

function Row({ id, label, description, value, onChange, action = "Change", control, disabled }: { id: string; label: string; description: string; value?: ReactNode; onChange?: () => void; action?: string; control?: ReactNode; disabled?: boolean }) {
  useT();
  return (
    <div className={styles.settingRow} data-setting={id} data-disabled={disabled || undefined}>
      <span className={styles.settingText}>
        <span className={styles.settingLabel}>{t(label)}</span>
        <span className={styles.settingDescription}>{t(description)}</span>
      </span>
      {value !== undefined && <span className={styles.settingValue}>{typeof value === "string" ? t(value) : value}</span>}
      {control ?? <Button variant="secondary" disabled={disabled || !onChange} onClick={onChange}>{t(action)}</Button>}
    </div>
  );
}
