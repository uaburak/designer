/**
 * Agent settings, all of it ("This chat" › All settings…, the MCP section's button): a modal (the approved prototype's,
 * 780 × 600) with a nav at the left like Manage libraries — Agents and models, Manager and Studio, Skills, Connectors,
 * Access, Usage — and at the right the section's page: its title and a line on it, then boxed sections as in This chat's
 * popover (a small label over a box of rows with lines between them). The logic is the settings pages' own
 * (AgentSettings.tsx, aiSettings.tsx, AccessSettings.tsx, ManagerSettings.tsx, aiData.ts); a detail (an agent's page,
 * a skill's editor, a connector's tools) opens in place with Back to the section. The panel never turns into settings.
 */
import { useEffect, useState, type ReactNode } from "react";
import { AgentLogo, Badge, Button, Dialog, Icon, IconButton, MenuButton, Select, Spinner, Switch, cx, hasAgentLogo, showToast, type IconName } from "@/ds";
import type { AccessLogEntry, ReachCapability, ReachPolicy } from "@shared/agents/reach";
import type { ProviderInfo } from "@shared/agents/types";
import type { AgentsService } from "../../agents/service";
import { modelLabel } from "../../agents/setup";
import { shortModelName } from "../../agents/models";
import { formatTokens, relevantWindows, resetLabel, ringOf, usedLabel } from "../../agents/usage";
import { KIND_ICON, LookAgain, SettingsPage, isCustom, isServer, stateText } from "./AgentSettings";
import { connectorStatus } from "./aiSettings";
import { CAPABILITIES, OUTCOME, POLICIES, changeReach, useReach } from "./AccessSettings";
import { ManagerPage } from "./ManagerSettings";
import { EffortPicker } from "./ModelPicker";
import { changeConnectors, removeSkill, resetSkill, toggleSkill, useConnectors, useSkills } from "./aiData";
import { BoxRow, SettingsBox, errorText } from "./settingsParts";
import { AgentMark } from "./AgentMark";
import styles from "./Agents.module.css";
import { intlLocale, t, tp, useT } from "@/i18n";

export type SettingsSection = "agents" | "manager" | "skills" | "connectors" | "access" | "usage";

const SECTIONS: { id: SettingsSection; label: string; about: string; icon: IconName }[] = [
  { id: "agents", label: "Agents and models", about: "The agents on this computer and the models they use for new chats.", icon: "24.agents" },
  { id: "manager", label: "Manager and Studio", about: "The manager plans the work, hands it to other agents and reviews what they make.", icon: "24.person" },
  { id: "skills", label: "Skills", about: "Agents use a skill when it fits the task; type /name in a message to call one.", icon: "24.file" },
  { id: "connectors", label: "Connectors", about: "MCP servers your agents can use, and the apps that connect to this one.", icon: "24.link" },
  { id: "access", label: "Access", about: "How far agents can reach outside this file.", icon: "24.lock.small" },
  { id: "usage", label: "Usage", about: "What each agent’s plan has used, as its CLI reports it.", icon: "24.recent" },
];

/** The section an item's page is in ("provider:codex" → Agents and models; "section:skills" is the section itself). */
export function sectionOf(item: string | null): SettingsSection | null {
  if (!item) return null;
  const kind = item.includes(":") ? item.slice(0, item.indexOf(":")) : item;
  if (kind === "section") return SECTIONS.find((s) => s.id === item.slice(8))?.id ?? null;
  if (kind === "provider" || kind === "add-server") return "agents";
  if (kind === "manager") return "manager";
  if (kind === "skill" || kind === "add-skill") return "skills";
  if (kind === "connector" || kind === "add-connector" || kind === "mcp" || kind === "client") return "connectors";
  if (kind === "access") return "access";
  return null;
}

