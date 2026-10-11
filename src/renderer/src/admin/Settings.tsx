/**
 * Admin › Settings (docs/multiplayer.md §15.6; research docs/research/figma/R19-admin.md §7, §10): Figma's sections —
 * Login and provisioning, Access, Team management, Content, Communication, Data, Billing, Other — each a list of rows
 * (the setting's name and description at the left, its value and Change — or a toggle — at the right). Every row is
 * live: the org's settings through `AdminRepository.updateSettings`, the login side, domains and the data region
 * through `IdentityRepository` (`store.identity`; absent, those rows say they're unavailable).
 */
import { useState, type ReactNode } from "react";
import { Button, Switch } from "@/ds";
import type { OrgSettings, Seat } from "@shared/org/types";
import { DATA_REGION_LABEL, IDLE_DEFAULT_HOURS, IDP_PROVIDER_LABEL } from "@shared/org/identity";
import { SeatApprovalDialog } from "./Dashboard";
import { useAdmin, useLoad } from "./context";
import { AUTH_METHOD_SHORT, GUEST_MEMBERSHIP_LABEL, SEATS, SEAT_APPROVAL_LABEL, SEAT_DESCRIPTION, SEAT_LABEL, TEAM_CREATION_LABEL, formatHours } from "./labels";
import { ChoiceDialog, styles } from "./parts";
import { AuthenticationDialog, DomainsDialog, IdleTimeoutDialog, SamlDialog, ScimDialog } from "./SettingsLogin";
import { DataRegionDialog, PublicSharingDialog, sharingSummary } from "./SettingsContent";
import { ApprovalDialog, PlanTokens, approvalSummary } from "./SettingsExtensions";

type Editing =
  | "authentication" | "saml" | "scim" | "idle" | "domains"
  | "guestMembership" | "teamCreation" | "groupCreation"
  | "publicSharing" | "passwordMode" | "externalContent"
  | "dataRegion"
  | "defaultSeat" | "seatApproval"
  | "pluginApproval" | "widgetApproval"
  | null;

/** Enterprise installer › Download (docs/desktop.md §12.5): there is no hosted build */
export const INSTALLER_TOOLTIP = "Built with npm run dist:msi";

