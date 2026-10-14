// The Agents panel's chat, as the app draws it (editor/panels/agents/Agents.module.css): the tab's header, the
// visitor's bubble, the agent's step groups and text, the composer. The newest line stays at the bottom.
import { useEffect, useRef, type ReactNode } from "react";
import { Icon } from "@/ds/icons/Icon";
import { cx } from "@/ds/util/cx";
import agents from "@/editor/panels/agents/Agents.module.css";
import { toolLabel } from "@/editor/agents/service";
import { BEZIER, css } from "../runtime/easing";
import { prefersReduced } from "../runtime/reduced";
import styles from "./ai.module.css";

export { agents };

/**
 * The chat's motion: what's added rises in (each new block, once), and the conversation, anchored at the bottom, slides
 * up to make room instead of jumping (FLIP on the inner column: its layout moves once, a transform eases it there,
 * without overshoot).
 */
function useChatMotion(inner: { current: HTMLDivElement | null }) {
  useEffect(() => {
    const el = inner.current;
    if (!el || prefersReduced() || typeof el.animate !== "function") return;
    let top = el.offsetTop;
    let slide: Animation | null = null;
    const ro = new ResizeObserver(() => {
      const now = el.offsetTop;
      let dy = top - now;
      top = now;
      if (slide && slide.playState === "running") {
        dy += parseFloat(getComputedStyle(el).translate.split(" ")[1] ?? "0") || 0;
        slide.cancel();
      }
      if (Math.abs(dy) < 0.5) return;
      slide = el.animate([{ translate: `0 ${dy}px` }, { translate: "0 0" }], { duration: 560, easing: css(BEZIER.out) });
    });
    ro.observe(el);
    const mo = new MutationObserver((records) => {
      for (const r of records)
        for (const n of r.addedNodes) {
          if (!(n instanceof HTMLElement) || n.closest("svg")) continue;
          n.animate([{ opacity: 0, translate: "0 8px" }, { opacity: 1, translate: "0 0" }], { duration: 520, easing: css(BEZIER.out), delay: 60, fill: "backwards" });
        }
    });
    mo.observe(el, { childList: true, subtree: true });
    return () => {
      ro.disconnect();
      mo.disconnect();
    };
  }, [inner]);
}

export function ChatPanel({ title = "Agents", children, composer = "Ask for changes, or describe what to make", agent = "Claude Code", focus }: { title?: string; children: ReactNode; composer?: string; agent?: string; /** The composer has focus (a caret blinks in it): the chat at rest, waiting for the next ask. */ focus?: boolean }) {
  const inner = useRef<HTMLDivElement>(null);
  useChatMotion(inner);
  return (
    <div className={styles.chatPanel}>
      <div className={styles.tabHeader}>
        <span>{title}</span>
        <Icon name="24.more" />
      </div>
      <div className={styles.chatBody}>
        <div ref={inner} className={styles.chatInner}>
          {children}
        </div>
      </div>
      <div className={agents.composer}>
        <span className={styles.composerText}>
          {focus && <span className={styles.composerCaret} />}
          {composer}
        </span>
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
