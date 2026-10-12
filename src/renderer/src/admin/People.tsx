/**
 * Admin › People (help.figma.com 4420842863255): the seat count at the top (each a filter), search, Filter (Seat type,
 * User type, Last active, Billing groups, Workspace), the table — name and email, Seat type, Workspace, Billing group,
 * Last active —, a row's menu, the bulk bar for the checked rows (Copy emails, Add to user group, Change seat / role /
 * workspace / billing group, Remove users from the organization), Add people and Get CSV. And › User groups.
 * Governance+ (docs/governance.md §1, §5; round 14h): the guests' "Guest access expiration date" column, Change / Remove
 * expiration date, the bulk "Set guest expiration date", and a "Blocked" badge on guests without 2FA while 2FA for
 * Guests is on.
 */
import { useMemo, useState } from "react";
import { Badge, Button, Dialog, Icon, MenuButton, SearchField, Select, TextArea, showToast, type MenuEntry } from "@/ds";
import type { AdminPerson, BillingGroup, OrgRole, OrgWorkspace, PeopleQuery, Seat, UserGroup } from "@shared/org/types";
import { useAdmin, useLoad } from "./context";
import { ROLE_LABEL, SEATS, SEAT_DESCRIPTION, SEAT_LABEL, formatAgo, formatDate } from "./labels";
import { ChoiceDialog, ConfirmDialog, Field, NameDialog, PickDialog, RowMenu, Table, Who, byNumber, byText, personItem, styles, type Column } from "./parts";
import { useGovernance } from "./SettingsGovernance";
import { GUEST_EXPIRY_MAX_DAYS } from "@shared/org/governance";

type UserTypeFilter = OrgRole | "pending";
type LastActive = "3" | "6" | "12";
interface Filters { seat?: Seat; type?: UserTypeFilter; lastActive?: LastActive; billingGroupId?: string; workspaceId?: string }
type DialogState =
  | { kind: "seat" | "role" | "workspace" | "billing" | "remove" | "group" | "expiry"; ids: string[] }
  | { kind: "add" }
  | null;

const LAST_ACTIVE_LABEL: Record<LastActive, string> = { "3": "More than 3 months ago", "6": "More than 6 months ago", "12": "More than a year ago" };
const TYPE_LABEL: Record<UserTypeFilter, string> = { admin: "Admin", member: "Member", guest: "Guest", pending: "Pending" };
const MONTH = 30 * 86_400_000;

/** The SCIM / JIT attributes a column can show (`AdminPerson.idp`, docs/multiplayer.md §15.5; the column names are ours) */
const IDP_COLUMNS: { id: string; label: string; get: (p: AdminPerson) => string }[] = [
  { id: "provisionedBy", label: "Provisioned by", get: (p) => (p.idp?.provisionedBy === "scim" ? "SCIM" : p.idp?.provisionedBy === "jit" ? "SAML (JIT)" : "") },
  { id: "title", label: "Title", get: (p) => p.idp?.title ?? "" },
  { id: "department", label: "Department", get: (p) => p.idp?.department ?? "" },
  { id: "division", label: "Division", get: (p) => p.idp?.division ?? "" },
  { id: "organization", label: "Organization", get: (p) => p.idp?.organization ?? "" },
  { id: "costCenter", label: "Cost center", get: (p) => p.idp?.costCenter ?? "" },
  { id: "employeeNumber", label: "Employee number", get: (p) => p.idp?.employeeNumber ?? "" },
  { id: "manager", label: "Manager", get: (p) => p.idp?.managerDisplayName ?? p.idp?.managerValue ?? "" },
  { id: "externalId", label: "External ID", get: (p) => p.idp?.externalId ?? "" },
];

