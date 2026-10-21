/**
 * Who works, at 16 px, wherever the Agents panel names an agent: its own mark (ds AgentLogo — Claude Code, Codex,
 * Antigravity, Cursor), Wecra's manager its sparkle, anything else (a server, a custom one) the Agents glyph.
 */
import { AgentLogo, Icon, cx, hasAgentLogo } from "@/ds";
import type { ProviderInfo } from "@shared/agents/types";
import styles from "./Agents.module.css";

export function AgentMark({ providerId, manager, className }: { providerId?: string | null; manager?: boolean; className?: string }) {
  return (
    <span className={cx(styles.mark, className)} aria-hidden="true" data-agent-mark={manager ? "manager" : (providerId ?? "")}>
      {manager ? <Icon name="16.sparkle" /> : hasAgentLogo(providerId) ? <AgentLogo id={providerId} /> : <Icon name="24.agents" size={16} />}
    </span>
  );
}

/** An agent's id from its label (answers saved before they kept the id). */
export const providerIdOf = (label: string | undefined, providers: readonly ProviderInfo[]): string | undefined => (label ? providers.find((p) => p.label === label)?.id : undefined);
