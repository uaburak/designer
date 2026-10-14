/**
 * Settings › Agents (ours — the owner's: the settings of our own AIs): the Agents tab's Agent settings — On this
 * computer, Servers, Connect other apps, each row's page — in the modal (panels/agents/AgentSettings.tsx with the
 * modal's host, agents/setup.ts AgentSetupService; the same components, not a copy).
 */
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { AgentSettings } from "../editor/panels/agents/AgentSettings";
import { AgentSetupService } from "../editor/agents/setup";
import { agentSetupBridge } from "./bridge";
import { t, useT } from "@/i18n";
import styles from "./Settings.module.css";

export function AgentsTab() {
  useT();
  const service = useMemo(() => new AgentSetupService(agentSetupBridge()), []);
  useSyncExternalStore(service.subscribe, service.get);
  useEffect(() => service.start(), [service]);
  if (!service.api)
    return (
      <div className={styles.page}>
        <p className={`${styles.text} ${styles.muted}`}>{t("Agents run in the desktop app.")}</p>
      </div>
    );
  return (
    <div className={styles.agents} data-settings-agents="">
      <AgentSettings service={service} embedded />
    </div>
  );
}
