/**
 * Agent settings (the Agents tab's gear): a list, grouped — the agents on this computer, API keys and servers, and the
 * apps that connect to the MCP server — one row each with its state and a chevron; a row opens that item's own page
 * (Back and its title, like a chat's bar) with everything about it: its state and account, its model, Install /
 * Sign in / Sign out / Test connection, a line on what it is, its page.
 */
import { useEffect, useState, type ReactNode } from "react";
import { Button, IconButton, Select, Spinner, TextInput, cx, showToast, type IconName } from "@/ds";
import type { AuthState, McpClientInfo, ProviderInfo } from "@shared/agents/types";
import { modelLabel, type AgentSetupHost } from "../../agents/setup";
import styles from "./Agents.module.css";
import { Block, Field, Group, Row, errorText } from "./settingsParts";
import { ConnectorsGroup, SkillsGroup, aiSettingsPage } from "./aiSettings";
import { ManagerPage, managerStatus } from "./ManagerSettings";
import { t, tp, useT } from "@/i18n";

const openExternal = (url: string) => {
  const d = (window as unknown as { designer?: { openExternal?: (u: string) => void } }).designer;
  if (d?.openExternal) d.openExternal(url);
  else window.open(url, "_blank", "noopener");
};

const isServer = (p: ProviderInfo) => p.kind === "openai-compatible";
const isCustom = (p: ProviderInfo) => p.id.startsWith("custom:");

/** An agent's state, in the list's and its page's words. */
export function stateText(p: ProviderInfo, auth: AuthState | undefined = p.auth): string {
  if (isServer(p)) return p.available ? "Connected" : p.models.length || p.problem === "No models loaded" ? "No models loaded" : "Not running";
  switch (auth?.state) {
    case "connected":
      return "Connected";
    case "signing-in":
      return "Signing in…";
    case "signed-out":
      return "Sign in needed";
    default:
      return "Not installed";
  }
}

/** What each agent is, in a sentence, and its official page. */
const ABOUT: Record<string, { text: string; page?: string }> = {
  "claude-code": { text: "Anthropic’s coding agent, with your Claude account. It runs on this computer and edits this file with its design tools.", page: "https://docs.claude.com/en/docs/claude-code/overview" },
  antigravity: { text: "Google’s agent, with your Google AI plan (Pro or Ultra). It runs on this computer, edits this file with its design tools and makes images with Gemini.", page: "https://antigravity.google/docs/cli" },
  codex: { text: "OpenAI’s coding agent, with your ChatGPT account or an OpenAI API key.", page: "https://developers.openai.com/codex/cli" },
  "cursor-agent": { text: "Cursor’s agent for Terminal, with your Cursor account.", page: "https://cursor.com/cli" },
  ollama: { text: "Runs open models on this computer, free and offline. Start Ollama and download a model, then come back here.", page: "https://ollama.com" },
  lmstudio: { text: "Runs open models on this computer, free and offline. Start LM Studio’s server and load a model, then come back here.", page: "https://lmstudio.ai" },
};

const KIND_ICON = (p: ProviderInfo): IconName => (isCustom(p) ? "24.globe" : isServer(p) ? "24.agents" : "24.dev-brackets");

/**
 * The list or an item's page, for either host (agents/setup.ts): the Agents tab's gear, Settings › Agents (`embedded`:
 * the modal's own look — no bar on the list, the modal's spacing).
 */
export function AgentSettings({ service, embedded }: { service: AgentSetupHost; embedded?: boolean }) {
  useT();
  const state = service.get();
  useEffect(() => {
    void service.refreshSetup();
  }, [service]);
  const item = state.settingsItem;
  return (
    <div className={cx(styles.settings, embedded && styles.embedded)} data-agent-settings="" data-settings-page={item ?? "list"}>
      {item ? <SettingsPage service={service} item={item} /> : <SettingsList service={service} />}
    </div>
  );
}

