/**
 * Admin › Activity (help.figma.com 360040449533): filters Member (an email), Date (Last 30 days by default, or
 * Custom), Events (by Figma's groups) and Team; Get CSV (the date range only, as Figma's); rows with the date and
 * time in UTC, the team member, the event, the product and team when there is one, and the IP address.
 */
import { useEffect, useRef, useState } from "react";
import { Button, Select, TextInput, type SelectEntry } from "@/ds";
import type { ActivityLog, ActivityQuery } from "@shared/org/types";
import { REQUIRES_GOVERNANCE_PLUS, type DeveloperDateRange, type DeveloperEventSource, type DeveloperLogItem, type DeveloperLogsQuery, type DeveloperTokenType } from "@shared/org/governance";
import { useGovernance } from "./SettingsGovernance";
import { useAdmin, useLoad } from "./context";
import { ACTION_LABEL, EVENT_GROUPS, eventText, formatUtc, productOf } from "./labels";
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
      render: (r) => <span className={styles.whoText}><span className={styles.whoName} title={r.action.type}>{eventText(r)}</span><span className={styles.whoEmail}>{r.entity.name}</span></span>,
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

// ---- Developer logs (docs/governance.md §1 [devlog], §2.12; round 14h) -------------------------------------------

const TOKEN_TYPE_LABEL: Record<DeveloperTokenType, string> = { PLAN_ACCESS_TOKEN: "Plan access token", PERSONAL_ACCESS_TOKEN: "Personal access token", OAUTH_TOKEN: "OAuth token" };
const ITEM_TOKEN_LABEL: Record<DeveloperLogItem["actor"]["token_type"], string> = { plan_access_token: "Plan access token", personal_access_token: "Personal access token", oauth_token: "OAuth token", session: "Session" };
const SOURCE_LABEL: Record<DeveloperEventSource, string> = { REST_API: "REST API", MCP_SERVER: "MCP server" };
const DATE_RANGE_LABEL: Record<DeveloperDateRange, string> = { LAST_24H: "Last 24 hours", LAST_7D: "Last 7 days", LAST_30D: "Last 30 days" };
const DEV_PAGE = 25;
/** The text filters ask the server this long after the last keystroke */
export const DEV_FILTER_DEBOUNCE_MS = 300;

/** `value`, `ms` after it last changed */
function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return settled;
}

/**
 * Admin › Activity › Developer logs (ours: Figma shows them at figma.com/developers/log; the filters are the Developer
 * Logs API's [devlog]): Token name, User email, IP address (prefixes; commas mean OR), Token type, Source, Date range;
 * 25 rows and Load more; Governance+ only.
 */
