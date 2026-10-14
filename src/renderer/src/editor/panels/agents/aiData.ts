/**
 * Skills and connectors as the Agents panel and Agent settings show them (docs/ai.md §2.10–2.11): one copy per page,
 * shared by the composer's "+" menu, the `/` list and the settings pages. Skills are the store's (`ai.skills`, 6g;
 * until it is built the list says so), connectors main's (`agents.connectors`). No editor or engine import: Home's
 * Settings › Agents takes this file too.
 */
import { useEffect, useSyncExternalStore } from "react";
import { getStoreClient } from "@/store";
import type { AiSkill, Connector } from "@shared/ai/types";
import type { AgentSetupApi } from "@shared/agents/types";
import { t } from "@/i18n";

interface Loaded<T> {
  list: T[];
  /** Not read yet */
  loading: boolean;
  /** Why it can't be read (Skills before the store has them, a browser without the desktop app) */
  error: string | null;
}

class Box<T> {
  private value: Loaded<T> = { list: [], loading: true, error: null };
  private listeners = new Set<() => void>();
  private asked = false;
  constructor(private read: () => Promise<T[]>) {}
  get = () => this.value;
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  };
  set(v: Partial<Loaded<T>>) {
    this.value = { ...this.value, ...v };
    this.listeners.forEach((l) => l());
  }
  /** Reads it (again). */
  async refresh(): Promise<void> {
    this.asked = true;
    try {
      this.set({ list: await this.read(), loading: false, error: null });
    } catch (err) {
      this.set({ loading: false, error: err instanceof Error ? err.message : String(err) });
    }
  }
  ensure() {
    if (!this.asked) void this.refresh();
  }
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err)).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");

// ── Skills ──

const skillsRepo = () => getStoreClient().ai;
export const skillsBox = new Box<AiSkill>(async () => {
  try {
    return (await skillsRepo().skills()).sort((a, b) => a.name.localeCompare(b.name));
  } catch (err) {
    throw new Error(/implemented yet|not built/i.test(errorText(err)) ? t("Skills aren’t available in this version yet.") : errorText(err));
  }
});

export function useSkills(): Loaded<AiSkill> {
  useEffect(() => skillsBox.ensure(), []);
  return useSyncExternalStore(skillsBox.subscribe, skillsBox.get);
}

export async function saveSkill(s: { id?: string; name: string; description: string; instructions: string; enabled?: boolean }): Promise<AiSkill> {
  const saved = await skillsRepo().saveSkill(s);
  await skillsBox.refresh();
  return saved;
}

export async function removeSkill(id: string): Promise<void> {
  await skillsRepo().removeSkill(id);
  await skillsBox.refresh();
}

// ── Connectors ──

let connectorsApi: AgentSetupApi | null = null;
export const connectorsBox = new Box<Connector>(async () => {
  if (!connectorsApi?.connectors) throw new Error(t("Connectors work in the desktop app."));
  return connectorsApi.connectors();
});

/** The connectors through this page's agents API (the editor's or Home's). */
export function useConnectors(api: AgentSetupApi | null): Loaded<Connector> {
  useEffect(() => {
    if (api) setConnectorsApi(api);
    connectorsBox.ensure();
  }, [api]);
  return useSyncExternalStore(connectorsBox.subscribe, connectorsBox.get);
}

/** The agents API connectors are read through (the first page's that shows them). */
function setConnectorsApi(api: AgentSetupApi) {
  connectorsApi = api;
}

/** A change through main; the list it answers replaces ours. */
export async function changeConnectors(job: Promise<Connector[]>): Promise<void> {
  try {
    connectorsBox.set({ list: await job, error: null, loading: false });
  } catch (err) {
    throw new Error(errorText(err));
  }
}

/** Test connection: the connector as main found it. */
export async function testConnector(api: AgentSetupApi, id: string): Promise<Connector> {
  const c = await api.testConnector!(id);
  connectorsBox.set({ list: connectorsBox.get().list.map((x) => (x.id === id ? c : x)) });
  return c;
}
