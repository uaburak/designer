/**
 * The Agents tab's gear: "This chat", a small popover with what one changes while chatting, in boxed sections — Model
 * (the manager on or off, the model and its effort), Approvals (how agents ask before reaching outside the file, for the
 * Access capabilities that aren't off), Skills (on or off), Usage (a card per agent with what its plan used: the
 * Usage page's data, AgentSettingsModal.tsx) — and "All settings…", the detailed Agent settings modal.
 */
import { useEffect, type ReactNode } from "react";
import { Badge, Popover, Select, Switch, size } from "@/ds";
import type { ReachCapability, ReachPolicy } from "@shared/agents/reach";
import type { AgentsService } from "../../agents/service";
import { managerName } from "../../agents/managerName";
import { formatTokens, relevantWindows, resetLabel, ringOf, usedLabel } from "../../agents/usage";
import { EffortPicker, ModelPicker } from "./ModelPicker";
import { toggleSkill, useSkills } from "./aiData";
import { CAPABILITIES, changeReach, useReach } from "./AccessSettings";
import { AgentMark } from "./AgentMark";
import styles from "./Agents.module.css";
import { t, useT } from "@/i18n";

/** The skills the popover lists (the rest are in All settings). */
const QUICK_SKILLS = 6;
const FIELD_WIDTH = 128;

export function ChatSettings({ service, anchor, onClose }: { service: AgentsService; anchor: HTMLElement | null; onClose: () => void }) {
  useT();
  const provider = service.activeProvider();
  const manager = service.managerSettings();
  const { list: skills } = useSkills();
  return (
    <Popover anchor={anchor} placement="bottom-end" title={t("This chat")} draggable={false} width={size["dialog-small"]} onClose={onClose}>
      <div className={styles.pop} data-chat-settings="">
        <Section label={t("Model")} id="model">
          <div className={styles.popRow}>
            <span className={styles.popLabelMain}>{managerName(manager)}</span>
            <Switch label={managerName(manager)} checked={manager.enabled} onChange={(on) => void service.setManager({ enabled: on })} data-chat-manager="" />
          </div>
          <div className={styles.popRow}>
            <span className={styles.popLabel}>{t("Model")}</span>
            <ModelPicker service={service} provider={provider} variant="filled" width={FIELD_WIDTH} withEffort={false} />
          </div>
          {provider && !service.managerProvider() && (
            <div className={styles.popRow} data-chat-effort="">
              <span className={styles.popLabel}>{t("Effort")}</span>
              <EffortPicker service={service} provider={provider} variant="filled" width={FIELD_WIDTH} />
            </div>
          )}
        </Section>
        <Approvals service={service} />
        {skills.length > 0 && (
          <Section label={t("Skills")} id="skills">
            {skills.slice(0, QUICK_SKILLS).map((s) => (
              <div key={s.id} className={styles.popRow} data-chat-skill={s.name}>
                <span className={styles.popLabelMain}>/{s.name}</span>
                {s.origin && <Badge className={styles.rowBadge}>{s.origin === "override" ? t("Default · edited") : t("Default")}</Badge>}
                <Switch label={`/${s.name}`} checked={s.enabled} onChange={(on) => void toggleSkill(s, on)} />
              </div>
            ))}
          </Section>
        )}
        <UsageCards service={service} />
        <button
          type="button"
          className={styles.popLink}
          onClick={() => {
            onClose();
            service.setView("settings");
          }}
          data-all-settings=""
        >
          {t("All settings…")}
        </button>
      </div>
    </Popover>
  );
}

/** A small label over a box of rows with lines between them. */
function Section({ label, id, children }: { label: string; id: string; children: ReactNode }) {
  return (
    <section className={styles.popSection} data-chat-section={id}>
      <h3 className={styles.popSectionLabel}>{label}</h3>
      <div className={styles.popBox}>{children}</div>
    </section>
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
    <Section label={t("Approvals")} id="approvals">
      <div className={styles.popRow} data-chat-approvals="">
        <span className={styles.popLabel}>{t("Ask before reaching out")}</span>
        <Select
          label={t("Approvals")}
          width={FIELD_WIDTH}
          value={value}
          options={[{ value: "ask", label: t("Ask each time") }, { value: "allow", label: t("Always allow") }, ...(value === MIXED ? [{ value: MIXED, label: t("Custom"), disabled: true }] : [])]}
          onChange={(v) => {
            if (v === MIXED) return;
            const patch = Object.fromEntries(on.map((cap) => [cap, v as ReachPolicy])) as Partial<Record<ReachCapability, ReachPolicy>>;
            void changeReach((a) => a.set({ policies: patch }));
          }}
        />
      </div>
    </Section>
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
    <section className={styles.popSection} data-chat-section="usage">
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
