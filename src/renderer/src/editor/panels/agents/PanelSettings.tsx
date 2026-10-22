/**
 * Agent settings, inside the Agents panel (the gear; `setView("settings")` / `openSetting(…)` from elsewhere): it takes
 * the list's or the chat's place, the panel's header becoming Back and the page's title (Back from the home returns to
 * the list or the chat as it was). The home: "This chat" (the manager, the model and its effort, approvals), a box of
 * the pages — Agents and models, Manager and Studio, Skills, Connectors, Access, Usage — and a usage card per agent. A
 * page is boxed sections (SettingsBox / BoxRow); a detail (an agent, a skill's editor, a connector's tools) opens in
 * place with Back to its page. The logic is the settings pages' own (AgentSettings.tsx, aiSettings.tsx,
 * AccessSettings.tsx, ManagerSettings.tsx, aiData.ts).
 */
import { useEffect, useState, type ReactNode } from "react";
import { AgentLogo, Badge, Button, Icon, IconButton, MenuButton, Select, Spinner, Switch, cx, hasAgentLogo, showToast, type IconName } from "@/ds";
import type { AccessLogEntry, ReachCapability, ReachPolicy } from "@shared/agents/reach";
import type { ProviderInfo } from "@shared/agents/types";
import { settingsSectionOf, type AgentsService, type SettingsSection } from "../../agents/service";
import { modelLabel } from "../../agents/setup";
import { shortModelName } from "../../agents/models";
import { managerName } from "../../agents/managerName";
import { formatTokens, relevantWindows, resetLabel, ringOf, usedLabel } from "../../agents/usage";
import { KIND_ICON, LookAgain, isCustom, isServer, settingsPageOf, stateText } from "./AgentSettings";
import { connectorStatus } from "./aiSettings";
import { CAPABILITIES, OUTCOME, POLICIES, changeReach, useReach } from "./AccessSettings";
import { ManagerPage } from "./ManagerSettings";
import { EffortPicker, ModelPicker } from "./ModelPicker";
import { changeConnectors, removeSkill, resetSkill, toggleSkill, useConnectors, useSkills } from "./aiData";
import { BoxRow, NavRow, SettingsBox, errorText } from "./settingsParts";
import { AgentMark } from "./AgentMark";
import styles from "./Agents.module.css";
import { intlLocale, t, tp, useT } from "@/i18n";

const SECTIONS: { id: SettingsSection; label: string; about: string; nav?: string; icon: IconName }[] = [
  { id: "agents", label: "Agents and models", about: "The agents on this computer and the models they use for new chats.", icon: "24.agents" },
  { id: "manager", label: "Manager and Studio", about: "The manager plans the work, hands it to other agents and reviews what they make.", icon: "24.person" },
  { id: "skills", label: "Skills", about: "Agents use a skill when it fits the task; type /name in a message to call one.", icon: "24.file" },
  { id: "connectors", label: "Connectors", about: "MCP servers your agents can use, and the apps that connect to this one.", icon: "24.link" },
  { id: "access", label: "Access", about: "How far agents can reach outside this file.", nav: "What agents can reach, and the access log.", icon: "24.lock.small" },
  { id: "usage", label: "Usage", about: "What each agent’s plan has used, as its CLI reports it.", icon: "24.recent" },
];

/** What the panel shows while Agent settings is open: its header's title, Back and action, and the page under it. */
export function panelSettings(service: AgentsService): { title: string; back: () => void; actions?: ReactNode; body: ReactNode } {
  const item = service.get().settingsItem;
  if (!item) return { title: t("Agent settings"), back: () => service.closeSettings(), body: <SettingsHome service={service} /> };
  const section = settingsSectionOf(item);
  if (section && (item.startsWith("section:") || item === "manager")) {
    const info = SECTIONS.find((s) => s.id === section)!;
    return { title: t(info.label), back: () => service.openSetting(null), actions: <PageAction service={service} section={section} />, body: <SectionPage service={service} section={section} about={info.about} /> };
  }
  const page = settingsPageOf(service, item);
  return {
    title: page.title,
    back: () => {
      service.openSetting(null);
      void service.refreshProviders();
    },
    body: (
      <div className={styles.settings} data-agent-settings="" data-settings-page={item}>
        <div className={cx(styles.scroll, styles.page)}>{page.body}</div>
      </div>
    ),
  };
}

