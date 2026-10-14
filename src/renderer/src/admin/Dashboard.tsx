/**
 * Admin › Dashboard: the org at a glance (members, guests, seats by type, teams, workspaces, active people) and the
 * requests waiting for an admin — seat upgrades ("View all", "Approval settings") and guests (Add / Dismiss).
 */
import { useState } from "react";
import { Button, Dialog, Select } from "@/ds";
import type { GuestRequest, OrgSettings, SeatRequest } from "@shared/org/types";
import { useAdmin, useLoad } from "./context";
import { SEATS, SEAT_APPROVAL_LABEL, SEAT_LABEL, seatLabel, formatAgo, formatDate } from "./labels";
import { Field, Table, Who, byNumber, byText, styles, type Column } from "./parts";
import { t, useT } from "@/i18n";

export function Dashboard({ onView }: { onView: (view: "seatRequests" | "guestRequests") => void }) {
  useT();
  const { orgId, store } = useAdmin();
  const { data: d } = useLoad(() => store.admin.dashboard(orgId), [orgId]);
  const { data: seat } = useLoad(() => store.admin.seatRequests(orgId, "pending"), [orgId]);
  const { data: guest } = useLoad(() => store.admin.guestRequests(orgId), [orgId]);
  const stat = (label: string, value: number | undefined) => (
    <div className={styles.stat} data-stat={label}>
      <span className={styles.statValue}>{value ?? "–"}</span>
      <span className={styles.statLabel}>{t(label)}</span>
    </div>
  );
  return (
    <>
      <div className={styles.stats}>
        {stat("Members", d?.members)}
        {stat("Guests", d?.guests)}
        {SEATS.map((s) => <span key={s} style={{ display: "contents" }}>{stat(`${SEAT_LABEL[s]} seats`, d?.seats[s])}</span>)}
        {stat("Teams", d?.teams)}
        {stat("Workspaces", d?.workspaces)}
        {stat("Active in the last 30 days", d?.activeLast30Days)}
      </div>
      <section className={styles.section}>
        <div className={styles.sectionHeader}>
          <h2 className={styles.sectionTitle}>{t("Seat requests")} <span className={styles.count}>{seat?.length ?? ""}</span></h2>
          <Button variant="ghost" onClick={() => onView("seatRequests")}>{t("View all")}</Button>
        </div>
        <SeatRequestsTable rows={(seat ?? []).slice(0, 5)} />
      </section>
      <section className={styles.section}>
        <div className={styles.sectionHeader}>
          <h2 className={styles.sectionTitle}>{t("Guest requests")} <span className={styles.count}>{guest?.length ?? ""}</span></h2>
          <Button variant="ghost" onClick={() => onView("guestRequests")}>{t("View all")}</Button>
        </div>
        <GuestRequestsTable rows={(guest ?? []).slice(0, 5)} />
      </section>
    </>
  );
}

function SeatRequestsTable({ rows, showState }: { rows: SeatRequest[]; showState?: boolean }) {
  useT();
  const { orgId, store, run, now } = useAdmin();
  const answer = (r: SeatRequest, approve: boolean) => run(() => store.admin.answerSeatRequest(orgId, r.id, approve), approve ? t("Approved {seat} seat for {name}", { seat: seatLabel(r.seat), name: r.person.name ?? r.person.email }) : t("Request denied"));
  const columns: Column<SeatRequest>[] = [
    { id: "name", label: "Name", width: "minmax(200px, 2fr)", compare: byText((r) => r.person.name ?? r.person.email), render: (r) => <Who person={r.person} /> },
    { id: "seat", label: "Requested seat", width: 120, compare: byText((r) => r.seat), render: (r) => seatLabel(r.seat) },
    { id: "note", label: "Message", render: (r) => <span className={styles.muted}>{r.note || "—"}</span> },
    { id: "date", label: "Requested", width: 120, compare: byNumber((r) => r.createdAt), render: (r) => formatAgo(r.createdAt, now()) },
    showState
      ? { id: "state", label: "Status", width: 180, render: (r) => r.state === "pending" ? <RequestButtons onAnswer={(a) => answer(r, a)} approve="Approve" deny="Deny" /> : <span className={styles.muted}>{r.state === "approved" ? t("Approved") : t("Denied")} {r.answeredAt ? formatDate(r.answeredAt) : ""}</span> }
      : { id: "actions", label: "", width: 160, align: "end", render: (r) => <RequestButtons onAnswer={(a) => answer(r, a)} approve="Approve" deny="Deny" /> },
  ];
  return <Table label={t("Seat requests")} rows={rows} columns={columns} rowKey={(r) => r.id} empty={t("No pending seat requests")} />;
}