function Bar({ title, onBack, action }: { title: string; onBack?: () => void; action?: ReactNode }) {
  useT();
  return (
    <div className={styles.chatBar}>
      {onBack && <IconButton icon="24.arrow.left" label={t("Back")} tone="secondary" onClick={onBack} />}
      <span className={styles.chatBarTitle}>{title}</span>
      {action}
    </div>
  );
}

// ---- The list -------------------------------------------------------------------------------------------------------

function SettingsList({ service }: { service: AgentSetupHost }) {
  useT();
  const state = service.get();
  const local = state.providers.filter((p) => !isCustom(p));
  const custom = state.providers.filter(isCustom);
  const n = state.mcp.connections.length;
  return (
    <>
      <Bar
        title={t("Agent settings")}
        onBack={service.leaveSettings && (() => service.leaveSettings!())}
        action={state.providersLoading ? <span className={styles.barSpinner}><Spinner size={16} /></span> : <IconButton icon="24.reset.instance.small" label={t("Look again")} tone="secondary" onClick={() => void service.refreshProviders()} />}
      />
      <div className={styles.scroll}>
        <Group title={t("Studio")}>
          <Row icon="24.agents" label={t("Manager")} status={managerStatus(service)} on={service.managerSettings().enabled} onClick={() => service.openSetting("manager")} data-settings-row="manager" />
        </Group>
        <Group title={t("On this computer")}>
          {state.providersLoading && !local.length && <div className={styles.rowNote}><Spinner size={16} /> {t("Looking for agents…")}</div>}
          {local.map((p) => {
            const status = stateText(p);
            const on = status === "Connected";
            return (
              <Row
                key={p.id}
                icon={KIND_ICON(p)}
                label={p.label}
                status={t(status)}
                on={on}
                dim={status === "Not installed" || status === "Not running"}
                onClick={() => service.openSetting(`provider:${p.id}`)}
                statusProps={{ "data-provider-state": "" }}
                data-provider={p.id}
                data-available={p.available ? "" : undefined}
                data-state={isServer(p) ? (p.available ? "connected" : "not-running") : p.auth?.state}
              />
            );
          })}
        </Group>
        <Group title={t("Servers")}>
          {custom.map((p) => (
            <Row key={p.id} icon={KIND_ICON(p)} label={p.label} status={t(stateText(p))} on={p.available} dim={!p.available} onClick={() => service.openSetting(`provider:${p.id}`)} statusProps={{ "data-provider-state": "" }} data-provider={p.id} data-available={p.available ? "" : undefined} />
          ))}
          <Row icon="24.plus" label={t("Add a server")} onClick={() => service.openSetting("add-server")} data-settings-row="add-server" />
        </Group>
        <SkillsGroup service={service} />
        <ConnectorsGroup service={service} />
        <Group title={t("Connect other apps")}>
          <Row icon="24.link" label={t("MCP server")} status={!state.mcp.url ? t("Not running") : tp(n, "{n} connection", "{n} connections")} on={n > 0} onClick={() => service.openSetting("mcp")} data-settings-row="mcp" />
          {state.clients.map((c) => (
            <Row key={c.id} icon="24.plugin" label={c.label} status={c.connected ? t("Connected") : c.installed ? t("Not connected") : t("Not installed")} on={c.connected} dim={!c.installed} onClick={() => service.openSetting(`client:${c.id}`)} data-client={c.id} data-connected={c.connected ? "" : undefined} />
          ))}
        </Group>
        <p className={styles.footnote}>{t("Connected agents show up in the chat’s agent menu.")}</p>
      </div>
    </>
  );
}

// ---- An item's page -------------------------------------------------------------------------------------------------