export function AgentSettingsModal({ service }: { service: AgentsService }) {
  useT();
  const state = service.get();
  const item = state.settingsItem;
  const [section, setSection] = useState<SettingsSection>(() => sectionOf(item) ?? "agents");
  // A page opened from outside (the composer's "Add skill", Manager…) shows its section.
  const [seen, setSeen] = useState(item);
  if (seen !== item) {
    setSeen(item);
    const s = sectionOf(item);
    if (s && s !== section) setSection(s);
  }
  useEffect(() => {
    void service.refreshProviders();
  }, [service]);
  // The manager's section is its page; another item's page shows in its own section, with Back to it.
  const page = item && item !== "manager" && !item.startsWith("section:") && sectionOf(item) === section ? item : null;
  const info = SECTIONS.find((s) => s.id === section)!;
  return (
    <Dialog title={t("Agent settings")} size="large" header="small" className={styles.settingsModal} open onClose={() => service.closeSettings()}>
      <div className={styles.settingsShell} data-agent-settings-modal="" data-settings-section={section}>
        <nav className={styles.settingsNav} aria-label={t("Agent settings")}>
          <div role="tablist" aria-orientation="vertical" aria-label={t("Agent settings")} className={styles.settingsTabs}>
            {SECTIONS.map((s) => (
              <button
                key={s.id}
                type="button"
                role="tab"
                aria-selected={s.id === section}
                className={styles.settingsTab}
                onClick={() => {
                  setSection(s.id);
                  if (item) service.openSetting(null);
                }}
                data-settings-tab={s.id}
              >
                <Icon name={s.icon} />
                <span className={styles.settingsTabLabel}>{t(s.label)}</span>
              </button>
            ))}
          </div>
        </nav>
        {page ? (
          <div className={cx(styles.settings, styles.embedded, styles.settingsContent)} role="tabpanel" aria-label={t(info.label)} data-agent-settings="" data-settings-page={page}>
            <SettingsPage service={service} item={page} />
          </div>
        ) : (
          <div className={styles.settingsContent} role="tabpanel" aria-label={t(info.label)} data-agent-settings="" data-settings-page={section}>
            <div className={styles.mHead}>
              <div className={styles.mHeadText}>
                <h2 className={styles.mTitle}>{t(info.label)}</h2>
                <p className={styles.mAbout}>{t(info.about)}</p>
              </div>
              <PageAction service={service} section={section} />
            </div>
            <div className={styles.mPage}>
              <SectionBody service={service} section={section} />
            </div>
          </div>
        )}
      </div>
    </Dialog>
  );
}

function PageAction({ service, section }: { service: AgentsService; section: SettingsSection }) {
  useT();
  if (section === "agents") return <LookAgain service={service} />;
  if (section === "skills")
    return (
      <Button variant="secondary" onClick={() => service.openSetting("add-skill")} data-new-skill="">
        {t("New skill")}
      </Button>
    );
  return null;
}

function SectionBody({ service, section }: { service: AgentsService; section: SettingsSection }): ReactNode {
  if (section === "agents") return <AgentsSection service={service} />;
  if (section === "manager") return <ManagerPage service={service} boxed />;
  if (section === "skills") return <SkillsSection service={service} />;
  if (section === "connectors") return <ConnectorsSection service={service} />;
  if (section === "access") return <AccessSection service={service} />;
  return <UsageSection service={service} />;
}

/** The chevron that opens an item's detail in place. */
function Details({ label, onClick, ...data }: { label: string; onClick: () => void } & Record<`data-${string}`, string | undefined>) {
  return <IconButton icon="24.chevron.right" label={label} tone="secondary" onClick={onClick} {...data} />;
}

// ---- Agents and models ----

const FIELD_WIDTH = 144;

function AgentsSection({ service }: { service: AgentsService }) {
  useT();
  const state = service.get();
  const agents = state.providers.filter((p) => !isServer(p));
  const local = state.providers.filter(isServer);
  return (
    <>
      <SettingsBox label={t("On this computer")} note={t("Connected agents show up in the chat’s agent menu.")} data-settings-box="agents">
        {state.providersLoading && !agents.length && <p className={styles.mEmpty}><Spinner size={16} /> {t("Looking for agents…")}</p>}
        {!state.providersLoading && !agents.length && <p className={styles.mEmpty}>{t("No agent is connected.")}</p>}
        {agents.map((p) => <ProviderRow key={p.id} service={service} p={p} />)}
      </SettingsBox>
      <SettingsBox
        label={t("Local models")}
        action={
          <Button variant="secondary" onClick={() => service.openSetting("add-server")} data-settings-row="add-server">
            {t("Add a server")}
          </Button>
        }
        data-settings-box="local"
      >
        {local.map((p) => <ProviderRow key={p.id} service={service} p={p} />)}
        {!local.length && <p className={styles.mEmpty}>{t("No servers yet.")}</p>}
      </SettingsBox>
    </>
  );
}