// ---- The home ----

function SettingsHome({ service }: { service: AgentsService }) {
  useT();
  return (
    <div className={cx(styles.scroll, styles.psPage)} data-agent-settings="" data-settings-page="home">
      <ThisChat service={service} />
      <SettingsBox label={t("Settings")} data-settings-box="pages">
        {SECTIONS.map((s) => (
          <NavRow key={s.id} icon={s.icon} title={t(s.label)} desc={t(s.nav ?? s.about)} onClick={() => service.openSetting(`section:${s.id}`)} data-settings-nav={s.id} />
        ))}
      </SettingsBox>
      <UsageCards service={service} />
    </div>
  );
}

/** A select in a row: it shrinks with the panel. */
function Field({ children, small }: { children: ReactNode; small?: boolean }) {
  return <span className={cx(styles.psField, small && styles.psFieldSmall)}>{children}</span>;
}

/** What one changes while chatting: the manager on or off, the model and its effort, how agents ask before reaching out. */
function ThisChat({ service }: { service: AgentsService }) {
  useT();
  const provider = service.activeProvider();
  const manager = service.managerSettings();
  return (
    <SettingsBox label={t("This chat")} data-chat-settings="" data-settings-box="chat">
      <BoxRow title={managerName(manager)} data-chat-section="manager">
        <Switch label={managerName(manager)} checked={manager.enabled} onChange={(on) => void service.setManager({ enabled: on })} data-chat-manager="" />
      </BoxRow>
      <BoxRow title={t("Model")} data-chat-section="model">
        <Field>
          <ModelPicker service={service} provider={provider} variant="filled" withEffort={false} width={undefined} />
        </Field>
      </BoxRow>
      {provider && !service.managerProvider() && (
        <BoxRow title={t("Effort")} data-chat-effort="">
          <Field>
            <EffortPicker service={service} provider={provider} variant="filled" width={undefined} />
          </Field>
        </BoxRow>
      )}
      <Approvals service={service} />
    </SettingsBox>
  );
}

const MIXED = "mixed";

/**
 * Approvals: how the reach that is on asks — Ask each time or Always allow, for every capability that isn't off (Off
 * ones stay off: turning one on is Access's own page). Mixed policies read "Custom".
 */
function Approvals({ service }: { service: AgentsService }) {
  useT();
  const { view } = useReach(service);
  if (!service.api?.reach || !view) return null;
  const on = CAPABILITIES.map((c) => c.cap).filter((cap) => !view.forcedOff.includes(cap) && view.settings.policies[cap] !== "off");
  if (!on.length) return null;
  const policies = new Set(on.map((cap) => view.settings.policies[cap]));
  const value = policies.size === 1 ? [...policies][0] : MIXED;
  return (
    <BoxRow title={t("Approvals")} data-chat-approvals="">
      <Field>
        <Select
          label={t("Approvals")}
          value={value}
          options={[{ value: "ask", label: t("Ask each time") }, { value: "allow", label: t("Always allow") }, ...(value === MIXED ? [{ value: MIXED, label: t("Custom"), disabled: true }] : [])]}
          onChange={(v) => {
            if (v === MIXED) return;
            const patch = Object.fromEntries(on.map((cap) => [cap, v as ReachPolicy])) as Partial<Record<ReachCapability, ReachPolicy>>;
            void changeReach((a) => a.set({ policies: patch }));
          }}
        />
      </Field>
    </BoxRow>
  );
}