export function SettingsTab() {
  const { orgId, store, run } = useAdmin();
  const { data: s } = useLoad(() => store.admin.settings(orgId), [orgId]);
  const identity = store.identity;
  const { data: ov } = useLoad(() => (identity ? identity.overview(orgId) : Promise.resolve(null)), [orgId, identity]);
  const { data: region } = useLoad(() => (identity ? identity.dataRegion(orgId) : Promise.resolve(null)), [orgId, identity]);
  const { data: workspaces } = useLoad(() => store.admin.workspaces(orgId), [orgId]);
  const [editing, setEditing] = useState<Editing>(null);
  if (!s) return null;
  const save = (patch: Partial<OrgSettings>, done = "Settings saved") => run(() => store.admin.updateSettings(orgId, patch), done);
  const close = () => setEditing(null);
  const approval = (["full", "dev", "collab"] as const).map((k) => `${SEAT_LABEL[k]}: ${SEAT_APPROVAL_LABEL[s.seatApproval[k]]}`);
  const unavailable = !identity;
  const idp = ov?.idp ?? null;
  const verified = ov?.domains.filter((d) => d.verified).length ?? 0;
  const overrides = (workspaces ?? []).filter((w) => w.sharing && Object.keys(w.sharing).length).length;
  return (
    <>
      <Group title="Login and provisioning">
        <Row
          id="authentication" label="Authentication" description="Choose how members log in. Guests can always log in with Google SSO or email and password."
          value={AUTH_METHOD_SHORT[s.authMethod]} onChange={() => setEditing("authentication")}
        />
        <Row
          id="saml" label="SAML SSO" description="Let members log in through your identity provider."
          disabled={unavailable}
          value={unavailable ? "Unavailable" : idp ? `${IDP_PROVIDER_LABEL[idp.provider]} · ${idp.testedAt ? "Tested" : "Not tested"}` : "Off"}
          action={idp ? "Manage" : "Configure SAML"} onChange={() => setEditing("saml")}
        />
        <Row
          id="scim" label="SCIM provisioning" description={idp || unavailable ? "Provision and deprovision members from your identity provider." : "Set up SAML SSO before SCIM provisioning."}
          disabled={unavailable || !idp}
          value={unavailable ? "Unavailable" : ov?.scim?.token ? "On" : "Off"} onChange={() => setEditing("scim")}
        />
        <Row
          id="idle" label="Idle session timeout" description="Log members out after a period of inactivity, on every device."
          value={s.idleSessionTimeoutHours === null ? `${formatHours(IDLE_DEFAULT_HOURS)} (default)` : formatHours(s.idleSessionTimeoutHours)} onChange={() => setEditing("idle")}
        />
        <Row
          id="domains" label="Manage domains" description="Add and verify the domains your organization owns, and turn on domain capture."
          disabled={unavailable}
          value={unavailable ? "Unavailable" : ov ? `${ov.domains.length === 1 ? "1 domain" : `${ov.domains.length} domains`} · ${verified} verified${ov.domainCapture ? " · Domain capture on" : ""}` : ""}
          action="Manage" onChange={() => setEditing("domains")}
        />
      </Group>

      <Group title="Access">
        <SubTitle>Guest access</SubTitle>
        <Row id="guestMembership" label="Guest membership" description="Choose who can invite external users to files, folders and teams." value={GUEST_MEMBERSHIP_LABEL[s.guestMembership]} onChange={() => setEditing("guestMembership")} />
      </Group>

      <Group title="Team management">
        <Row id="teamCreation" label="Creating teams" description="Who can create teams in the organization." value={TEAM_CREATION_LABEL[s.teamCreation]} onChange={() => setEditing("teamCreation")} />
        <Row id="groupCreation" label="Creating user groups" description="Who can create user groups in the organization." value={TEAM_CREATION_LABEL[s.groupCreation]} onChange={() => setEditing("groupCreation")} />
      </Group>

      <Group title="Content">
        <SubTitle>Sharing and publishing</SubTitle>
        <Row
          id="publicSharing" label="Public sharing" description="Control public links, passwords and link expiration for files in the organization."
          value={<span className={styles.whoText}>{sharingSummary(s).map((t) => <span key={t}>{t}</span>)}{overrides > 0 && <span>{overrides === 1 ? "1 workspace with custom settings" : `${overrides} workspaces with custom settings`}</span>}</span>}
          onChange={() => setEditing("publicSharing")}
        />
        <Row id="passwordMode" label="Password protection options" description="Choose what type of passwords can be added to files." value={s.passwordMode === "autogenerated" ? "Autogenerated passwords only" : "Any password"} onChange={() => setEditing("passwordMode")} />
        <Row
          id="openSessions" label="FigJam open sessions" description="Let anyone with the link join FigJam boards to edit them for 24 hours."
          control={<Switch label="FigJam open sessions" checked={s.openSessions} onChange={(on) => void save({ openSessions: on }, on ? "FigJam open sessions turned on" : "FigJam open sessions turned off")} />}
        />
        <SubTitle>Content access</SubTitle>
        <Row
          id="externalContent" label="Access to external content"
          description={s.domainCapture ? "Choose whether members can create, edit and comment on content outside the organization." : "Turn on domain capture to restrict access to external content."}
          disabled={!s.domainCapture && s.externalContent === "allowed"}
          value={s.externalContent === "restricted" ? "Restricted" : "Allowed"} onChange={() => setEditing("externalContent")}
        />
      </Group>

      <Group title="Communication">
        <Row
          id="cursorChat" label="Cursor chat" description="Let people send messages with their cursor in Figma Design and FigJam files."
          control={<Switch label="Cursor chat" checked={s.cursorChat} onChange={(on) => void save({ cursorChat: on }, on ? "Cursor chat turned on" : "Cursor chat turned off")} />}
        />
      </Group>

      <Group title="Data">
        <Row
          id="dataRegion" label="Data storage localization" description="Where the content of the organization's files is stored."
          disabled={unavailable}
          value={unavailable ? "Unavailable" : region ? (region.available ? DATA_REGION_LABEL[region.region] : `${DATA_REGION_LABEL[region.region]} · Not available`) : ""}
          onChange={() => setEditing("dataRegion")}
        />
      </Group>

      <Group title="Billing">
        <Row id="seatApproval" label="Seat approval settings" description="How requests for paid seats are approved." value={<span className={styles.whoText}>{approval.map((a) => <span key={a}>{a}</span>)}</span>} onChange={() => setEditing("seatApproval")} />
        <Row id="defaultSeat" label="Default seat" description="The seat new people get when they join." value={SEAT_LABEL[s.defaultSeat]} onChange={() => setEditing("defaultSeat")} />
      </Group>

      <Group title="Extensions">
        <Row
          id="pluginApproval" label="Plugin approval" description="Choose which plugins members can use in the organization's files."
          value={<span className={styles.whoText}>{approvalSummary(s, "plugin").map((t) => <span key={t}>{t}</span>)}</span>} onChange={() => setEditing("pluginApproval")}
        />
        <Row
          id="widgetApproval" label="Widget approval" description="Choose which widgets members can use in the organization's files."
          value={<span className={styles.whoText}>{approvalSummary(s, "widget").map((t) => <span key={t}>{t}</span>)}</span>} onChange={() => setEditing("widgetApproval")}
        />
      </Group>

      <Group title="Plan access tokens">
        <PlanTokens />
      </Group>

      <Group title="Other">
        <Row
          id="audio" label="Audio" description="Let members and guests talk in the organization's files."
          control={<Switch label="Audio" checked={s.audio} onChange={(on) => void save({ audio: on }, on ? "Audio turned on" : "Audio turned off")} />}
        />
        <Row
          id="installer" label="Enterprise installer" description="An MSI installer that installs the desktop app for every user of a Windows computer."
          control={<Button variant="secondary" disabled tooltip={INSTALLER_TOOLTIP}>Download</Button>}
        />
      </Group>

      {editing === "authentication" && <AuthenticationDialog value={s.authMethod} idp={idp} onSave={(v) => save({ authMethod: v }, "Authentication changed")} onClose={close} />}
      {editing === "saml" && <SamlDialog authMethod={s.authMethod} onClose={close} />}
      {editing === "scim" && <ScimDialog onClose={close} />}
      {editing === "idle" && <IdleTimeoutDialog value={s.idleSessionTimeoutHours} onSave={(h) => save({ idleSessionTimeoutHours: h }, "Idle session timeout saved")} onClose={close} />}
      {editing === "domains" && <DomainsDialog onClose={close} />}
      {editing === "publicSharing" && <PublicSharingDialog settings={s} onClose={close} />}
      {editing === "dataRegion" && <DataRegionDialog onClose={close} />}
      {editing === "passwordMode" && (
        <ChoiceDialog
          title="Password protection options" label="Password protection options" intro="Choose what type of passwords can be added to files."
          choices={[
            { value: "any", label: "Any password", description: "People can type a password or generate one." },
            { value: "autogenerated", label: "Autogenerated passwords only", description: "Passwords are four random words generated by the app." },
          ]}
          value={s.passwordMode} onSave={(v) => save({ passwordMode: v as OrgSettings["passwordMode"] })} onClose={close}
        />
      )}
      {editing === "externalContent" && (
        <ChoiceDialog
          title="Access to external content" label="Access to external content"
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
          title="Guest membership"
          label="Guest membership"
          intro="Choose who can invite external users to files, folders and teams."
          choices={(Object.keys(GUEST_MEMBERSHIP_LABEL) as OrgSettings["guestMembership"][]).map((v) => ({ value: v, label: v === "allow" ? `${GUEST_MEMBERSHIP_LABEL[v]} (default)` : GUEST_MEMBERSHIP_LABEL[v], description: GUEST_MEMBERSHIP_DESCRIPTION[v] }))}
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
      {editing === "defaultSeat" && (
        <ChoiceDialog title="Default seat" label="Default seat" choices={SEATS.map((v) => ({ value: v, label: SEAT_LABEL[v], description: SEAT_DESCRIPTION[v] }))} value={s.defaultSeat} onSave={(v) => save({ defaultSeat: v as Seat })} onClose={close} />
      )}
      {editing === "seatApproval" && <SeatApprovalDialog onClose={close} />}
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
  return (
    <section className={styles.settingsGroup} data-settings-group={title}>
      <h2 className={styles.settingsGroupTitle}>{title}</h2>
      {children}
    </section>
  );
}

function SubTitle({ children }: { children: ReactNode }) {
  return <h3 className={styles.settingsSubTitle}>{children}</h3>;
}

function Row({ id, label, description, value, onChange, action = "Change", control, disabled }: { id: string; label: string; description: string; value?: ReactNode; onChange?: () => void; action?: string; control?: ReactNode; disabled?: boolean }) {
  return (
    <div className={styles.settingRow} data-setting={id} data-disabled={disabled || undefined}>
      <span className={styles.settingText}>
        <span className={styles.settingLabel}>{label}</span>
        <span className={styles.settingDescription}>{description}</span>
      </span>
      {value !== undefined && <span className={styles.settingValue}>{value}</span>}
      {control ?? <Button variant="secondary" disabled={disabled || !onChange} onClick={onChange}>{action}</Button>}
    </div>
  );
}