/** An agent: its mark, its name and state (its account's plan), its default model and effort, its page. */
function ProviderRow({ service, p }: { service: AgentsService; p: ProviderInfo }) {
  useT();
  const status = stateText(p);
  const on = status === "Connected";
  const plan = on && p.auth?.state === "connected" ? p.auth.plan : undefined;
  const open = () => service.openSetting(`provider:${p.id}`);
  const needs = status === "Not installed" ? t("Install") : status === "Sign in needed" ? t("Sign in") : null;
  return (
    <BoxRow
      mark={hasAgentLogo(p.id) ? <AgentLogo id={p.id} /> : undefined}
      icon={KIND_ICON(p)}
      title={p.label}
      desc={
        <>
          {on && <span className={cx(styles.dot, styles.dotOn)} />}
          <span data-provider-state="">{[t(status), plan, isCustom(p) || isServer(p) ? p.detail : undefined].filter(Boolean).join(" · ")}</span>
        </>
      }
      dim={!on && status !== "Sign in needed"}
      data-provider={p.id}
      data-available={p.available ? "" : undefined}
      data-state={isServer(p) ? (p.available ? "connected" : "not-running") : p.auth?.state}
    >
      {p.available && p.models.length > 1 && (
        <Select
          label={t("{name} model", { name: p.label })}
          variant="filled"
          width={FIELD_WIDTH}
          value={service.modelOf(p) ?? ""}
          options={p.models.map((m) => ({ value: m, label: modelLabel(m, p), valueLabel: shortModelName(modelLabel(m, p)) }))}
          onChange={(m) => void service.choose(p.id, m)}
          data-provider-model={p.id}
        />
      )}
      {p.available && <EffortPicker service={service} provider={p} variant="filled" width={FIELD_WIDTH / 2 + 24} />}
      {needs && (
        <Button variant="secondary" onClick={open}>
          {needs}
        </Button>
      )}
      <Details label={t("{name} details", { name: p.label })} onClick={open} data-provider-details={p.id} />
    </BoxRow>
  );
}

// ---- Skills ----

function SkillsSection({ service }: { service: AgentsService }) {
  useT();
  const { list, loading, error } = useSkills();
  const fail = (err: unknown) => showToast({ message: errorText(err), kind: "error" });
  return (
    <SettingsBox data-settings-box="skills">
      {loading && <p className={styles.mEmpty}><Spinner size={16} /> {t("Reading skills…")}</p>}
      {error && <p className={styles.mEmpty} data-skills-error="">{error}</p>}
      {!loading && !error && !list.length && <p className={styles.mEmpty}>{t("No skills yet.")}</p>}
      {list.map((s) => (
        <BoxRow
          key={s.id}
          title={`/${s.name}`}
          badge={s.origin && <Badge className={styles.rowBadge} data-skill-default={s.origin}>{s.origin === "override" ? t("Edited") : t("Default")}</Badge>}
          desc={s.description}
          dim={!s.enabled}
          data-skill={s.name}
        >
          <Switch label={`/${s.name}`} checked={s.enabled} onChange={(on) => void toggleSkill(s, on).catch(fail)} data-skill-switch={s.name} />
          <MenuButton
            label={t("More")}
            tooltip
            className={styles.barButton}
            align="end"
            entries={[{ id: "edit", label: t("Edit") }, ...(s.origin === "override" ? [{ id: "reset", label: t("Reset to default") }] : []), ...(!s.origin ? [{ id: "remove", label: t("Remove") }] : [])]}
            onSelect={(id) => {
              if (id === "edit") service.openSetting(`skill:${s.id}`);
              else if (id === "reset") void resetSkill(s).then(() => showToast({ message: t("Skill reset to default") }), fail);
              else if (id === "remove") void removeSkill(s.id).catch(fail);
            }}
          >
            <Icon name="24.more" />
          </MenuButton>
        </BoxRow>
      ))}
    </SettingsBox>
  );
}

// ---- Connectors ----

