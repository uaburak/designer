/**
 * Agent settings › Manager (docs/studio.md §2.1): the On switch, the manager's agent, model and effort, who does
 * general work, the image model (or "Ask each time"), the agents it may use and how many tasks run at once. Off, the
 * chat talks to the picked agent directly, as before.
 */
import { useEffect, useState } from "react";
import { Checkbox, Select, Switch, type SelectEntry } from "@/ds";
import type { ImageRouteInfo } from "@shared/ai/types";
import type { ProviderInfo } from "@shared/agents/types";
import { IMAGE_TASKS_AT_ONCE, type AgentRoute } from "@shared/studio/types";
import { modelLabel, type AgentSetupHost } from "../../agents/setup";
import { imageRouteOptions, routeOfOption } from "../../agents/imageRoutes";
import { Block, Field } from "./settingsParts";
import styles from "./Agents.module.css";
import { t, useT } from "@/i18n";

/** The routes as last read (asked again after 30 s): every task card reads them. */
let routesRead: { at: number; routes: Promise<ImageRouteInfo[]> } | null = null;
function readRoutes(): Promise<ImageRouteInfo[]> {
  if (routesRead && Date.now() - routesRead.at < 30_000) return routesRead.routes;
  const ai = (window as unknown as { designer?: { ai?: { imageRoutes?: () => Promise<ImageRouteInfo[]> } } }).designer?.ai;
  routesRead = { at: Date.now(), routes: ai?.imageRoutes ? ai.imageRoutes().catch(() => []) : Promise.resolve([]) };
  return routesRead.routes;
}

/** The image routes main offers (docs/studio.md §2.4); none outside the desktop app. */
export function useImageRoutes(): ImageRouteInfo[] {
  const [routes, setRoutes] = useState<ImageRouteInfo[]>([]);
  useEffect(() => {
    let live = true;
    void readRoutes().then((r) => live && setRoutes(r));
    return () => {
      live = false;
    };
  }, []);
  return routes;
}

/** "On" / "Off" for the settings list's row. */
export const managerStatus = (service: AgentSetupHost) => (service.managerSettings().enabled ? t("On") : t("Off"));

const ASK = "ask";

/** An agent and its model (and effort, when it has one) as one route's fields. */
function RouteFields({ label, route, providers, onChange, withEffort }: { label: string; route: AgentRoute; providers: ProviderInfo[]; onChange: (r: AgentRoute) => void; withEffort?: boolean }) {
  useT();
  const p = providers.find((x) => x.id === route.providerId);
  const agents: SelectEntry[] = providers.map((x) => ({ value: x.id, label: x.label, disabled: !x.available }));
  if (!p) agents.push({ value: route.providerId, label: route.providerId, disabled: true });
  const models = p?.models ?? [];
  const model = route.model ?? models[0] ?? "";
  return (
    <>
      <Field label={label}>
        <Select label={label} className={styles.fieldSelect} value={route.providerId} options={agents} onChange={(id) => onChange({ providerId: id })} data-manager-agent={label} />
      </Field>
      {(models.length > 0 || route.model) && (
        <Field label={t("Model")}>
          <Select label={t("{label} model", { label })} className={styles.fieldSelect} value={model} options={[...new Set([...models, ...(route.model ? [route.model] : [])])].map((m) => ({ value: m, label: p ? modelLabel(m, p) : m }))} onChange={(m) => onChange({ ...route, model: m })} />
        </Field>
      )}
      {withEffort && !!p?.efforts?.length && (
        <Field label={t("Effort")}>
          <Select label={t("{label} effort", { label })} className={styles.fieldSelect} value={route.effort && p.efforts.includes(route.effort) ? route.effort : p.efforts[0]} options={p.efforts.map((e) => ({ value: e, label: t(e[0].toUpperCase() + e.slice(1)) }))} onChange={(e) => onChange({ ...route, effort: e })} />
        </Field>
      )}
    </>
  );
}

export function ManagerPage({ service }: { service: AgentSetupHost }) {
  useT();
  const m = service.managerSettings();
  const providers = service.get().providers;
  const routes = useImageRoutes();
  const set = (patch: Parameters<AgentSetupHost["setManager"]>[0]) => void service.setManager(patch);
  const { options, disabled } = imageRouteOptions(routes);
  const imageValue = m.image ? `${m.image.providerId}|${m.image.model ?? ""}` : ASK;
  const images: SelectEntry[] = [{ value: ASK, label: t("Ask each time") }, "-", ...options.map((o) => ({ value: o.id, label: o.label, disabled: disabled.includes(o.id), ...(o.detail ? { hint: o.detail } : {}) }))];
  if (m.image && !options.some((o) => o.id === imageValue)) images.push({ value: imageValue, label: m.image.model ?? m.image.providerId });
  const connected = providers.filter((p) => p.available);
  return (
    <div className={styles.pageBody} data-manager-settings="">
      <Block>
        <Field label={t("Manager")}>
          <Switch label={t("Manager")} checked={m.enabled} onChange={(enabled) => set({ enabled })} data-manager-on="" />
        </Field>
        <p className={styles.pageText}>{t("The manager reads your message, finds the brand and products in the library, hands the work to other agents at the same time and reviews what lands on the canvas. Off, the chat talks to the agent you pick.")}</p>
      </Block>
      <Block title={t("Manager")}>
        <RouteFields label={t("Agent")} route={m.manager} providers={providers} withEffort onChange={(manager) => set({ manager })} />
      </Block>
      <Block title={t("General work")}>
        <RouteFields label={t("General agent")} route={m.general} providers={providers} onChange={(general) => set({ general })} />
      </Block>
      <Block title={t("Images")}>
        <Field label={t("Image model")}>
          <Select label={t("Image model")} className={styles.fieldSelect} value={imageValue} options={images} onChange={(v) => set({ image: v === ASK ? null : routeOfOption(v) })} data-manager-image="" />
        </Field>
      </Block>
      <Block title={t("Agents it may use")}>
        {connected.map((p) => (
          <Checkbox
            key={p.id}
            label={p.label}
            checked={!m.allowed.length || m.allowed.includes(p.id)}
            onChange={(on) => {
              const now = m.allowed.length ? m.allowed : connected.map((x) => x.id);
              const next = on ? [...new Set([...now, p.id])] : now.filter((id) => id !== p.id);
              // Every connected one checked is the same as none: all of them.
              set({ allowed: connected.every((x) => next.includes(x.id)) ? [] : next });
            }}
            data-manager-allowed={p.id}
          />
        ))}
        {!connected.length && <p className={styles.pageText}>{t("No agent is connected.")}</p>}
      </Block>
      <Block title={t("At once")}>
        <Field label={t("Tasks at once")}>
          <Select label={t("Tasks at once")} className={styles.fieldSelect} value={String(m.parallel)} options={[1, 2, 3, 4].map((n) => ({ value: String(n), label: String(n) }))} onChange={(v) => set({ parallel: Number(v) })} data-manager-parallel="" />
        </Field>
        <p className={styles.pageText}>{t("Agent tasks running together (each is its own process). Pictures run up to {n} at once.", { n: IMAGE_TASKS_AT_ONCE })}</p>
      </Block>
    </div>
  );
}
