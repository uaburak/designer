/**
 * The agents' Social tools (docs/social.md §7.2: get_board, list_formats, list_templates, new_post, apply_template,
 * fill_slots, set_post, resize_post, set_campaign, check_posts, save_as_template, export_posts), dispatched from
 * `runTool` in mcpTools.ts as motionTools.ts is. Thin over editor/social/actions.ts — the functions the chrome's
 * controls call — each write one `env.write` transaction. A stub until round 18c: no tool is answered here yet.
 */
import type { ToolResult } from "@shared/agents/tools";
import type { ToolEnv } from "./mcpTools";
import type { Spec } from "./nodeSpec";

/** A Social tool's answer, or null when `name` isn't one of them (round 18c fills the table). */
export function runSocialTool(env: ToolEnv, name: string, args: Spec): ToolResult | null {
  void env;
  void name;
  void args;
  return null;
}