function ConnectorsSection({ service }: { service: AgentsService }) {
  useT();
  const state = service.get();
  const api = service.api;
  const { list, error } = useConnectors(api);
  const n = state.mcp.connections.length;
  return (
    <>
      {api?.connectors && (
        <SettingsBox
          label={t("MCP servers")}
          action={
            <Button variant="secondary" onClick={() => service.openSetting("add-connector")} data-settings-row="add-connector">
              {t("Add")}
            </Button>
          }
          data-settings-box="connectors"
        >
          {error && <p className={styles.mEmpty}>{error}</p>}
          {!error && !list.length && <p className={styles.mEmpty}>{t("No connectors yet.")}</p>}
          {list.map((c) => (
            <BoxRow key={c.id} icon="24.link" title={c.name} desc={connectorStatus(c)} dim={!c.enabled} data-connector={c.id}>
              {api.updateConnector && <Switch label={t("{name} on", { name: c.name })} checked={c.enabled} onChange={(on) => void changeConnectors(api.updateConnector!({ id: c.id, enabled: on })).catch((err) => showToast({ message: errorText(err), kind: "error" }))} />}
              <Details label={t("{name} details", { name: c.name })} onClick={() => service.openSetting(`connector:${c.id}`)} />
            </BoxRow>
          ))}
        </SettingsBox>
      )}
      <SettingsBox label={t("Connect other apps")} note={t("Apps on this computer that have its token can read and edit the file in front.")} data-settings-box="apps">
        <BoxRow icon="24.link" title={t("MCP server")} desc={state.mcp.url ? <span className={styles.mono}>{state.mcp.url}</span> : t("Not running")} data-settings-row="mcp">
          <span className={styles.mCount}>{tp(n, "{n} connection", "{n} connections")}</span>
          {state.mcp.url && <IconButton icon="24.copy.small" label={t("Copy URL")} tone="secondary" onClick={() => void navigator.clipboard.writeText(state.mcp.url!).then(() => showToast({ message: t("Copied to clipboard") }))} />}
          <Details label={t("MCP server")} onClick={() => service.openSetting("mcp")} />
        </BoxRow>
        {state.clients.map((c) => (
          <BoxRow key={c.id} icon="24.plugin" title={c.label} desc={c.connected ? t("Connected") : c.installed ? t("Not connected") : t("Not installed")} dim={!c.installed} data-client={c.id} data-connected={c.connected ? "" : undefined}>
            <Details label={t("{name} details", { name: c.label })} onClick={() => service.openSetting(`client:${c.id}`)} />
          </BoxRow>
        ))}
      </SettingsBox>
    </>
  );
}

// ---- Access ----

const LOG_SHOWN = 8;

function AccessSection({ service }: { service: AgentsService }) {
  useT();
  const { view, error } = useReach(service);
  const a = service.api?.reach;
  const [log, setLog] = useState<AccessLogEntry[] | null>(null);
  useEffect(() => {
    if (a) void a.log().then(setLog, () => setLog([]));
  }, [a]);
  if (!a) return <p className={styles.mAbout}>{t("Access works in the desktop app.")}</p>;
  const when = new Intl.DateTimeFormat(intlLocale(), { dateStyle: "short", timeStyle: "short" });
  const label = (cap: ReachCapability) => t(CAPABILITIES.find((c) => c.cap === cap)?.label ?? cap);
  return (
    <>
      <SettingsBox label={t("What agents can reach")} note={t("Ask each time shows a card in the chat before each use; Always allow lets agents use it without asking. Every use is in the access log.")} data-settings-box="access">
        {error && <p className={styles.mEmpty}>{error}</p>}
        {!view && !error && <p className={styles.mEmpty}><Spinner size={16} /></p>}
        {view &&
          CAPABILITIES.map(({ cap, label: name, icon, about }) => {
            const forced = view.forcedOff.includes(cap);
            const policy = forced ? "off" : view.settings.policies[cap];
            return (
              <BoxRow key={cap} icon={icon} title={t(name)} desc={forced ? t("Turned off by your organization") : t(about)} dim={policy === "off"} data-access={cap} data-access-policy={forced ? "forced-off" : policy}>
                <Select label={t("{name} access", { name: t(name) })} variant="filled" width={FIELD_WIDTH} disabled={forced} value={policy} options={POLICIES.map((o) => ({ ...o, label: t(o.label) }))} onChange={(v) => void changeReach((x) => x.set({ policies: { [cap]: v as ReachPolicy } }))} data-access-select={cap} />
                <Details label={t("{name} details", { name: t(name) })} onClick={() => service.openSetting(`access:${cap}`)} />
              </BoxRow>
            );
          })}
      </SettingsBox>
      <SettingsBox
        label={t("Access log")}
        action={
          log && log.length > 0 ? (
            <Button variant="secondary" onClick={() => void a.clearLog().then(() => setLog([]))} data-access-clear-log="">
              {t("Clear log")}
            </Button>
          ) : undefined
        }
        data-settings-box="access-log"
      >
        {!log && <p className={styles.mEmpty}><Spinner size={16} /></p>}
        {log && !log.length && <p className={styles.mEmpty}>{t("Nothing yet. Each time an agent reaches outside the file, it is listed here.")}</p>}
        {log?.slice(0, LOG_SHOWN).map((e, i) => (
          <BoxRow key={`${e.at}-${i}`} title={`${label(e.capability)} · ${e.target}`} desc={[when.format(e.at), e.agent, e.tool].filter(Boolean).join(" · ")} data-log-outcome={e.outcome}>
            <span className={cx(styles.mCount, e.outcome !== "ok" && styles.mDanger)}>{t(OUTCOME[e.outcome])}</span>
          </BoxRow>
        ))}
        {log && log.length > LOG_SHOWN && (
          <BoxRow title={tp(log.length - LOG_SHOWN, "{n} more", "{n} more")} data-access-log-more="">
            <Details label={t("Access log")} onClick={() => service.openSetting("access:log")} />
          </BoxRow>
        )}
      </SettingsBox>
    </>
  );
}

