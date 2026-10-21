/**
 * Agent settings, all of it ("This chat" › All settings…, the chats' "•••", the MCP section's button): a modal in
 * Wecra's dialog look with a nav at the left like Manage libraries — Agents and models, Manager and Studio, Skills,
 * Connectors, Access, Usage. Each section is the settings list's own groups and pages (AgentSettings.tsx,
 * aiSettings.tsx, AccessSettings.tsx, ManagerSettings.tsx — the same components, not copies); a row opens its page in
 * place, with Back to the section. The panel itself never turns into settings.
 */
import { useEffect, useState, type ReactNode } from "react";
import { Dialog, Icon, cx, type IconName } from "@/ds";
import type { AgentsService } from "../../agents/service";
import { relevantWindows, resetLabel, ringOf, usedLabel } from "../../agents/usage";
import { Bar, LookAgain, McpGroup, ProviderGroups, SettingsPage } from "./AgentSettings";
import { ConnectorsGroup, SkillsGroup } from "./aiSettings";
import { AccessGroup } from "./AccessSettings";
import { ManagerPage } from "./ManagerSettings";
import { AgentMark } from "./AgentMark";
import styles from "./Agents.module.css";
import { t, useT } from "@/i18n";

export type SettingsSection = "agents" | "manager" | "skills" | "connectors" | "access" | "usage";

const SECTIONS: { id: SettingsSection; label: string; icon: IconName }[] = [
  { id: "agents", label: "Agents and models", icon: "24.agents" },
  { id: "manager", label: "Manager and Studio", icon: "24.person" },
  { id: "skills", label: "Skills", icon: "24.file" },
  { id: "connectors", label: "Connectors", icon: "24.link" },
  { id: "access", label: "Access", icon: "24.lock.small" },
  { id: "usage", label: "Usage", icon: "24.recent" },
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
  // The manager's section is its page; another item's page shows in its own section.
  const page = item && item !== "manager" && !item.startsWith("section:") && sectionOf(item) === section ? item : null;
  const label = t(SECTIONS.find((s) => s.id === section)!.label);
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
        <div className={cx(styles.settings, styles.embedded, styles.settingsContent)} role="tabpanel" aria-label={label} data-agent-settings="" data-settings-page={page ?? section}>
          {page ? <SettingsPage service={service} item={page} /> : <SectionList service={service} section={section} label={label} />}
        </div>
      </div>
    </Dialog>
  );
}

function SectionList({ service, section, label }: { service: AgentsService; section: SettingsSection; label: string }) {
  useT();
  let body: ReactNode = null;
  let action: ReactNode = null;
  if (section === "agents") {
    body = (
      <>
        <ProviderGroups service={service} />
        <p className={styles.footnote}>{t("Connected agents show up in the chat’s agent menu.")}</p>
      </>
    );
    action = <LookAgain service={service} />;
  } else if (section === "manager") body = <ManagerPage service={service} />;
  else if (section === "skills") body = <SkillsGroup service={service} />;
  else if (section === "connectors")
    body = (
      <>
        <ConnectorsGroup service={service} />
        <McpGroup service={service} />
      </>
    );
  else if (section === "access") body = <AccessGroup service={service} />;
  else body = <UsageSection service={service} />;
  // Skills, Connectors and Access open on their own group's title: no heading of the same words over it.
  const titled = section === "agents" || section === "manager" || section === "usage";
  return (
    <>
      {titled && <Bar title={label} action={action} />}
      <div className={styles.scroll}>{body}</div>
    </>
  );
}

/** Usage: each connected agent's plan limits as its CLI reports them (the composer's ring, for every agent). */
function UsageSection({ service }: { service: AgentsService }) {
  useT();
  const state = service.get();
  const agents = state.providers.filter((p) => p.available);
  useEffect(() => {
    for (const p of agents) void service.refreshUsage(p.id);
    // Once per opening, for the agents connected then.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [service, agents.length]);
  if (!agents.length) return <p className={styles.pageText}>{t("No agent is connected.")}</p>;
  return (
    <>
      {agents.map((p) => {
        const info = state.usage[p.id];
        const windows = relevantWindows(info, service.modelOf(p));
        return (
          <section key={p.id} className={styles.usageSection} data-usage-agent={p.id}>
            <h3 className={styles.usageSectionTitle}>
              <AgentMark providerId={p.id} />
              <span>{p.auth?.plan ? `${p.label} · ${p.auth.plan}` : p.label}</span>
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
                {resetLabel(w) && <span className={styles.usageReset}>{resetLabel(w)}</span>}
              </div>
            ))}
            {!windows.length && <p className={styles.usageNote}>{info === undefined ? t("Reading the plan’s limits…") : t("{name} doesn’t report its plan’s limits here.", { name: p.label })}</p>}
          </section>
        );
      })}
    </>
  );
}
