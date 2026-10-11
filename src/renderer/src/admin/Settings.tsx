/**
 * Admin › Settings: Figma's sections with a row per setting (its name and description, the current value, Change →
 * a modal with the options and Save). Round 1 stores Access › Guest membership, Team management › Creating teams /
 * Creating user groups and Billing › Seat approval settings / Default seat; round 4's (Sharing and publishing,
 * cursor chat, audio) are shown disabled with their values.
 */
import { useState, type ReactNode } from "react";
import { Button } from "@/ds";
import type { OrgSettings, Seat } from "@shared/org/types";
import { SeatApprovalDialog } from "./Dashboard";
import { useAdmin, useLoad } from "./context";
import { GUEST_MEMBERSHIP_LABEL, SEATS, SEAT_APPROVAL_LABEL, SEAT_DESCRIPTION, SEAT_LABEL, TEAM_CREATION_LABEL } from "./labels";
import { ChoiceDialog, styles } from "./parts";

type Editing = "guestMembership" | "teamCreation" | "groupCreation" | "defaultSeat" | "seatApproval" | null;

export function SettingsTab() {
  const { orgId, store, run } = useAdmin();
  const { data: s } = useLoad(() => store.admin.settings(orgId), [orgId]);
  const [editing, setEditing] = useState<Editing>(null);
  if (!s) return null;
  const save = (patch: Partial<OrgSettings>) => run(() => store.admin.updateSettings(orgId, patch), "Settings saved");
  const close = () => setEditing(null);
  const approval = (["full", "dev", "collab"] as const).map((k) => `${SEAT_LABEL[k]}: ${SEAT_APPROVAL_LABEL[s.seatApproval[k]]}`);
  return (
    <>
      <Group title="Access">
        <Row id="guestMembership" label="Guest membership" description="Choose who can invite external users to files, folders and teams." value={GUEST_MEMBERSHIP_LABEL[s.guestMembership]} onChange={() => setEditing("guestMembership")} />
      </Group>
      <Group title="Team management">
        <Row id="teamCreation" label="Creating teams" description="Who can create teams in the organization." value={TEAM_CREATION_LABEL[s.teamCreation]} onChange={() => setEditing("teamCreation")} />
        <Row id="groupCreation" label="Creating user groups" description="Who can create user groups in the organization." value={TEAM_CREATION_LABEL[s.groupCreation]} onChange={() => setEditing("groupCreation")} />
      </Group>
      <Group title="Billing">
        <Row id="seatApproval" label="Seat approval settings" description="How requests for paid seats are approved." value={<span className={styles.whoText}>{approval.map((a) => <span key={a}>{a}</span>)}</span>} onChange={() => setEditing("seatApproval")} />
        <Row id="defaultSeat" label="Default seat" description="The seat new people get when they join." value={SEAT_LABEL[s.defaultSeat]} onChange={() => setEditing("defaultSeat")} />
      </Group>
      <Group title="Sharing and publishing">
        <Row id="publicLinks" disabled label="Public links" description="Allow files, prototypes and boards to be shared with anyone who has the link." value={s.publicLinks ? "Allowed" : "Off"} />
        <Row id="linkExpiry" disabled label="Link expiration" description="Require links to files to expire." value={s.linkExpiryMaxHours === null ? "Not required" : `${Math.round(s.linkExpiryMaxHours / 24)} days`} />
        <Row id="passwords" disabled label="Require passwords" description="Require a password on links shared outside the organization." value={s.passwordRequired ? "Required" : "Not required"} />
      </Group>
      <Group title="Other">
        <Row id="cursorChat" disabled label="Cursor chat" description="Let people chat with their cursor in files." value={s.cursorChat ? "On" : "Off"} />
        <Row id="audio" disabled label="Audio" description="Let people talk in files with audio." value={s.audio ? "On" : "Off"} />
      </Group>

      {editing === "guestMembership" && (
        <ChoiceDialog
          title="Guest membership"
          label="Guest membership"
          intro="Choose who can invite external users to files, folders and teams."
          choices={(Object.keys(GUEST_MEMBERSHIP_LABEL) as OrgSettings["guestMembership"][]).map((v) => ({ value: v, label: v === "allow" ? `${GUEST_MEMBERSHIP_LABEL[v]} (default)` : GUEST_MEMBERSHIP_LABEL[v] }))}
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
    </>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className={styles.settingsGroup}>
      <h2 className={styles.settingsGroupTitle}>{title}</h2>
      {children}
    </section>
  );
}

function Row({ id, label, description, value, onChange, disabled }: { id: string; label: string; description: string; value: ReactNode; onChange?: () => void; disabled?: boolean }) {
  return (
    <div className={styles.settingRow} data-setting={id} data-disabled={disabled || undefined}>
      <span className={styles.settingText}>
        <span className={styles.settingLabel}>{label}</span>
        <span className={styles.settingDescription}>{description}</span>
      </span>
      <span className={styles.settingValue}>{value}</span>
      <Button variant="secondary" disabled={disabled || !onChange} onClick={onChange} tooltip={disabled ? "Available in a later update" : undefined}>Change</Button>
    </div>
  );
}