/**
 * Usage: a card per connected agent that reports something — its most used plan window (the bar, "12% used", when it
 * resets), else this chat's tokens with it (no limit known: an empty bar, nothing invented).
 */
function UsageCards({ service }: { service: AgentsService }) {
  useT();
  const state = service.get();
  const agents = state.providers.filter((p) => p.available);
  useEffect(() => {
    for (const p of agents) void service.refreshUsage(p.id);
    // Once per opening, for the agents connected then.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [service, agents.length]);
  const chat = service.currentChat();
  const cards = agents.flatMap((p) => {
    const windows = relevantWindows(state.usage[p.id], service.modelOf(p));
    if (windows.length) {
      const top = windows.reduce((a, b) => (b.usedPct > a.usedPct ? b : a));
      return [{ p, pct: Math.max(0, Math.min(100, top.usedPct)), state: ringOf([top]).state, amount: usedLabel(top), caption: resetLabel(top) ?? top.label }];
    }
    const tokens = chat?.providerId === p.id && chat.tokens ? chat.tokens.input + chat.tokens.output : 0;
    return tokens ? [{ p, pct: 0, state: "none" as const, amount: t("{tokens} tokens", { tokens: formatTokens(tokens) }), caption: t("This chat") }] : [];
  });
  if (!cards.length) return null;
  return (
    <section className={styles.mSection} data-chat-section="usage">
      <h3 className={styles.popSectionLabel}>{t("Usage")}</h3>
      <div className={styles.popUsage}>
        {cards.map((c) => (
          <div key={c.p.id} className={styles.popUsageCard} data-chat-usage={c.p.id}>
            <span className={styles.popUsageName}>
              <AgentMark providerId={c.p.id} />
              <span className={styles.popUsageLabel}>{c.p.label}</span>
            </span>
            <span className={styles.usageBar}>
              <span className={styles.usageBarFill} data-usage={c.state} style={{ width: `${c.pct}%` }} />
            </span>
            <span className={styles.popUsageAmount}>{c.amount}</span>
            <span className={styles.popUsageCaption}>{c.caption}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

// ---- A page ----

function SectionPage({ service, section, about }: { service: AgentsService; section: SettingsSection; about: string }) {
  useT();
  useEffect(() => {
    if (section === "agents") void service.refreshProviders();
  }, [service, section]);
  return (
    <div className={cx(styles.scroll, styles.psPage)} data-agent-settings="" data-settings-page={section} data-settings-section={section}>
      <p className={styles.mAbout}>{t(about)}</p>
      <SectionBody service={service} section={section} />
    </div>
  );
}

function PageAction({ service, section }: { service: AgentsService; section: SettingsSection }) {
  useT();
  if (section === "agents") return <LookAgain service={service} />;
  if (section === "skills") return <IconButton icon="24.plus" label={t("New skill")} tone="secondary" onClick={() => service.openSetting("add-skill")} data-new-skill="" />;
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
        <Field>
          <Select
            label={t("{name} model", { name: p.label })}
            variant="filled"
            value={service.modelOf(p) ?? ""}
            options={p.models.map((m) => ({ value: m, label: modelLabel(m, p), valueLabel: shortModelName(modelLabel(m, p)) }))}
            onChange={(m) => void service.choose(p.id, m)}
            data-provider-model={p.id}
          />
        </Field>
      )}
      {p.available && (
        <Field small>
          <EffortPicker service={service} provider={p} variant="filled" width={undefined} />
        </Field>
      )}
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
                <Field>
                  <Select label={t("{name} access", { name: t(name) })} variant="filled" disabled={forced} value={policy} options={POLICIES.map((o) => ({ ...o, label: t(o.label) }))} onChange={(v) => void changeReach((x) => x.set({ policies: { [cap]: v as ReachPolicy } }))} data-access-select={cap} />
                </Field>
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