function GuestRequestsTable({ rows }: { rows: GuestRequest[] }) {
  useT();
  const { orgId, store, run, now } = useAdmin();
  const resourceLabel = { team: "Team", project: "Folder", file: "File" } as const;
  const columns: Column<GuestRequest>[] = [
    { id: "email", label: "Guest", width: "minmax(200px, 2fr)", compare: byText((r) => r.email), render: (r) => <Who person={{ name: null, email: r.email, picture: null }} /> },
    { id: "resource", label: "Resource", compare: byText((r) => r.resource.name), render: (r) => <span>{r.resource.name} <span className={styles.muted}>{t(resourceLabel[r.resource.type])}</span></span> },
    { id: "role", label: "Access", width: 90, render: (r) => (r.role === "editor" ? t("Can edit") : t("Can view")) },
    { id: "by", label: "Invited by", compare: byText((r) => r.invitedBy.name ?? r.invitedBy.email), render: (r) => r.invitedBy.name ?? r.invitedBy.email },
    { id: "date", label: "Requested", width: 110, compare: byNumber((r) => r.createdAt), render: (r) => formatAgo(r.createdAt, now()) },
    { id: "actions", label: "", width: 150, align: "end", render: (r) => <RequestButtons onAnswer={(a) => run(() => store.admin.answerGuestRequest(orgId, r.id, a), a ? t("Added {name}", { name: r.email }) : t("Request dismissed"))} approve="Add" deny="Dismiss" /> },
  ];
  return <Table label={t("Guest requests")} rows={rows} columns={columns} rowKey={(r) => r.id} empty={t("No pending guest requests")} />;
}

function RequestButtons({ onAnswer, approve, deny }: { onAnswer: (approve: boolean) => void; approve: string; deny: string }) {
  useT();
  return (
    <span className={styles.rowActions}>
      <Button variant="secondary" onClick={() => onAnswer(false)}>{t(deny)}</Button>
      <Button variant="primary" onClick={() => onAnswer(true)}>{t(approve)}</Button>
    </span>
  );
}

/** Dashboard › Seat requests › View all: pending or every request, and "Approval settings" */
export function SeatRequestsPage() {
  useT();
  const { orgId, store } = useAdmin();
  const [all, setAll] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const { data } = useLoad(() => store.admin.seatRequests(orgId, all ? "all" : "pending"), [orgId, all]);
  return (
    <>
      <div className={styles.toolbar}>
        <Button variant={all ? "secondary" : "tinted"} onClick={() => setAll(false)}>{t("Pending")}</Button>
        <Button variant={all ? "tinted" : "secondary"} onClick={() => setAll(true)}>{t("All requests")}</Button>
        <span className={styles.spacer} />
        <Button variant="secondary" onClick={() => setSettingsOpen(true)}>{t("Approval settings")}</Button>
      </div>
      <SeatRequestsTable rows={data ?? []} showState />
      {settingsOpen && <SeatApprovalDialog onClose={() => setSettingsOpen(false)} />}
    </>
  );
}

export function GuestRequestsPage() {
  useT();
  const { orgId, store } = useAdmin();
  const { data } = useLoad(() => store.admin.guestRequests(orgId), [orgId]);
  return <GuestRequestsTable rows={data ?? []} />;
}

/** Seat approval settings: per paid seat, one of Figma's three rules */
export function SeatApprovalDialog({ onClose }: { onClose: () => void }) {
  useT();
  const { orgId, store, run } = useAdmin();
  const { data } = useLoad(() => store.admin.settings(orgId), [orgId]);
  const [draft, setDraft] = useState<OrgSettings["seatApproval"] | null>(null);
  const value = draft ?? data?.seatApproval;
  if (!value) return null;
  const rules = (Object.keys(SEAT_APPROVAL_LABEL) as Rule[]).map((v) => ({ value: v, label: t(SEAT_APPROVAL_LABEL[v]) }));
  return (
    <Dialog
      title={t("Seat approval settings")}
      open
      size="medium"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>{t("Cancel")}</Button>
          <Button variant="primary" onClick={() => { void run(() => store.admin.updateSettings(orgId, { seatApproval: value }), "Seat approval settings saved"); onClose(); }}>{t("Save")}</Button>
        </>
      }
    >
      <div className={styles.form}>
        <span className={styles.note}>{t("Choose how requests for each seat type are approved.")}</span>
        {(["full", "dev", "collab"] as const).map((seat) => (
          <Field key={seat} title={t("{seat} seat", { seat: seatLabel(seat) })}>
            <Select label={t("{seat} seat approval", { seat: seatLabel(seat) })} variant="outlined" value={value[seat]} options={rules} onChange={(v) => setDraft({ ...value, [seat]: v as Rule })} />
          </Field>
        ))}
      </div>
    </Dialog>
  );
}
type Rule = OrgSettings["seatApproval"]["full"];
