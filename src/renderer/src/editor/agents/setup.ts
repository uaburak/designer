/**
 * Agent settings' host (panels/agents/AgentSettings.tsx): what the list and an item's page need — the agents, the
 * servers, the MCP server and its clients, the page open. Two hosts share the same components: the Agents tab's
 * `AgentsService` (an editor's, with chats) and `AgentSetupService` here (Settings › Agents, Home or an editor; no file).
 * No editor or engine import: Home's bundle takes this file.
 */
import type { AgentSettings, AgentSetupApi, McpClientInfo, McpState, ProviderInfo } from "@shared/agents/types";
import { DEFAULT_MANAGER_SETTINGS, type ManagerSettings } from "@shared/studio/types";
import { t } from "@/i18n";

export interface AgentSetupState {
  /** The open page: null for the list, else an item ("provider:antigravity", "add-server", "mcp", "client:cursor") */
  settingsItem: string | null;
  providers: ProviderInfo[];
  providersLoading: boolean;
  settings: AgentSettings;
  mcp: McpState;
  clients: McpClientInfo[];
}

export interface AgentSetupHost {
  readonly api: AgentSetupApi | null;
  get(): AgentSetupState;
  subscribe(fn: () => void): () => void;
  openSetting(item: string | null): void;
  refreshProviders(): Promise<void>;
  refreshSetup(): Promise<void>;
  /** An agent's model (Settings: the app's default for it) */
  modelOf(p: ProviderInfo): string | undefined;
  choose(providerId: string, model?: string): Promise<void>;
  /** The list's Back (the Agents tab: to its chats); absent where the list is the page (Settings › Agents) */
  leaveSettings?(): void;
  /** Agent settings › Manager (docs/studio.md §2.1) */
  managerSettings(): ManagerSettings;
  setManager(patch: Partial<ManagerSettings>): Promise<void>;
}

const MODEL_LABEL: Record<string, string> = { default: "Default", auto: "Auto" };
export const modelLabel = (m: string, p?: Pick<ProviderInfo, "modelLabels">) => p?.modelLabels?.[m] ?? (MODEL_LABEL[m] ? t(MODEL_LABEL[m]) : m);

export const EMPTY_AGENT_SETTINGS: AgentSettings = { providerId: null, models: {}, custom: [] };

/** Settings › Agents' host: the setup half of the agents' API, no chats. */
export class AgentSetupService implements AgentSetupHost {
  private state: AgentSetupState = { settingsItem: null, providers: [], providersLoading: false, settings: EMPTY_AGENT_SETTINGS, mcp: { running: false, url: null, connections: [] }, clients: [] };
  private listeners = new Set<() => void>();

  constructor(readonly api: AgentSetupApi | null) {}

  /** While shown: the MCP server's connections followed, the agents and settings read; returns the stop. */
  start(): () => void {
    if (!this.api) return () => {};
    const off = this.api.onMcpState((mcp) => this.set({ mcp }));
    void this.refreshProviders().catch(() => {});
    return off;
  }

  get = () => this.state;
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  };
  private set(patch: Partial<AgentSetupState>) {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }

  openSetting(item: string | null) {
    this.set({ settingsItem: item });
  }

  async refreshProviders() {
    if (!this.api) return;
    this.set({ providersLoading: true });
    try {
      const [providers, settings] = await Promise.all([this.api.providers(), this.api.settings()]);
      this.set({ providers, settings });
    } finally {
      this.set({ providersLoading: false });
    }
  }

  async refreshSetup() {
    if (!this.api) return;
    const [mcp, clients] = await Promise.all([this.api.mcp(), this.api.clients()]);
    this.set({ mcp, clients });
  }

  modelOf(p: ProviderInfo): string | undefined {
    const m = this.state.settings.models[p.id];
    return m && (p.models.includes(m) || p.kind !== "openai-compatible") ? m : p.models[0];
  }

  async choose(providerId: string, model?: string) {
    if (!this.api) return;
    const settings = await this.api.setSettings({ providerId, ...(model ? { models: { [providerId]: model } } : {}) });
    this.set({ settings });
  }

  managerSettings(): ManagerSettings {
    return this.state.settings.manager ?? DEFAULT_MANAGER_SETTINGS;
  }

  async setManager(patch: Partial<ManagerSettings>) {
    const next = { ...this.managerSettings(), ...patch };
    this.set({ settings: { ...this.state.settings, manager: next } });
    if (!this.api) return;
    this.set({ settings: await this.api.setSettings({ manager: next }) });
  }
}
