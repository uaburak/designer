/**
 * Who answers the chat, as the composer's footer and the panel's "This chat" popover pick it: the manager (when it can
 * run) or a model under its agent's heading — each with its agent's mark in the list — and, for an agent with one, its
 * effort. Picking a model turns the manager off (Agent settings › Manager), picking the manager turns it on.
 */
import { Select, cx, type SelectEntry, type SelectOption } from "@/ds";
import type { ProviderInfo } from "@shared/agents/types";
import { MODEL_SEP, effortMenu, modelMenu, pickModel } from "../../agents/models";
import { managerName } from "../../agents/managerName";
import type { AgentsService } from "../../agents/service";
import { AgentMark } from "./AgentMark";
import styles from "./Agents.module.css";
import { t, useT } from "@/i18n";

const MANAGER = "manager";

/** The model menu's entries: the manager first (when an agent can run it), then each agent's models with its mark. */
export function modelEntries(service: AgentsService): SelectEntry[] {
  const state = service.get();
  const models = modelMenu(state.providers, state.resolved).map((e): SelectEntry => (typeof e === "object" && "value" in e ? ({ ...e, lead: <AgentMark providerId={e.value.split(MODEL_SEP)[0]} /> } satisfies SelectOption) : e));
  const canManage = state.providers.some((p) => p.available && p.id === service.managerSettings().manager.providerId);
  return canManage ? [{ value: MANAGER, label: managerName(service.managerSettings()), lead: <AgentMark manager /> }, "-", ...models] : models;
}

export function ModelPicker({ service, provider, variant = "ghost", width = "hug", withEffort = true, className }: { service: AgentsService; provider: ProviderInfo | null; variant?: "ghost" | "filled"; width?: number | "hug"; withEffort?: boolean; className?: string }) {
  useT();
  const state = service.get();
  const managing = !!service.managerProvider();
  const current = provider ? service.current(provider) : null;
  const option = current?.option;
  const effort = current?.effort;
  const efforts = effortMenu(option);
  const value = managing ? MANAGER : provider ? `${provider.id}${MODEL_SEP}${option?.key ?? ""}` : "";
  return (
    <>
      <Select
        label={t("Model")}
        variant={variant}
        width={width}
        value={value}
        options={modelEntries(service)}
        onChange={(v) => {
          if (v === MANAGER) return void service.setManager({ enabled: true });
          const [id, key] = v.split(MODEL_SEP);
          const p = state.providers.find((x) => x.id === id);
          if (!p) return;
          if (managing) void service.setManager({ enabled: false });
          const next = pickModel(p, key, effort?.id, state.resolved);
          void service.choose(id, next.model || undefined, p.efforts?.length ? next.effort : undefined);
        }}
        className={cx(variant === "ghost" && styles.menu, variant === "ghost" && styles.modelMenu, className)}
        data-model-menu=""
      />
      {withEffort && !managing && provider && efforts.length > 0 && option && <EffortPicker service={service} provider={provider} variant={variant} width={width} className={className} />}
    </>
  );
}

export function EffortPicker({ service, provider, variant = "ghost", width = "hug", className }: { service: AgentsService; provider: ProviderInfo; variant?: "ghost" | "filled"; width?: number | "hug"; className?: string }) {
  useT();
  const { option, effort } = service.current(provider);
  const efforts = effortMenu(option);
  if (!option || !efforts.length) return null;
  return (
    <Select
      label={t("Effort")}
      variant={variant}
      width={width}
      value={effort?.id ?? ""}
      options={efforts}
      onChange={(id) => {
        const e = option.efforts.find((x) => x.id === id);
        if (e) void service.choose(provider.id, e.model, option.inSlug ? undefined : id);
      }}
      className={cx(variant === "ghost" && styles.menu, className)}
      data-effort-menu=""
    />
  );
}