function SettingsPage({ service, item }: { service: AgentSetupHost; item: string }) {
  useT();
  const state = service.get();
  const back = () => {
    service.openSetting(null);
    void service.refreshProviders();
  };
  const [kind, id] = item.includes(":") ? [item.slice(0, item.indexOf(":")), item.slice(item.indexOf(":") + 1)] : [item, ""];
  let title = "";
  let body: ReactNode = null;
  if (kind === "provider") {
    const p = state.providers.find((x) => x.id === id);
    title = p?.label ?? t("Agent");
    body = p ? <ProviderPage p={p} service={service} /> : <p className={styles.pageText}>{t("This agent isn’t listed any more.")}</p>;
  } else if (kind === "client") {
    const c = state.clients.find((x) => x.id === id);
    title = c?.label ?? t("App");
    body = c ? <ClientPage c={c} service={service} /> : null;
  } else if (kind === "add-server") {
    title = t("Add a server");
    body = <AddServer service={service} />;
  } else if (kind === "manager") {
    title = t("Manager");
    body = <ManagerPage service={service} />;
  } else if (kind === "mcp") {
    title = t("MCP server");
    body = <McpPage service={service} />;
  } else {
    // Skills and connectors (docs/ai.md §2.10–2.11): aiSettings.tsx
    const page = aiSettingsPage(kind, id, service);
    if (page) ({ title, body } = page);
  }
  return (
    <>
      <Bar title={title} onBack={back} />
      <div className={cx(styles.scroll, styles.page)}>{body}</div>
    </>
  );
}

function About({ text, page, label }: { text?: string; page?: string; label: string }) {
  useT();
  if (!text && !page) return null;
  return (
    <Block>
      {text && <p className={styles.pageText}>{t(text)}</p>}
      {page && (
        <button type="button" className={styles.link} onClick={() => openExternal(page)}>
          {t("Learn more about {name}", { name: label })}
        </button>
      )}
    </Block>
  );
}

