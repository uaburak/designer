/**
 * The Agents tab's gear: "This chat", a small popover with what one changes while chatting — the manager on or off, the
 * model and its effort, how agents ask before reaching outside the file (Agent settings › Access, for the ones that
 * aren't off), the skills on or off — and "All settings…", the detailed Agent settings modal (AgentSettingsModal.tsx).
 */
import { Badge, Popover, Select, Switch } from "@/ds";
import type { ReachCapability, ReachPolicy } from "@shared/agents/reach";
import type { AgentsService } from "../../agents/service";
import { managerName } from "../../agents/managerName";
import { EffortPicker, ModelPicker } from "./ModelPicker";
import { toggleSkill, useSkills } from "./aiData";
import { CAPABILITIES, changeReach, useReach } from "./AccessSettings";
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
    <Popover anchor={anchor} placement="bottom-end" title={t("This chat")} draggable={false} onClose={onClose}>
      <div className={styles.pop} data-chat-settings="">
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
        <Approvals service={service} />
        {skills.length > 0 && (
          <>
            <div className={styles.popSep} />
            <div className={styles.popHead}>{t("Skills")}</div>
            {skills.slice(0, QUICK_SKILLS).map((s) => (
              <div key={s.id} className={styles.popRow} data-chat-skill={s.name}>
                <span className={styles.popLabelMain}>/{s.name}</span>
                {s.origin && <Badge className={styles.rowBadge}>{s.origin === "override" ? t("Default · edited") : t("Default")}</Badge>}
                <Switch label={`/${s.name}`} checked={s.enabled} onChange={(on) => void toggleSkill(s, on)} />
              </div>
            ))}
          </>
        )}
        <div className={styles.popSep} />
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
    <div className={styles.popRow} data-chat-approvals="">
      <span className={styles.popLabel}>{t("Approvals")}</span>
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
  );
}
