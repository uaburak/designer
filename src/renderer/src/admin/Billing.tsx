/**
 * Admin › Billing: the plan's overview (seats by type; there is no payment here, R18 §0) and Billing groups
 * (help.figma.com 19100885191191: "Billing group" to create one with its admins; people are assigned from People;
 * deleting one sends its people back to Unassigned).
 */
import { useState } from "react";
import { Button, Dialog, TextInput } from "@/ds";
import type { BillingGroup } from "@shared/org/types";
import { useAdmin, useLoad } from "./context";
import { SEATS, SEAT_LABEL } from "./labels";
import { ConfirmDialog, Field, NameDialog, PickDialog, RowMenu, Table, byNumber, byText, personItem, styles, type Column } from "./parts";
import { t, tp, useT } from "@/i18n";

export function BillingOverview() {
  useT();
  const { orgId, store } = useAdmin();
  const { data: d } = useLoad(() => store.admin.dashboard(orgId), [orgId]);
  return (
    <>
      <section className={styles.section}>
        <div className={styles.sectionHeader}><h2 className={styles.sectionTitle}>{t("Enterprise plan")}</h2></div>
        <p className={styles.note}>{t("Seats here are permissions only: there is no billing, and every seat type is always available.")}</p>
      </section>
      <div className={styles.stats}>
        {SEATS.map((s) => (
          <div key={s} className={styles.stat} data-stat={`${SEAT_LABEL[s]} seats`}>
            <span className={styles.statValue}>{d?.seats[s] ?? "–"}</span>
            <span className={styles.statLabel}>{t("{seat} seats", { seat: t(SEAT_LABEL[s]) })}</span>
          </div>
        ))}
      </div>
    </>
  );
}

export function BillingGroupsTab() {
  useT();
  const { orgId, store, run } = useAdmin();
  const { data } = useLoad(() => store.admin.billingGroups(orgId), [orgId]);
  const { data: people } = useLoad(() => store.admin.people(orgId), [orgId]);
  const [creating, setCreating] = useState(false);
  const [dialog, setDialog] = useState<{ kind: "rename" | "admins" | "delete"; group: BillingGroup } | null>(null);
  const all = (people?.items ?? []).filter((p) => !p.pending && p.role !== "guest");
  const unassigned = (people?.items ?? []).filter((p) => p.billingGroupId === null).length;
  const columns: Column<BillingGroup>[] = [
    { id: "name", label: "Name", width: "minmax(200px, 2fr)", compare: byText((b) => b.name), render: (b) => b.name },
    { id: "admins", label: "Billing group admins", width: "minmax(200px, 2fr)", render: (b) => <span className={styles.muted}>{b.admins.map((a) => a.name ?? a.email).join(", ") || "—"}</span> },
    { id: "members", label: "Members", width: 100, compare: byNumber((b) => b.memberCount), render: (b) => b.memberCount },
    {
      id: "menu", label: "", width: 32, align: "end",
      render: (b) => <RowMenu label={t("Actions for {name}", { name: b.name })} entries={[{ id: "rename", label: "Rename" }, { id: "admins", label: "Edit billing group admins…" }, "-", { id: "delete", label: "Delete billing group", danger: true }]} onSelect={(id) => setDialog({ kind: id as "rename" | "admins" | "delete", group: b })} />,
    },
  ];
  return (
    <>
      <div className={styles.toolbar}>
        <span className={styles.muted}>{tp(unassigned, "{n} person is unassigned. Assign people from People › Change billing group.", "{n} people are unassigned. Assign people from People › Change billing group.")}</span>
        <span className={styles.spacer} />
        <Button variant="primary" icon="24.plus.small" onClick={() => setCreating(true)}>{t("Billing group")}</Button>
      </div>
      <Table label={t("Billing groups")} rows={data ?? []} columns={columns} rowKey={(b) => b.id} initialSort={{ column: "name", direction: "ascending" }} empty={t("No billing groups yet")} />
      {creating && <NewBillingGroupDialog people={all.map(personItem)} onClose={() => setCreating(false)} />}
      {dialog?.kind === "rename" && <NameDialog title={t("Rename billing group")} label={t("Billing group name")} value={dialog.group.name} confirm="Save" onSave={(name) => run(() => store.admin.updateBillingGroup(dialog.group.id, { name }))} onClose={() => setDialog(null)} />}
      {dialog?.kind === "admins" && <PickDialog title={t("Billing group admins")} items={all.map(personItem)} initial={dialog.group.admins.map((a) => a.id)} confirm="Save" onSave={(ids) => run(() => store.admin.updateBillingGroup(dialog.group.id, { adminIds: ids }), "Billing group admins saved")} onClose={() => setDialog(null)} />}
      {dialog?.kind === "delete" && <ConfirmDialog title={t("Delete {name}?", { name: dialog.group.name })} body={t("Its people go back to Unassigned, and an admin needs to assign them again.")} confirm="Delete billing group" destructive onConfirm={() => run(() => store.admin.deleteBillingGroup(dialog.group.id), t("Deleted {name}", { name: dialog.group.name }))} onClose={() => setDialog(null)} />}
    </>
  );
}

function NewBillingGroupDialog({ people, onClose }: { people: ReturnType<typeof personItem>[]; onClose: () => void }) {
  useT();
  const { orgId, store, run } = useAdmin();
  const [name, setName] = useState("");
  const [admins, setAdmins] = useState<string[]>([]);
  const [picking, setPicking] = useState(false);
  return (
    <>
      <Dialog
        title={t("Create billing group")}
        open={!picking}
        size="medium"
        onClose={onClose}
        footer={
          <>
            <Button variant="secondary" onClick={onClose}>{t("Cancel")}</Button>
            <Button variant="primary" disabled={!name.trim()} onClick={() => { void run(() => store.admin.createBillingGroup(orgId, { name: name.trim(), adminIds: admins }), t("Created {name}", { name: name.trim() })); onClose(); }}>{t("Create billing group")}</Button>
          </>
        }
      >
        <div className={styles.form}>
          <Field title={t("Name")}>
            <TextInput label={t("Billing group name")} value={name} onChange={setName} placeholder={t("Billing group name")} variant="outlined" autoFocus />
          </Field>
          <Field title={t("Billing group admins")}>
            <div className={styles.chips}>
              {admins.map((id) => <span key={id} className={styles.chip}>{people.find((p) => p.id === id)?.label}</span>)}
              <Button variant="secondary" icon="24.plus.small" onClick={() => setPicking(true)}>{admins.length ? t("Change") : t("Add admins")}</Button>
            </div>
          </Field>
        </div>
      </Dialog>
      {picking && <PickDialog title={t("Billing group admins")} items={people} initial={admins} confirm="Done" onSave={setAdmins} onClose={() => setPicking(false)} />}
    </>
  );
}
