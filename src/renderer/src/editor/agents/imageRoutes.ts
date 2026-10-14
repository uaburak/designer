/**
 * The image models as the chat's choice card and Agent settings › Manager list them (docs/studio.md §2.4). Pure, no
 * editor import: Home's Settings › Agents takes this file too.
 */
import type { AiRoute, ImageRouteInfo } from "@shared/ai/types";
import { t } from "@/i18n";

const ROUTE_SEP = "|";

/** A route's models each (a route without models once) as options; unavailable ones greyed with their reason. */
export function imageRouteOptions(routes: readonly ImageRouteInfo[]): { options: { id: string; label: string; detail?: string }[]; disabled: string[] } {
  const options: { id: string; label: string; detail?: string }[] = [];
  const disabled: string[] = [];
  for (const r of routes) {
    const models = r.models.length ? r.models : [{ id: "", label: r.label, detail: undefined }];
    for (const m of models) {
      const id = `${r.providerId}${ROUTE_SEP}${m.id}`;
      options.push({ id, label: r.models.length ? `${r.label} › ${m.label}` : r.label, ...(!r.available ? { detail: r.reason ?? t("Not available") } : m.detail ? { detail: m.detail } : {}) });
      if (!r.available) disabled.push(id);
    }
  }
  return { options, disabled };
}

/** An option's route ("gemini-images|gemini-3-pro-image-preview"). */
export const routeOfOption = (id: string): AiRoute => {
  const [providerId, model] = id.split(ROUTE_SEP);
  return { providerId, ...(model ? { model } : {}) };
};