// ---- Usage ----

const startOfToday = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

/** Usage: a card per connected agent — each plan window's bar, how much is used and when it resets; its tokens in this chat and today. */
function UsageSection({ service }: { service: AgentsService }) {
  useT();
  const state = service.get();
  const agents = state.providers.filter((p) => p.available);
  useEffect(() => {
    for (const p of agents) void service.refreshUsage(p.id);
    // Once per opening, for the agents connected then.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [service, agents.length]);
  if (!agents.length) return <p className={styles.mAbout}>{t("No agent is connected.")}</p>;
  const chat = service.currentChat();
  const today = startOfToday();
  const tokensOf = (c: { tokens?: { input: number; output: number } } | null | undefined) => (c?.tokens ? c.tokens.input + c.tokens.output : 0);
  return (
    <div className={styles.mUsage} data-settings-box="usage">
      {agents.map((p) => {
        const info = state.usage[p.id];
        const windows = relevantWindows(info, service.modelOf(p));
        const inChat = chat?.providerId === p.id ? tokensOf(chat) : 0;
        const inDay = state.chats.filter((c) => c.providerId === p.id && c.updatedAt >= today).reduce((n, c) => n + tokensOf(c), 0);
        return (
          <section key={p.id} className={cx(styles.popUsageCard, styles.mUsageCard)} data-usage-agent={p.id}>
            <h3 className={styles.popUsageName}>
              <AgentMark providerId={p.id} />
              <span className={styles.popUsageLabel}>{p.auth?.plan ? `${p.label} · ${p.auth.plan}` : p.label}</span>
            </h3>
            {windows.map((w) => (
              <div key={`${w.group ?? ""}${w.label}`} className={styles.usageRow} data-usage-window="">
                <div className={styles.usageLine}>
                  <span className={styles.usageLabel}>{w.group ? `${w.group} · ${w.label}` : w.label}</span>
                  <span className={styles.usagePct}>{usedLabel(w)}</span>
                </div>
                <span className={styles.usageBar}>
                  <span className={styles.usageBarFill} data-usage={ringOf([w]).state} style={{ width: `${Math.max(0, Math.min(100, w.usedPct))}%` }} />
                </span>
                {resetLabel(w) && <span className={styles.popUsageCaption}>{resetLabel(w)}</span>}
              </div>
            ))}
            {!windows.length && <p className={styles.popUsageCaption}>{info === undefined ? t("Reading the plan’s limits…") : t("{name} doesn’t report its plan’s limits here.", { name: p.label })}</p>}
            <div className={styles.mUsageTokens}>
              <span className={styles.usageLine}>
                <span className={styles.popUsageCaption}>{t("This chat")}</span>
                <span className={styles.usagePct}>{t("{tokens} tokens", { tokens: formatTokens(inChat) })}</span>
              </span>
              <span className={styles.usageLine}>
                <span className={styles.popUsageCaption}>{t("Today")}</span>
                <span className={styles.usagePct} data-usage-today="">{t("{tokens} tokens", { tokens: formatTokens(inDay) })}</span>
              </span>
            </div>
          </section>
        );
      })}
    </div>
  );
}
