/**
 * Refusals in Figma's words (round 17 B, docs/research/rea/components.md §2.19): the engine refuses an edit with a
 * message key (engine/src/editor/Refusals.h) — as a NOTICE event, which the editor shows as a toast (Figma's visual
 * bell), and as a command's `error`, which the plugin API throws. The toast's English is Figma's text where Figma shows
 * one (its visual bells and plugin messages), and `t` gives the Turkish; the plugin API throws Figma's Wasm wording
 * (FIGMA_API) where that differs.
 */
import { showToast } from "@/ds";
import { t } from "@/i18n";
import type { Engine } from "../engine/Engine";

const ENGLISH: Readonly<Record<string, string>> = {
  components_cant_contain_instances_of_themselves: "Components can't contain instances of themselves",
  reparent_component_cycle: "Cannot move node. Reparenting would create a component cycle",
  reparent_component_set_cycle: "Cannot move node. Reparenting would create a component set cycle",
  property_name_empty: "Component property definition name cannot be empty",
  property_name_has_equals_or_comma: "Component property name cannot have '=' or ','",
  variant_value_invalid: "Variant property value cannot be empty or have '=' or ','",
  property_default_empty: "Component property default value cannot be empty",
  property_value_incompatible: "Property value is incompatible with component property type",
  instance_swap_default_not_component: "Default value for instance swap must be a component",
  instance_swap_default_cycle: "Default value for instance swap would create a cycle",
  invalid_preferred_value: "Invalid preferred value for component property type",
  property_reference_cycle: "Attaching this component property would create a cycle",
  variant_default_locked: "Cannot change defaultValue of a variant property",
  slot_default_locked: "Cannot change defaultValue of a slot component property",
  variant_property_needs_set: "Can only add variant property to a component set",
};

/**
 * Where Figma's plugin API throws its Wasm's own wording (engine/src/editor/Refusals.h), unlike the UI's text above:
 * a plugin catching the error reads what Figma would throw.
 */
const FIGMA_API: Readonly<Record<string, string>> = {
  variant_value_invalid: "Invalid component variant prop value",
  instance_swap_default_not_component: "Default value for instance swap must be a symbol",
  instance_swap_default_cycle: "Default backing symbol ID for instance prop will create cycle",
};

/** A refusal's text in English, as the plugin API throws it — Figma's own (an unknown key: itself). */
export const refusalEnglish = (key: string): string => FIGMA_API[key] ?? ENGLISH[key] ?? key;

/** A refusal's text in the UI's language (the toast). */
export const refusalMessage = (key: string): string => t(ENGLISH[key] ?? key);

/** Keys shown in the last moments: a drag that keeps trying the same move shows its toast once. */
const recent = new Map<string, number>();
const QUIET_MS = 1500;

/** Shows a refusal as a toast (Figma's visual bell), once while it repeats. */
export function showRefusal(key: string, now = Date.now()): boolean {
  const last = recent.get(key);
  recent.set(key, now);
  if (last !== undefined && now - last < QUIET_MS) return false;
  showToast({ message: refusalMessage(key) });
  return true;
}

/** Wires the engine's NOTICE events to toasts; returns the detach. */
export function attachRefusals(engine: Pick<Engine, "on">): () => void {
  return engine.on("NOTICE", (e) => void showRefusal(e.key));
}
