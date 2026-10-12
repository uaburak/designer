/**
 * The Settings modal's doors (docs/design-system.md "Settings modal"): the account on the server through main
 * (`account:request`, the session stays in main) or the browser's own sign-in, uploaded fonts and the agents' setup
 * through the preload (absent in a browser), and the open / closed state any view's code can change.
 */
import { useSyncExternalStore } from "react";
import type { AccountMethod } from "@shared/account";
import type { UploadedFontsApi } from "@shared/desktop";
import type { AgentSetupApi } from "@shared/agents/types";
import type { AiSetupApi } from "@shared/ai/api";
import { accountBridge } from "../files/account";

export type SettingsTab = "account" | "community" | "notifications" | "security" | "ai" | "agents";

/** The tabs, Figma's four and ours (AI: providers, credits, local models — docs/ai.md §7; Agents: our AIs' settings), in order. */
export const SETTINGS_TABS: { id: SettingsTab; label: string }[] = [
  { id: "account", label: "Account" },
  { id: "community", label: "Community" },
  { id: "notifications", label: "Notifications" },
  { id: "security", label: "Security" },
  { id: "ai", label: "AI" },
  { id: "agents", label: "Agents" },
];

// ---- Open / closed ----

let state: { open: boolean; tab: SettingsTab } = { open: false, tab: "account" };
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

/** Home's account menu › Settings; the editor's Help and account › Account settings. */
export function openSettings(tab: SettingsTab = "account"): void {
  state = { open: true, tab };
  emit();
}
export function closeSettings(): void {
  state = { ...state, open: false };
  emit();
}
export function setSettingsTab(tab: SettingsTab): void {
  state = { ...state, tab };
  emit();
}
export function useSettingsState(): { open: boolean; tab: SettingsTab } {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
    () => state,
  );
}

// ---- The server, through main ----

export class AccountRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** A `/me…` request; its JSON, or an AccountRequestError with the server's message. */
export async function accountCall<T>(method: AccountMethod, path: string, body?: unknown): Promise<T> {
  const b = accountBridge();
  if (!b) throw new AccountRequestError(401, "Log in first");
  const r = await b.request({ method, path, body });
  if (r.status >= 200 && r.status < 300) return r.body as T;
  const message = (r.body as { error?: string } | null)?.error ?? "Something went wrong. Try again.";
  throw new AccountRequestError(r.status, message.charAt(0).toUpperCase() + message.slice(1));
}

// ---- The preload's parts (desktop only) ----

interface DesignerSettingsBits {
  fonts?: Partial<UploadedFontsApi> & { read?(id: string): Promise<Uint8Array> };
  agents?: AgentSetupApi;
  ai?: AiSetupApi;
  openExternal?(url: string): void;
}
const designer = (): DesignerSettingsBits | undefined => (typeof window === "undefined" ? undefined : (window as unknown as { designer?: DesignerSettingsBits }).designer);

/** Uploaded fonts: the desktop app's (a browser has no font files of its own). */
export function fontsBridge(): (UploadedFontsApi & { read(id: string): Promise<Uint8Array> }) | null {
  const f = designer()?.fonts;
  return f?.uploaded && f.upload && f.removeUploaded && f.read ? (f as UploadedFontsApi & { read(id: string): Promise<Uint8Array> }) : null;
}

/** The agents' setup: the desktop app's, or a test's / the editor-shot's stand-in. */
export function agentSetupBridge(): AgentSetupApi | null {
  return designer()?.agents ?? (window as unknown as { __designerAgents?: AgentSetupApi }).__designerAgents ?? null;
}

/** Main's AI settings and local models (docs/ai.md §7): the desktop app's, or a test's stand-in; null in a browser. */
export function aiSetupBridge(): AiSetupApi | null {
  return designer()?.ai ?? (window as unknown as { __designerAi?: AiSetupApi }).__designerAi ?? null;
}

export function openLink(url: string): void {
  const d = designer();
  if (d?.openExternal) d.openExternal(url);
  else window.open(url, "_blank", "noopener");
}
