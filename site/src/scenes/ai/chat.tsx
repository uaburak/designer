// The Agents panel's chat, as the app draws it (editor/panels/agents/Agents.module.css): the tab's header, the
// visitor's bubble, the agent's step groups and text, the composer. The newest line stays at the bottom.
import type { ReactNode } from "react";
import { Icon } from "@/ds/icons/Icon";
import { cx } from "@/ds/util/cx";
import agents from "@/editor/panels/agents/Agents.module.css";
import { toolLabel } from "@/editor/agents/service";
import styles from "./ai.module.css";

export { agents };

export function ChatPanel({ title = "Agents", children, composer = "Ask for changes, or describe what to make", agent = "Claude Code" }: { title?: string; children: ReactNode; composer?: string; agent?: string }) {
  return (
    <div className={styles.chatPanel}>
      <div className={styles.tabHeader}>
        <span>{title}</span>
        <Icon name="24.more" />
      </div>
      <div className={styles.chatBody}>
        <div className={styles.chatInner}>{children}</div>
      </div>
      <div className={agents.composer}>
        <span className={styles.composerText}>{composer}</span>
        <span className={styles.composerFoot}>
          <span className={styles.composerAgent}>{agent}</span>
          <span className={styles.send}>
            <Icon name="16.arrow.up" />
          </span>
        </span>
      </div>
    </div>
  );
}

export function UserMessage({ children }: { children: ReactNode }) {
  return (
    <div className={agents.user}>
      <div className={agents.userBubble}>{children}</div>
    </div>
  );
}

export interface Step {
  name: string;
  done: boolean;
}

/** A group of tool steps: "Thinking…" while one runs, then the last step's label. */
export function Steps({ steps }: { steps: Step[] }) {
  if (!steps.length) return null;
  const active = steps.some((s) => !s.done);
  const last = steps[steps.length - 1];
  return (
    <div className={agents.stepGroup}>
      <div className={agents.groupHeader}>
        <span className={cx(agents.groupIcon, active && agents.groupIconActive)}>
          <Icon name="24.agents" />
        </span>
        <span className={cx(agents.groupLabel, active && agents.thinkingText)}>{active ? "Thinking…" : toolLabel(last.name)}</span>
      </div>
      <div className={agents.groupSteps}>
        {steps.map((s, i) => (
          <div key={i} className={agents.tool}>
            <span className={agents.toolIcon}>{s.done ? <Icon name="16.check" /> : <Icon name="24.recent" />}</span>
            <span className={agents.toolLabel}>{toolLabel(s.name)}</span>
            <code className={styles.toolName}>{s.name}</code>
          </div>
        ))}
      </div>
    </div>
  );
}

export function AgentText({ children }: { children: ReactNode }) {
  return (
    <div className={agents.agentText}>
      <p className={agents.para}>{children}</p>
    </div>
  );
}