export function PeopleTab() {
  const { orgId, store, run, exportCsv, now } = useAdmin();
  const [text, setText] = useState("");
  const [filters, setFilters] = useState<Filters>({});
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [dialog, setDialog] = useState<DialogState>(null);
  const query: PeopleQuery = {
    text: text.trim() || undefined,
    seat: filters.seat,
    role: filters.type && filters.type !== "pending" ? filters.type : undefined,
    workspaceId: filters.workspaceId,
    billingGroupId: filters.billingGroupId,
    activeBefore: filters.lastActive ? now() - Number(filters.lastActive) * MONTH : undefined,
  };
  const key = JSON.stringify(query);
  const { data: page } = useLoad(() => store.admin.people(orgId, query), [orgId, key]);
  const { data: everyone } = useLoad(() => store.admin.people(orgId), [orgId]);
  const { data: workspaces } = useLoad(() => store.admin.workspaces(orgId), [orgId]);
  const { data: billing } = useLoad(() => store.admin.billingGroups(orgId), [orgId]);
  const { data: settings } = useLoad(() => store.admin.settings(orgId), [orgId]);
  const rows = useMemo(() => (page?.items ?? []).filter((p) => (filters.type === "pending" ? p.pending : true)), [page, filters.type]);
  const { on: gp } = useGovernance();
  /** Guests without 2FA while 2FA for Guests is on [G+] */
  const blocked = (p: AdminPerson) => gp && Boolean(settings?.twoFactorForGuests) && p.role === "guest" && !p.pending && !p.twoFactor;
  const all = everyone?.items ?? [];
  const hasIdp = all.some((p) => p.idp);
  const [idpColumns, setIdpColumns] = useState<string[]>(["provisionedBy"]);
  const seatCounts = SEATS.map((s) => [s, all.filter((p) => p.seat === s && !p.pending).length] as const);
  const wsName = (id: string | null) => (id ? workspaces?.find((w) => w.id === id)?.name ?? "" : "Unassigned");
  const bgName = (id: string | null) => (id ? billing?.find((b) => b.id === id)?.name ?? "" : "Unassigned");
  const shownSelection = new Set([...selection].filter((id) => rows.some((r) => r.id === id)));
  const ids = [...shownSelection];
  const guestIds = ids.filter((id) => rows.find((r) => r.id === id)?.role === "guest");
  const update = (userIds: string[], patch: Omit<Parameters<typeof store.admin.updatePeople>[1], "userIds">, done: string) => run(() => store.admin.updatePeople(orgId, { userIds, ...patch }), done);
  const copyEmails = (list: string[]) => {
    const emails = all.filter((p) => list.includes(p.id)).map((p) => p.email).join(", ");
    void navigator.clipboard?.writeText(emails).catch(() => {});
    showToast({ message: list.length === 1 ? "Copied email" : `Copied ${list.length} emails` });
  };

  const filterEntries = (): MenuEntry[] => [
    { id: "seat", label: "Seat type", items: SEATS.map((s) => ({ id: `seat:${s}`, label: SEAT_LABEL[s], checked: filters.seat === s })) },
    { id: "type", label: "User type", items: (Object.keys(TYPE_LABEL) as UserTypeFilter[]).map((t) => ({ id: `type:${t}`, label: TYPE_LABEL[t], checked: filters.type === t })) },
    { id: "active", label: "Last active", items: [{ id: "active:all", label: "All time", checked: !filters.lastActive }, ...(Object.keys(LAST_ACTIVE_LABEL) as LastActive[]).map((m) => ({ id: `active:${m}`, label: LAST_ACTIVE_LABEL[m], checked: filters.lastActive === m }))] },
    { id: "bg", label: "Billing groups", items: [...(billing ?? []).map((b) => ({ id: `bg:${b.id}`, label: b.name, checked: filters.billingGroupId === b.id })), "-", { id: "bg:none", label: "Unassigned", checked: filters.billingGroupId === "none" }] },
    { id: "ws", label: "Workspace", items: [...(workspaces ?? []).map((w) => ({ id: `ws:${w.id}`, label: w.name, checked: filters.workspaceId === w.id })), "-", { id: "ws:none", label: "Unassigned", checked: filters.workspaceId === "none" }] },
  ];
  const pickFilter = (id: string) => {
    const [k, v] = id.split(":") as [string, string];
    setFilters((f) => {
      const toggle = <K extends keyof Filters>(key: K, val: Filters[K]) => ({ ...f, [key]: f[key] === val ? undefined : val });
      if (k === "seat") return toggle("seat", v as Seat);
      if (k === "type") return toggle("type", v as UserTypeFilter);
      if (k === "active") return { ...f, lastActive: v === "all" ? undefined : (v as LastActive) };
      if (k === "bg") return toggle("billingGroupId", v);
      if (k === "ws") return toggle("workspaceId", v);
      return f;
    });
  };
  const chips: { label: string; clear: () => void }[] = [];
  if (filters.seat) chips.push({ label: `Seat type: ${SEAT_LABEL[filters.seat]}`, clear: () => setFilters((f) => ({ ...f, seat: undefined })) });
  if (filters.type) chips.push({ label: `User type: ${TYPE_LABEL[filters.type]}`, clear: () => setFilters((f) => ({ ...f, type: undefined })) });
  if (filters.lastActive) chips.push({ label: `Last active: ${LAST_ACTIVE_LABEL[filters.lastActive]}`, clear: () => setFilters((f) => ({ ...f, lastActive: undefined })) });
  if (filters.billingGroupId) chips.push({ label: `Billing group: ${bgName(filters.billingGroupId === "none" ? null : filters.billingGroupId)}`, clear: () => setFilters((f) => ({ ...f, billingGroupId: undefined })) });
  if (filters.workspaceId) chips.push({ label: `Workspace: ${wsName(filters.workspaceId === "none" ? null : filters.workspaceId)}`, clear: () => setFilters((f) => ({ ...f, workspaceId: undefined })) });

  const rowMenu = (p: AdminPerson): MenuEntry[] => [
    { id: "seat", label: "Change seat…" },
    { id: "role", label: "Change role", items: (["admin", "member", "guest"] as OrgRole[]).map((r) => ({ id: `role:${r}`, label: ROLE_LABEL[r], checked: p.role === r })) },
    { id: "workspace", label: "Change workspace…" },
    { id: "billing", label: "Change billing group…" },
    "-",
    ...(gp && p.role === "guest" ? [{ id: "expiry", label: "Change expiration date…" }, ...(p.guestExpiresAt ? [{ id: "expiryRemove", label: "Remove expiration date" }] : [])] : []),
    "-",
    { id: "copy", label: "Copy email" },
    { id: "remove", label: "Remove from organization", danger: true },
  ];
  const onRowMenu = (p: AdminPerson, id: string) => {
    if (id.startsWith("role:")) {
      const role = id.slice(5) as OrgRole;
      return void update([p.id], { role }, `${p.name ?? p.email} is now ${role === "admin" ? "an admin" : `a ${role}`}`);
    }
    if (id === "copy") return copyEmails([p.id]);
    if (id === "expiryRemove") return void run(() => store.governance!.setGuestExpiration(orgId, [p.id], null), "Expiration date removed");
    setDialog({ kind: id as "seat" | "workspace" | "billing" | "remove" | "expiry", ids: [p.id] });
  };

  const columns: Column<AdminPerson>[] = [
    {
      id: "name", label: "Name", width: "minmax(220px, 2fr)", compare: byText((p) => p.name ?? p.email),
      render: (p) => <Who person={p} badge={<>{p.role === "admin" && <> <Badge>Admin</Badge></>}{p.role === "guest" && <> <Badge>Guest</Badge></>}{p.pending && <> <Badge tone="warning">Pending</Badge></>}{blocked(p) && <> <Badge tone="danger" data-blocked="">Blocked</Badge></>}</>} />,
    },
    {
      id: "seat", label: "Seat type", width: 110, compare: byNumber((p) => SEATS.indexOf(p.seat)),
      render: (p) => (
        <button type="button" className={styles.cellButton} aria-label={`Seat type: ${SEAT_LABEL[p.seat]}`} onClick={() => setDialog({ kind: "seat", ids: [p.id] })}>
          {SEAT_LABEL[p.seat]}
          <Icon name="16.chevron.down" />
        </button>
      ),
    },
    {
      id: "workspace", label: "Workspace", compare: byText((p) => wsName(p.workspaceId)),
      render: (p) => (
        <MenuButton label={`Workspace: ${wsName(p.workspaceId)}`} className={styles.cellButton} tooltip={false} entries={() => [...(workspaces ?? []).map((w) => ({ id: w.id, label: w.name, checked: p.workspaceId === w.id })), "-", { id: "none", label: "Unassigned", checked: p.workspaceId === null }]} onSelect={(id) => update([p.id], { workspaceId: id === "none" ? null : id }, "Workspace changed")}>
          <span className={p.workspaceId ? undefined : styles.muted}>{wsName(p.workspaceId)}</span>
          <Icon name="16.chevron.down" />
        </MenuButton>
      ),
    },
    {
      id: "billing", label: "Billing group", compare: byText((p) => bgName(p.billingGroupId)),
      render: (p) => (
        <MenuButton label={`Billing group: ${bgName(p.billingGroupId)}`} className={styles.cellButton} tooltip={false} entries={() => [...(billing ?? []).map((b) => ({ id: b.id, label: b.name, checked: p.billingGroupId === b.id })), "-", { id: "none", label: "Unassigned", checked: p.billingGroupId === null }]} onSelect={(id) => update([p.id], { billingGroupId: id === "none" ? null : id }, "Billing group changed")}>
          <span className={p.billingGroupId ? undefined : styles.muted}>{bgName(p.billingGroupId)}</span>
          <Icon name="16.chevron.down" />
        </MenuButton>
      ),
    },
    // Governance+: guests' access expiration date [G+]
    ...(gp ? [{
      id: "expires", label: "Guest access expiration date", width: 180, compare: byNumber<AdminPerson>((p) => (p.role === "guest" ? p.guestExpiresAt ?? Infinity : null)),
      render: (p: AdminPerson) => (p.role !== "guest" ? null : (
        <button type="button" className={styles.cellButton} aria-label={`Guest access expiration date: ${p.guestExpiresAt ? formatDate(p.guestExpiresAt) : "None"}`} onClick={() => setDialog({ kind: "expiry", ids: [p.id] })}>
          <span className={p.guestExpiresAt ? undefined : styles.muted}>{p.guestExpiresAt ? formatDate(p.guestExpiresAt) : "No expiration date"}</span>
          <Icon name="16.chevron.down" />
        </button>
      )),
    }] : []),
    { id: "active", label: "Last active", width: 120, compare: byNumber((p) => p.lastActiveAt), render: (p) => <span className={styles.muted} title={`Joined ${formatDate(p.joinedAt)}`}>{p.pending ? "Invited" : formatAgo(p.lastActiveAt, now())}</span> },
    // SCIM / JIT metadata (Figma: "you can sort members based on your SCIM member data", 4420842863255) — the chosen ones
    ...IDP_COLUMNS.filter((c) => hasIdp && idpColumns.includes(c.id)).map((c): Column<AdminPerson> => ({
      id: `idp:${c.id}`, label: c.label, width: "minmax(100px, 1fr)", compare: byText((p) => c.get(p)),
      render: (p) => <span className={styles.muted}>{c.get(p)}</span>,
    })),
    { id: "menu", label: "", width: 32, align: "end", render: (p) => <RowMenu label={`Actions for ${p.name ?? p.email}`} entries={rowMenu(p)} onSelect={(id) => onRowMenu(p, id)} /> },
  ];

  const names = (list: string[]) => (list.length === 1 ? all.find((p) => p.id === list[0])?.name ?? all.find((p) => p.id === list[0])?.email ?? "1 person" : `${list.length} people`);
  const current = dialog && "ids" in dialog ? all.filter((p) => dialog.ids.includes(p.id)) : [];
  const same = <T,>(get: (p: AdminPerson) => T): T | null => (current.length && current.every((p) => get(p) === get(current[0])) ? get(current[0]) : null);
  const close = () => setDialog(null);

  return (
    <>
      <div className={styles.seatCounts} role="group" aria-label="Seats">
        {seatCounts.map(([s, n]) => (
          <button key={s} type="button" className={styles.seatCount} aria-pressed={filters.seat === s} data-seat={s} onClick={() => setFilters((f) => ({ ...f, seat: f.seat === s ? undefined : s }))}>
            <span className={styles.seatCountValue}>{n}</span>
            <span className={styles.muted}>{SEAT_LABEL[s]}</span>
          </button>
        ))}
      </div>
      <div className={styles.toolbar}>
        <SearchField className={styles.search} value={text} onChange={setText} placeholder="Search by name or email" />
        <MenuButton label="Filter" entries={filterEntries} onSelect={pickFilter} tooltip={false}>
          <Icon name="24.filter" />
          <span>Filter</span>
        </MenuButton>
        {hasIdp && (
          <MenuButton
            label="SCIM data" tooltip={false}
            entries={() => IDP_COLUMNS.map((c) => ({ id: c.id, label: c.label, checked: idpColumns.includes(c.id) }))}
            onSelect={(id) => setIdpColumns((cols) => (cols.includes(id) ? cols.filter((x) => x !== id) : [...cols, id]))}
          >
            <span>SCIM data</span>
            <Icon name="16.chevron.down" />
          </MenuButton>
        )}
        <span className={styles.spacer} />
        <span className={styles.muted}>{rows.length === all.length ? `${all.length} people` : `${rows.length} of ${all.length} people`}</span>
        <Button variant="secondary" onClick={() => exportCsv("people", query)}>Get CSV</Button>
        <Button variant="primary" onClick={() => setDialog({ kind: "add" })}>Add people</Button>
      </div>
      {chips.length > 0 && (
        <div className={styles.chips}>
          {chips.map((c) => (
            <span key={c.label} className={styles.chip}>
              {c.label}
              <button type="button" className={styles.sort} aria-label={`Clear ${c.label}`} onClick={c.clear}><Icon name="24.close.small" /></button>
            </span>
          ))}
          <Button variant="ghost" onClick={() => setFilters({})}>Clear all</Button>
        </div>
      )}
      <Table label="People" rows={rows} columns={columns} rowKey={(p) => p.id} selection={shownSelection} onSelectionChange={setSelection} muted={(p) => p.pending} initialSort={{ column: "name", direction: "ascending" }} empty="No people match these filters" />
      {ids.length > 0 && (
        <div className={styles.bulk} role="toolbar" aria-label="Selected people">
          <span className={styles.bulkCount}>{ids.length} selected</span>
          <Button variant="secondary" onClick={() => copyEmails(ids)}>Copy emails</Button>
          {store.orgs && <Button variant="secondary" onClick={() => setDialog({ kind: "group", ids })}>Add to user group</Button>}
          <Button variant="secondary" onClick={() => setDialog({ kind: "seat", ids })}>Change seat</Button>
          <Button variant="secondary" onClick={() => setDialog({ kind: "role", ids })}>Change role</Button>
          <Button variant="secondary" onClick={() => setDialog({ kind: "workspace", ids })}>Change workspace</Button>
          <Button variant="secondary" onClick={() => setDialog({ kind: "billing", ids })}>Change billing group</Button>
          {gp && guestIds.length > 0 && <Button variant="secondary" onClick={() => setDialog({ kind: "expiry", ids: guestIds })}>Set guest expiration date</Button>}
          <Button variant="destructive-secondary" onClick={() => setDialog({ kind: "remove", ids })}>Remove users</Button>
          <IconClose onClick={() => setSelection(new Set())} />
        </div>
      )}

      {dialog?.kind === "seat" && (
        <ChoiceDialog
          title={dialog.ids.length === 1 ? `Change seat for ${names(dialog.ids)}` : `Change seat for ${dialog.ids.length} people`}
          label="Seat type"
          choices={SEATS.map((s) => ({ value: s, label: SEAT_LABEL[s], description: SEAT_DESCRIPTION[s] }))}
          value={same((p) => p.seat)}
          confirm="Change seat"
          onSave={(v) => update(dialog.ids, { seat: v as Seat }, `Changed seat to ${SEAT_LABEL[v as Seat]}`)}
          onClose={close}
        />
      )}
      {dialog?.kind === "role" && (
        <ChoiceDialog
          title={`Change role for ${names(dialog.ids)}`}
          label="Role"
          choices={[{ value: "admin", label: "Admin", description: "Manages the organization's people, teams, settings and billing" }, { value: "member", label: "Member", description: "Can see every visible team and use the organization's libraries" }, { value: "guest", label: "Guest", description: "Can only open the teams, folders and files they're invited to" }]}
          value={same((p) => p.role)}
          confirm="Change role"
          onSave={(v) => update(dialog.ids, { role: v as OrgRole }, "Role changed")}
          onClose={close}
        />
      )}
      {dialog?.kind === "workspace" && (
        <ChoiceDialog
          title={`Change workspace for ${names(dialog.ids)}`}
          label="Workspace"
          intro="A person belongs to one workspace, but can still join teams in others."
          choices={[...(workspaces ?? []).map((w) => ({ value: w.id, label: w.name })), { value: "none", label: "Unassigned" }]}
          value={same((p) => p.workspaceId ?? "none")}
          confirm="Change workspace"
          onSave={(v) => update(dialog.ids, { workspaceId: v === "none" ? null : v }, "Workspace changed")}
          onClose={close}
        />
      )}
      {dialog?.kind === "billing" && (
        <ChoiceDialog
          title={`Change billing group for ${names(dialog.ids)}`}
          label="Billing group"
          choices={[...(billing ?? []).map((b) => ({ value: b.id, label: b.name })), { value: "none", label: "Unassigned" }]}
          value={same((p) => p.billingGroupId ?? "none")}
          confirm="Change billing group"
          onSave={(v) => update(dialog.ids, { billingGroupId: v === "none" ? null : v }, "Billing group changed")}
          onClose={close}
        />
      )}
      {dialog?.kind === "remove" && (
        <ConfirmDialog
          title={`Remove ${names(dialog.ids)} from the organization?`}
          body="They'll lose access to the organization's teams, folders and files. Their drafts move to Admin › Content › Unassigned drafts."
          confirm="Remove"
          destructive
          onConfirm={() => run(() => store.admin.removePeople(orgId, dialog.ids), `Removed ${names(dialog.ids)}`).then(() => setSelection(new Set()))}
          onClose={close}
        />
      )}
      {dialog?.kind === "group" && store.orgs && <AddToGroupDialog ids={dialog.ids} onClose={close} />}
      {dialog?.kind === "expiry" && store.governance && <GuestExpirationDialog guests={current} onClose={close} />}
      {dialog?.kind === "add" && <AddPeopleDialog workspaces={workspaces ?? []} billing={billing ?? []} defaultSeat={settings?.defaultSeat ?? "view"} onClose={close} />}
    </>
  );
}

