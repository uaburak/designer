/**
 * Admin › Activity (help.figma.com 360040449533): filters Member (an email), Date (Last 30 days by default, or
 * Custom), Events (by Figma's groups) and Team; Get CSV (the date range only, as Figma's); rows with the date and
 * time in UTC, the team member, the event, the product and team when there is one, and the IP address.
 */
import { useState } from "react";
import { Button, Select, TextInput, type SelectEntry } from "@/ds";
import type { ActivityLog, ActivityQuery } from "@shared/org/types";
import { useAdmin, useLoad } from "./context";
import { ACTION_LABEL, EVENT_GROUPS, formatUtc, productOf } from "./labels";
import { Table, styles, type Column } from "./parts";

type Range = "1" | "7" | "30" | "90" | "365" | "custom";
const RANGE_LABEL: Record<Range, string> = { "1": "Last 24 hours", "7": "Last 7 days", "30": "Last 30 days", "90": "Last 90 days", "365": "Last year", custom: "Custom" };
const PAGE = 100;

/** "2026-10-11" → Unix seconds at that UTC midnight (end: the day's last second) */
function dayToSeconds(day: string, end: boolean): number | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return undefined;
  const t = Date.parse(`${day}T00:00:00Z`) / 1000;
  return end ? t + 86_399 : t;
}

export function ActivityTab() {
  const { orgId, store, run, exportCsv, now } = useAdmin();
  const [email, setEmail] = useState("");
  const [range, setRange] = useState<Range>("30");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [event, setEvent] = useState("all");
  const [teamId, setTeamId] = useState("all");
  const { data: teams } = useLoad(() => store.admin.teams(orgId, { includeHidden: true, includeDeleted: true }), [orgId]);
  const nowS = Math.floor(now() / 1000);
  const query: ActivityQuery = {
    email: email.trim() || undefined,
    events: event === "all" ? undefined : event.startsWith("group:") ? EVENT_GROUPS.find((g) => g.name === event.slice(6))?.actions : [event],
    teamId: teamId === "all" ? undefined : teamId,
    startTime: range === "custom" ? dayToSeconds(from, false) : nowS - Number(range) * 86_400,
    endTime: range === "custom" ? dayToSeconds(to, true) : undefined,
    order: "desc",
    limit: PAGE,
  };
  const key = JSON.stringify({ ...query, startTime: range === "custom" ? query.startTime : range });
  const { data: first } = useLoad(() => store.admin.activity(orgId, query), [orgId, key]);
  const [more, setMore] = useState<{ key: string; rows: ActivityLog[]; cursor: string | null } | null>(null);
  const rows = [...(first?.activity_logs ?? []), ...(more?.key === key ? more.rows : [])];
  const cursor = more?.key === key ? more.cursor : first?.cursor ?? null;
  const loadMore = async () => {
    if (!cursor) return;
    const page = await run(() => store.admin.activity(orgId, { ...query, cursor }));
    if (page) setMore({ key, rows: [...(more?.key === key ? more.rows : []), ...page.activity_logs], cursor: page.cursor });
  };
  const teamName = (id: string | null) => (id ? teams?.items.find((t) => t.id === id)?.name ?? "" : "");
  const events: SelectEntry[] = [{ value: "all", label: "All events" }];
  for (const g of EVENT_GROUPS) {
    events.push("-", { header: g.name }, { value: `group:${g.name}`, label: `All ${g.name.toLowerCase()} events` });
    for (const a of g.actions) events.push({ value: a, label: ACTION_LABEL[a] });
  }
  const columns: Column<ActivityLog>[] = [
    { id: "date", label: "Date (UTC)", width: 150, render: (r) => <span className={styles.muted}>{formatUtc(r.timestamp)}</span> },
    {
      id: "member", label: "Team member", width: "minmax(180px, 1.5fr)",
      render: (r) => (r.actor ? <span className={styles.whoText}><span className={styles.whoName}>{r.actor.name}</span><span className={styles.whoEmail}>{r.actor.email}</span></span> : <span className={styles.muted}>Figma</span>),
    },
    {
      id: "event", label: "Event", width: "minmax(220px, 2fr)",
      render: (r) => <span className={styles.whoText}><span className={styles.whoName} title={r.action.type}>{ACTION_LABEL[r.action.type] ?? r.action.type}</span><span className={styles.whoEmail}>{r.entity.name}</span></span>,
    },
    { id: "product", label: "Product", width: 110, render: (r) => <span className={styles.muted}>{productOf(r)}</span> },
    { id: "team", label: "Team", width: "minmax(100px, 1fr)", render: (r) => <span className={styles.muted}>{teamName(r.context.team_id)}</span> },
    { id: "ip", label: "IP address", width: 120, render: (r) => <span className={styles.muted}>{r.context.ip_address}</span> },
  ];
  return (
    <>
      <div className={styles.toolbar}>
        <TextInput className={styles.search} label="Member" value={email} onChange={setEmail} placeholder="Member email" variant="outlined" prefix="24.search.small" />
        <Select label="Date" width={140} value={range} options={(Object.keys(RANGE_LABEL) as Range[]).map((r) => ({ value: r, label: RANGE_LABEL[r] }))} onChange={(v) => setRange(v as Range)} />
        {range === "custom" && (
          <span className={styles.dateRow}>
            <input type="date" aria-label="Start date" className={styles.date} value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} />
            <span className={styles.muted}>to</span>
            <input type="date" aria-label="End date" className={styles.date} value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} />
          </span>
        )}
        <Select label="Events" width={200} value={event} options={events} onChange={setEvent} menuWidth={280} />
        <Select label="Team" width={160} value={teamId} options={[{ value: "all", label: "All teams" }, ...(teams?.items ?? []).map((t) => ({ value: t.id, label: t.name }))]} onChange={setTeamId} />
        <span className={styles.spacer} />
        <Button variant="secondary" onClick={() => exportCsv("activity", { startTime: query.startTime, endTime: query.endTime })}>Get CSV</Button>
      </div>
      <Table label="Activity" rows={rows} columns={columns} rowKey={(r) => r.id} empty="No activity matches these filters" />
      {cursor && (
        <div className={styles.loadMore}>
          <Button variant="secondary" onClick={() => void loadMore()}>Load more</Button>
        </div>
      )}
    </>
  );
}