/** One agent: its state and account, Install / Sign in / Sign out, its model, Test connection; Gemini's images and key. */
function ProviderPage({ p, service }: { p: ProviderInfo; service: AgentSetupHost }) {
  useT();
  const [test, setTest] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // What Sign in / Sign out / the polling said, until the providers' next report (p.auth) replaces it.
  const [local, setLocal] = useState<{ of: AuthState | undefined; auth: AuthState } | null>(null);
  const auth = local && local.of === p.auth ? local.auth : p.auth;
  const setAuth = (a: AuthState) => setLocal({ of: p.auth, auth: a });
  const api = service.api;
  // While a sign-in runs (the browser, or Terminal): ask again every 2 s, 10 minutes at most.
  useEffect(() => {
    if (auth?.state !== "signing-in" || !api) return;
    let n = 0;
    const timer = setInterval(() => {
      if (++n > 300) return clearInterval(timer);
      void api.auth(p.id).then((a) => {
        if (a.state === "signing-in") return;
        setAuth(a);
        void service.refreshProviders();
      });
    }, 2000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- setAuth is this render's; the state is what matters
  }, [auth?.state, p.id, api, service]);
  const cli = !isServer(p);
  const custom = isCustom(p);
  const state = stateText(p, auth);
  const on = cli ? auth?.state === "connected" : p.available;
  const run = async (what: string, fn: () => Promise<unknown>) => {
    setBusy(what);
    try {
      await fn();
    } catch (err) {
      showToast({ message: errorText(err), kind: "error" });
    } finally {
      setBusy(null);
    }
  };
  const install = () =>
    run("install", async () => {
      const r = await api!.install(p.id);
      if (!r.ok) showToast({ message: r.error ?? t("Couldn't install {name}", { name: p.label }), kind: "error" });
      else {
        showToast({ message: r.opened === "installed" ? t("{name} installed", { name: p.label }) : t("Opened {name}’s download page", { name: p.label }) });
        if (r.opened === "installed") void service.refreshProviders();
      }
    });
  const account = auth?.state === "connected" ? [auth.account, auth.plan].filter(Boolean).join(" · ") : "";
  const where = cli ? (auth?.state === "not-installed" ? undefined : p.detail) : p.detail;
  const about = ABOUT[p.id];
  const notInstalled = cli && auth?.state === "not-installed";
  return (
    <div className={styles.pageBody} data-provider={p.id} data-available={p.available || undefined} data-state={cli ? auth?.state : p.available ? "connected" : "not-running"}>
      <Block>
        <Field label={t("Status")}>
          <span className={cx(styles.dot, on && styles.dotOn)} />
          <span data-provider-state="">{t(state)}</span>
        </Field>
        {account && <Field label={t("Account")}>{account}</Field>}
        {where && <Field label={cli ? t("Location") : t("Address")}><span className={styles.mono}>{where}</span></Field>}
        {auth?.state === "signing-in" && (
          <div className={styles.pageText}>
            <Spinner size={16} /> {t("Waiting for the sign-in to finish…")}{" "}
            {auth.url && (
              <button type="button" className={styles.link} onClick={() => openExternal(auth.url!)}>
                {t("Open the sign-in page")}
              </button>
            )}
          </div>
        )}
        {notInstalled && p.install?.command && <code className={styles.command}>{p.install.command}</code>}
        {!cli && !p.available && !custom && <p className={styles.pageText}>{t("Start {name} and load a model, then Look again.", { name: p.label })}</p>}
        {p.available && p.models.length > 1 && (
          <Field label={t("Model")}>
            <Select label={t("Model")} className={styles.fieldSelect} value={service.modelOf(p) ?? ""} options={p.models.map((m) => ({ value: m, label: modelLabel(m, p) }))} onChange={(m) => void service.choose(p.id, m)} />
          </Field>
        )}
        <div className={styles.actions}>
          {notInstalled && (
            <Button variant="primary" loading={busy === "install"} onClick={() => void install()} data-install="">
              {t("Install")}
            </Button>
          )}
          {cli && auth?.state === "signed-out" && (
            <Button variant="primary" loading={busy === "sign-in"} onClick={() => void run("sign-in", async () => setAuth(await api!.signIn(p.id)))} data-sign-in="">
              {t("Sign in")}
            </Button>
          )}
          {!cli && !p.available && !custom && p.install && (
            <Button variant="secondary" loading={busy === "install"} onClick={() => void install()} data-install="">
              {t("Install")}
            </Button>
          )}
          {!cli && !p.available && (
            <Button variant="secondary" loading={busy === "look"} onClick={() => void run("look", () => service.refreshProviders())}>
              {t("Look again")}
            </Button>
          )}
          {(p.available || (cli && auth?.state === "signed-out")) && (
            <Button
              variant="secondary"
              loading={busy === "test"}
              onClick={() =>
                void run("test", async () => {
                  const r = await api!.test(p.id).catch((err: unknown) => ({ ok: false, models: [] as string[], error: String(err), version: undefined }));
                  setTest({ ok: r.ok, text: r.ok ? (cli ? `${t("Ready")}${r.version ? ` · ${r.version}` : ""}` : tp(r.models.length, "Connected · {n} model", "Connected · {n} models")) : (r.error ?? t("Failed")) });
                  void service.refreshProviders();
                })
              }
              data-test-connection=""
            >
              {t("Test connection")}
            </Button>
          )}
          {cli && auth?.state === "connected" && (
            <Button variant="secondary" loading={busy === "sign-out"} onClick={() => void run("sign-out", async () => { setAuth(await api!.signOut(p.id)); await service.refreshProviders(); })} data-sign-out="">
              {t("Sign out")}
            </Button>
          )}
          {custom && (
            <Button variant="secondary" onClick={() => void api?.removeServer(p.id).then(() => { service.openSetting(null); return service.refreshProviders(); })} data-remove-server="">
              {t("Remove server")}
            </Button>
          )}
        </div>
        {test && <div className={cx(styles.testResult, !test.ok && styles.testFail)} role="status">{test.text}</div>}
      </Block>
      <About text={about?.text ?? (custom ? "An OpenAI-compatible server you added. Its models show up in the chat’s agent menu while it answers." : p.note)} page={about?.page ?? p.install?.page} label={p.label} />
    </div>
  );
}

function AddServer({ service }: { service: AgentSetupHost }) {
  useT();
  const [label, setLabel] = useState("");
  const [url, setUrl] = useState("");
  const [key, setKey] = useState("");
  return (
    <div className={styles.pageBody}>
      <Block>
        <TextInput label={t("Name")} placeholder={t("Name")} value={label} onChange={setLabel} />
        <TextInput label={t("Base URL")} placeholder="http://localhost:8080/v1" value={url} onChange={setUrl} />
        <TextInput label={t("API key (optional)")} placeholder={t("API key (optional)")} secret value={key} onChange={setKey} />
        <div className={styles.actions}>
          <Button
            variant="primary"
            disabled={!/^https?:\/\//i.test(url.trim())}
            onClick={async () => {
              try {
                await service.api!.addServer({ label: label.trim(), baseUrl: url.trim(), apiKey: key || undefined });
                await service.refreshProviders();
                service.openSetting(null);
              } catch (err) {
                showToast({ message: errorText(err), kind: "error" });
              }
            }}
            data-add-server=""
          >
            {t("Add server")}
          </Button>
        </div>
      </Block>
      <About text="Any server with an OpenAI-compatible chat API (/v1/chat/completions) — vLLM, llama.cpp, a hosted service. The key is kept in your keychain." label="servers" />
    </div>
  );
}

/** The MCP server this app runs: its address and who is connected. */
function McpPage({ service }: { service: AgentSetupHost }) {
  useT();
  const { mcp } = service.get();
  const n = mcp.connections.length;
  return (
    <div className={styles.pageBody}>
      <Block>
        <Field label={t("Address")} data-mcp-url="">
          <span className={styles.mono}>{mcp.url ?? t("Not running")}</span>
          {mcp.url && <IconButton icon="24.copy.small" label={t("Copy URL")} tone="secondary" onClick={() => void navigator.clipboard.writeText(mcp.url!).then(() => showToast({ message: t("Copied to clipboard") }))} />}
        </Field>
        <Field label={t("Connections")}>{n === 0 ? t("None") : [...new Set(mcp.connections.map((c) => c.client))].join(", ")}</Field>
      </Block>
      <About text="Apps on this computer that have its token can read and edit the file in front. Connect them from the list." label="MCP" />
    </div>
  );
}

/** An MCP client: Connect (writes its config file) / Disconnect, and its config to copy. */
function ClientPage({ c, service }: { c: McpClientInfo; service: AgentSetupHost }) {
  useT();
  const copy = async () => {
    const cfg = await service.api!.clientConfig(c.id);
    await navigator.clipboard.writeText(cfg.text);
    showToast({ message: t("Copied — paste it into {path}", { path: cfg.path.replace(/^\/Users\/[^/]+/, "~") }) });
  };
  return (
    <div className={styles.pageBody} data-client={c.id} data-connected={c.connected || undefined}>
      <Block>
        <Field label={t("Status")}>
          <span className={cx(styles.dot, c.connected && styles.dotOn)} />
          {c.connected ? t("Connected") : c.installed ? t("Not connected") : t("Not installed")}
        </Field>
        <Field label={t("Config")}><span className={styles.mono}>{c.configPath}</span></Field>
        <div className={styles.actions}>
          {c.connected ? (
            <Button variant="secondary" onClick={async () => { const r = await service.api!.disconnect(c.id); if (!r.ok && r.error) showToast({ message: r.error, kind: "error" }); await service.refreshSetup(); }}>
              {t("Disconnect")}
            </Button>
          ) : (
            <Button
              variant="primary"
              disabled={!c.installed}
              onClick={async () => {
                const r = await service.api!.connect(c.id);
                if (r.ok) showToast({ message: r.backup ? t("Connected {name} (the old config was kept as a backup). Restart it if it was open.", { name: c.label }) : t("Connected {name}. Restart it if it was open.", { name: c.label }) });
                else if (r.error) showToast({ message: r.error, kind: "error" });
                await service.refreshSetup();
              }}
            >
              {t("Connect to {name}", { name: c.label })}
            </Button>
          )}
          <Button variant="secondary" onClick={() => void copy()}>
            {t("Copy config")}
          </Button>
        </div>
      </Block>
      <About text={t("Connect adds this app’s MCP server to {name}’s config, so {name} can read and edit the file in front. Restart {name} after connecting.", { name: c.label })} label="MCP" />
    </div>
  );
}