/** "2026-12-31" ↔ the end of that local day in ms */
const dayValue = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const dayEnd = (day: string) => (/^\d{4}-\d{2}-\d{2}$/.test(day) ? new Date(`${day}T23:59:59`).getTime() : NaN);

/** Change expiration date / Set guest expiration date [G+]: a date, or Remove expiration date */
function GuestExpirationDialog({ guests, onClose }: { guests: AdminPerson[]; onClose: () => void }) {
  const { orgId, store, run, now } = useAdmin();
  const first = guests[0];
  const shared = guests.every((g) => g.guestExpiresAt === first?.guestExpiresAt) ? first?.guestExpiresAt ?? null : null;
  const [day, setDay] = useState(shared ? dayValue(shared) : "");
  const at = dayEnd(day);
  const valid = Number.isFinite(at) && at > now() && at <= now() + GUEST_EXPIRY_MAX_DAYS * 86_400_000;
  const ids = guests.map((g) => g.id);
  const who = guests.length === 1 ? first.name ?? first.email : `${guests.length} guests`;
  // Closes only when saved: `run` answers undefined after its error toast, and the dialog stays for another try.
  const set = (expiresAt: number | null, done: string) =>
    void run(async () => (await store.governance!.setGuestExpiration(orgId, ids, expiresAt), true as const), done).then((ok) => ok && onClose());
  return (
    <Dialog
      title={guests.length === 1 ? "Guest access expiration date" : "Set guest expiration date"} open size="medium" onClose={onClose}
      footer={
        <>
          {guests.some((g) => g.guestExpiresAt) && <Button variant="secondary" onClick={() => set(null, "Expiration date removed")}>Remove expiration date</Button>}
          <span className={styles.spacer} />
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!valid} onClick={() => set(at, "Expiration date saved")}>Save</Button>
        </>
      }
    >
      <div className={styles.form} data-guest-expiry={ids.join(",")}>
        <div className={styles.note}>{who} lose{guests.length === 1 ? "s" : ""} access to the organization at the end of this day, and the seat is freed. A banner warns two weeks before.</div>
        <Field title="Expiration date">
          <input type="date" aria-label="Expiration date" className={styles.date} value={day} min={dayValue(now() + 86_400_000)} onChange={(e) => setDay(e.target.value)} />
        </Field>
        {day && !valid && <div className={styles.error}>Choose a date in the future, within 10 years.</div>}
      </div>
    </Dialog>
  );
}