export function DeveloperLogsTab() {
  const { orgId, store, run } = useAdmin();
  const g = store.governance;
  const { on, overview } = useGovernance();
  const [tokenName, setTokenName] = useState("");
  const [email, setEmail] = useState("");
  const [ip, setIp] = useState("");
  const [tokenType, setTokenType] = useState<DeveloperTokenType | "all">("all");
  const [source, setSource] = useState<DeveloperEventSource | "all">("all");
  const [range, setRange] = useState<DeveloperDateRange>("LAST_30D");
  // Typing asks once it pauses, not per keystroke
  const tokenNameQ = useDebounced(tokenName.trim(), DEV_FILTER_DEBOUNCE_MS);
  const emailQ = useDebounced(email.trim(), DEV_FILTER_DEBOUNCE_MS);
  const ipQ = useDebounced(ip.trim(), DEV_FILTER_DEBOUNCE_MS);
  const loadingMore = useRef(false);
  const [busy, setBusy] = useState(false);
  const query: DeveloperLogsQuery = {
    token_name: tokenNameQ || undefined,
    user_email: emailQ || undefined,
    ip_address: ipQ || undefined,
    token_type: tokenType === "all" ? undefined : tokenType,
    event_source: source === "all" ? undefined : source,
    date_range: range,
    limit: DEV_PAGE,
  };
  const key = JSON.stringify(query);
  // The page carries its query: while another loads, the previous one shows without the rows Load more added to it
  const { data: loaded } = useLoad(() => (g && on ? g.developerLogs(orgId, query).then((page) => ({ key, page })) : Promise.resolve(null)), [orgId, g, on, key]);
  const first = loaded?.page;
  const fresh = loaded?.key === key;
  const [more, setMore] = useState<{ key: string; rows: DeveloperLogItem[]; cursor: string | null } | null>(null);
  if (!g) return <div className={styles.empty}>Developer logs aren't available here.</div>;
  if (overview && !on) return <div className={styles.empty} data-requires-gplus="">{REQUIRES_GOVERNANCE_PLUS}</div>;
  const rows = [...(first?.items ?? []), ...(fresh && more?.key === key ? more.rows : [])];
  const cursor = !fresh ? null : more?.key === key ? more.cursor : first?.has_more ? first.cursor : null;
  const loadMore = async () => {
    // One page at a time: a second click while one loads would add the same rows twice
    if (!cursor || loadingMore.current) return;
    loadingMore.current = true;
    setBusy(true);
    try {
      const page = await run(() => g.developerLogs(orgId, { ...query, cursor }));
      if (page) setMore((m) => ({ key, rows: [...(m?.key === key ? m.rows : []), ...page.items], cursor: page.has_more ? page.cursor : null }));
    } finally {
      loadingMore.current = false;
      setBusy(false);
    }
  };
  const columns: Column<DeveloperLogItem>[] = [
    { id: "date", label: "Date (UTC)", width: 150, render: (r) => <span className={styles.muted}>{formatUtc(Date.parse(r.timestamp) / 1000)}</span> },
    {
      id: "user", label: "User", width: "minmax(170px, 1.5fr)",
      render: (r) => (r.actor.user_email ? <span className={styles.whoText}><span className={styles.whoName}>{r.actor.user_name ?? r.actor.user_email}</span><span className={styles.whoEmail}>{r.actor.user_email}</span></span> : <span className={styles.muted}>Plan access token</span>),
    },
    { id: "token", label: "Token", width: "minmax(150px, 1.2fr)", render: (r) => <span className={styles.whoText}><span className={styles.whoName}>{r.actor.token_name ?? "—"}</span><span className={styles.whoEmail}>{ITEM_TOKEN_LABEL[r.actor.token_type]}</span></span> },
    { id: "event", label: "Event", width: "minmax(180px, 1.5fr)", render: (r) => <span className={styles.whoText}><span className={styles.whoName}>{r.action.event_name}</span><span className={styles.whoEmail}>{r.action.event_source === "mcp_server" ? "MCP server" : "REST API"}</span></span> },
    { id: "resource", label: "Resource", width: "minmax(120px, 1fr)", render: (r) => <span className={styles.muted}>{r.resource.name ?? r.resource.id_or_key ?? ""}</span> },
    {
      id: "ip", label: "IP address", width: "minmax(140px, 1fr)",
      render: (r) => <span className={styles.whoText}><span>{r.context.ip_address}</span><span className={styles.whoEmail}>{[r.context.city, r.context.country].filter(Boolean).join(", ")}</span></span>,
    },
  ];
  return (
    <>
      <div className={styles.toolbar}>
        <TextInput className={styles.search} label="Token name" value={tokenName} onChange={setTokenName} placeholder="Token name" variant="outlined" />
        <TextInput className={styles.search} label="User email" value={email} onChange={setEmail} placeholder="User email" variant="outlined" />
        <TextInput className={styles.search} label="IP address" value={ip} onChange={setIp} placeholder="IP address" variant="outlined" />
      </div>
      <div className={styles.toolbar}>
        <Select label="Token type" width={190} value={tokenType} options={[{ value: "all", label: "All token types" }, ...(Object.keys(TOKEN_TYPE_LABEL) as DeveloperTokenType[]).map((t) => ({ value: t, label: TOKEN_TYPE_LABEL[t] }))]} onChange={(v) => setTokenType(v as DeveloperTokenType | "all")} />
        <Select label="Source" width={150} value={source} options={[{ value: "all", label: "All sources" }, ...(Object.keys(SOURCE_LABEL) as DeveloperEventSource[]).map((t) => ({ value: t, label: SOURCE_LABEL[t] }))]} onChange={(v) => setSource(v as DeveloperEventSource | "all")} />
        <Select label="Date range" width={150} value={range} options={(Object.keys(DATE_RANGE_LABEL) as DeveloperDateRange[]).map((t) => ({ value: t, label: DATE_RANGE_LABEL[t] }))} onChange={(v) => setRange(v as DeveloperDateRange)} />
        <span className={styles.spacer} />
        <span className={styles.muted}>Calls with tokens to the REST API and the MCP server, kept 30 days.</span>
      </div>
      <Table label="Developer logs" rows={rows} columns={columns} rowKey={(r) => r.uuid} empty="No calls match these filters" />
      {cursor && (
        <div className={styles.loadMore}>
          <Button variant="secondary" disabled={busy} onClick={() => void loadMore()}>Load more</Button>
        </div>
      )}
    </>
  );
}