function IconClose({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" className={styles.sort} aria-label="Clear selection" onClick={onClick}>
      <Icon name="24.close.small" />
    </button>
  );
}

function AddPeopleDialog({ workspaces, billing, defaultSeat, onClose }: { workspaces: OrgWorkspace[]; billing: BillingGroup[]; defaultSeat: Seat; onClose: () => void }) {
  const { orgId, store, run } = useAdmin();
  const [emails, setEmails] = useState("");
  const [role, setRole] = useState<OrgRole>("member");
  const [seat, setSeat] = useState<Seat>(defaultSeat);
  const [workspaceId, setWorkspaceId] = useState("none");
  const [billingGroupId, setBillingGroupId] = useState("none");
  const list = emails.split(/[\s,;]+/).map((e) => e.trim()).filter(Boolean);
  const add = async () => {
    const out = await run(() => store.admin.addPeople(orgId, { emails: list, role, seat, workspaceId: workspaceId === "none" ? null : workspaceId, billingGroupId: billingGroupId === "none" ? null : billingGroupId }), list.length === 1 ? `Invited ${list[0]}` : `Invited ${list.length} people`);
    if (out) onClose();
  };
  return (
    <Dialog
      title="Add people"
      open
      size="medium"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={list.length === 0} onClick={() => void add()}>Add people</Button>
        </>
      }
    >
      <div className={styles.form}>
        <Field title="Emails">
          <TextArea label="Emails" value={emails} onChange={setEmails} placeholder="Add emails, separated by commas" minRows={3} />
        </Field>
        <Field title="Role">
          <Select label="Role" variant="outlined" value={role} options={[{ value: "member", label: "Member" }, { value: "admin", label: "Admin" }, { value: "guest", label: "Guest" }]} onChange={(v) => setRole(v as OrgRole)} />
        </Field>
        <Field title="Seat type">
          <Select label="Seat type" variant="outlined" value={seat} options={SEATS.map((s) => ({ value: s, label: SEAT_LABEL[s] }))} onChange={(v) => setSeat(v as Seat)} />
        </Field>
        <Field title="Workspace">
          <Select label="Workspace" variant="outlined" value={workspaceId} options={[...workspaces.map((w) => ({ value: w.id, label: w.name })), { value: "none", label: "Unassigned" }]} onChange={setWorkspaceId} />
        </Field>
        <Field title="Billing group">
          <Select label="Billing group" variant="outlined" value={billingGroupId} options={[...billing.map((b) => ({ value: b.id, label: b.name })), { value: "none", label: "Unassigned" }]} onChange={setBillingGroupId} />
        </Field>
      </div>
    </Dialog>
  );
}

function AddToGroupDialog({ ids, onClose }: { ids: string[]; onClose: () => void }) {
  const { orgId, store, run } = useAdmin();
  const { data: groups } = useLoad(() => store.orgs!.groups(orgId), [orgId]);
  if (!groups) return null;
  return (
    <ChoiceDialog
      title={`Add ${ids.length === 1 ? "1 person" : `${ids.length} people`} to a user group`}
      label="User group"
      choices={groups.map((g) => ({ value: g.id, label: g.name, description: `${g.memberCount} members` }))}
      value={null}
      confirm="Add to group"
      onSave={(id) => run(() => store.orgs!.setGroupMembers(id, { add: ids }), `Added to ${groups.find((g) => g.id === id)?.name}`)}
      onClose={onClose}
    />
  );
}

/** Admin › People › User groups (help.figma.com 38020006913943) */
export function UserGroupsTab() {
  const { orgId, store, run } = useAdmin();
  const orgs = store.orgs;
  const { data: groups } = useLoad(() => (orgs ? orgs.groups(orgId) : Promise.resolve([] as UserGroup[])), [orgId, orgs]);
  const { data: people } = useLoad(() => store.admin.people(orgId), [orgId]);
  const [open, setOpen] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [text, setText] = useState("");
  if (!orgs) return <div className={styles.empty}>User groups aren't available here.</div>;
  const all = people?.items ?? [];
  const nameOf = (id: string) => all.find((p) => p.id === id)?.name ?? all.find((p) => p.id === id)?.email ?? "";
  const q = text.trim().toLowerCase();
  const rows = (groups ?? []).filter((g) => !q || g.name.toLowerCase().includes(q));
  const columns: Column<UserGroup>[] = [
    { id: "name", label: "Name", width: "minmax(220px, 2fr)", compare: byText((g) => g.name), render: (g) => <span className={styles.whoText}><span className={styles.whoName}>{g.name}</span>{g.description && <span className={styles.whoEmail}>{g.description}</span>}</span> },
    { id: "members", label: "Members", width: 120, compare: byNumber((g) => g.memberCount), render: (g) => g.memberCount },
    { id: "by", label: "Created by", compare: byText((g) => nameOf(g.createdBy)), render: (g) => nameOf(g.createdBy) },
  ];
  const group = groups?.find((g) => g.id === open);
  return (
    <>
      <div className={styles.toolbar}>
        <SearchField className={styles.search} value={text} onChange={setText} placeholder="Search user groups" />
        <span className={styles.spacer} />
        <Button variant="primary" onClick={() => setCreating(true)}>Create user group</Button>
      </div>
      <Table label="User groups" rows={rows} columns={columns} rowKey={(g) => g.id} onRowClick={(g) => setOpen(g.id)} initialSort={{ column: "name", direction: "ascending" }} empty="No user groups yet" />
      {creating && <NameDialog title="Create user group" label="Group name" confirm="Create group" onSave={(name) => run(() => orgs.createGroup(orgId, { name }), `Created ${name}`)} onClose={() => setCreating(false)} />}
      {group && <GroupDialog group={group} people={all} onClose={() => setOpen(null)} />}
    </>
  );
}

function GroupDialog({ group, people, onClose }: { group: UserGroup; people: AdminPerson[]; onClose: () => void }) {
  const { store, run } = useAdmin();
  const orgs = store.orgs!;
  const [sub, setSub] = useState<"rename" | "add" | "delete" | null>(null);
  const columns: Column<UserGroup["members"][number]>[] = [
    { id: "name", label: "Name", compare: byText((p) => p.name ?? p.email), render: (p) => <Who person={p} /> },
    { id: "remove", label: "", width: 90, align: "end", render: (p) => <Button variant="ghost" onClick={() => run(() => orgs.setGroupMembers(group.id, { remove: [p.id] }), "Removed from group")}>Remove</Button> },
  ];
  return (
    <>
      <Dialog
        title={group.name}
        open={sub === null}
        size="large"
        onClose={onClose}
        footer={
          <>
            <Button variant="destructive-secondary" onClick={() => setSub("delete")}>Delete group</Button>
            <span className={styles.spacer} />
            <Button variant="secondary" onClick={() => setSub("rename")}>Rename</Button>
            <Button variant="primary" onClick={() => setSub("add")}>Add people</Button>
          </>
        }
      >
        <div className={styles.form}>
          {group.description && <span className={styles.note}>{group.description}</span>}
          <Table label="Group members" rows={group.members} columns={columns} rowKey={(p) => p.id} initialSort={{ column: "name", direction: "ascending" }} empty="No members yet" />
        </div>
      </Dialog>
      {sub === "rename" && <NameDialog title="Rename user group" label="Group name" value={group.name} confirm="Save" onSave={(name) => run(() => orgs.updateGroup(group.id, { name }))} onClose={() => setSub(null)} />}
      {sub === "add" && <PickDialog title={`Add people to ${group.name}`} items={people.filter((p) => !p.pending && !group.members.some((m) => m.id === p.id)).map(personItem)} confirm="Add" min={1} onSave={(ids) => run(() => orgs.setGroupMembers(group.id, { add: ids }), "Added to group")} onClose={() => setSub(null)} />}
      {sub === "delete" && <ConfirmDialog title={`Delete ${group.name}?`} body="People in the group keep their own access; access given through the group is removed." confirm="Delete group" destructive onConfirm={() => run(() => orgs.deleteGroup(group.id), "Group deleted").then(onClose)} onClose={() => setSub(null)} />}
    </>
  );
}
