/**
 * Agent settings (the Agents tab's gear): a list, grouped — the agents on this computer, API keys and servers, and the
 * apps that connect to the MCP server — one row each with its state and a chevron; a row opens that item's own page
 * (Back and its title, like a chat's bar) with everything about it: its state and account, its model, Install /
 * Sign in / Sign out / Test connection, the Gemini API key and image generation, a line on what it is, its page.
 */
import { useEffect, useState, type ReactNode } from "react";
import { Button, Icon, IconButton, Select, Spinner, TextInput, cx, showToast, type IconName } from "@/ds";
import type { AuthState, ImageGenState, McpClientInfo, ProviderInfo } from "@shared/agents/types";
import { modelLabel, type AgentsService } from "../../agents/service";
import styles from "./Agents.module.css";

const errorText = (err: unknown) => (err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(err));

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
  gemini: { text: "Google’s Gemini models, as in Antigravity — run by Gemini CLI with your Gemini API key. With Nano Banana it also makes images.", page: "https://github.com/google-gemini/gemini-cli" },
  codex: { text: "OpenAI’s coding agent, with your ChatGPT account or an OpenAI API key.", page: "https://developers.openai.com/codex/cli" },
  "cursor-agent": { text: "Cursor’s agent for Terminal, with your Cursor account.", page: "https://cursor.com/cli" },
  ollama: { text: "Runs open models on this computer, free and offline. Start Ollama and download a model, then come back here.", page: "https://ollama.com" },
  lmstudio: { text: "Runs open models on this computer, free and offline. Start LM Studio’s server and load a model, then come back here.", page: "https://lmstudio.ai" },
};

const KIND_ICON = (p: ProviderInfo): IconName => (isCustom(p) ? "24.globe" : isServer(p) ? "24.agents" : "24.dev-brackets");

export function AgentSettings({ service }: { service: AgentsService }) {
  const state = service.get();
  useEffect(() => {
    void service.refreshSetup();
  }, [service]);
  const item = state.settingsItem;
  return (
    <div className={styles.settings} data-agent-settings="" data-settings-page={item ?? "list"}>
      {item ? <SettingsPage service={service} item={item} /> : <SettingsList service={service} />}
    </div>
  );
}

function Bar({ title, onBack, action }: { title: string; onBack: () => void; action?: ReactNode }) {
  return (
    <div className={styles.chatBar}>
      <IconButton icon="24.arrow.left" label="Back" tone="secondary" onClick={onBack} />
      <span className={styles.chatBarTitle}>{title}</span>
      {action}
    </div>
  );
}

// ---- The list -------------------------------------------------------------------------------------------------------

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className={styles.group} aria-label={title}>
      <h3 className={styles.groupTitle}>{title}</h3>
      <div role="list">{children}</div>
    </section>
  );
}

type RowProps = { icon: IconName; label: string; status?: string; on?: boolean; dim?: boolean; onClick: () => void; statusProps?: Record<string, string> } & Record<`data-${string}`, string | undefined>;

function Row({ icon, label, status, on, dim, onClick, statusProps, ...data }: RowProps) {
  return (
    <div role="listitem" className={styles.rowItem}>
      <button type="button" className={cx(styles.row, dim && styles.rowDim)} onClick={onClick} {...data}>
        <span className={styles.rowIcon}><Icon name={icon} /></span>
        <span className={styles.rowLabel}>{label}</span>
        {status && (
          <span className={styles.rowStatus}>
            {on && <span className={cx(styles.dot, styles.dotOn)} />}
            <span {...statusProps}>{status}</span>
          </span>
        )}
        <span className={styles.rowChevron}><Icon name="16.chevron.right" /></span>
      </button>
    </div>
  );
}

function SettingsList({ service }: { service: AgentsService }) {
  const state = service.get();
  const local = state.providers.filter((p) => !isCustom(p));
  const custom = state.providers.filter(isCustom);
  const keyAdded = !!state.providers.find((p) => p.id === "gemini")?.imageGen?.keyAdded;
  const n = state.mcp.connections.length;
  return (
    <>
      <Bar
        title="Agent settings"
        onBack={() => service.setView(state.chats.length ? "list" : "chat")}
        action={state.providersLoading ? <span className={styles.barSpinner}><Spinner size={16} /></span> : <IconButton icon="24.reset.instance.small" label="Look again" tone="secondary" onClick={() => void service.refreshProviders()} />}
      />
      <div className={styles.scroll}>
        <Group title="On this computer">
          {state.providersLoading && !local.length && <div className={styles.rowNote}><Spinner size={16} /> Looking for agents…</div>}
          {local.map((p) => {
            const status = stateText(p);
            const on = status === "Connected";
            return (
              <Row
                key={p.id}
                icon={KIND_ICON(p)}
                label={p.label}
                status={status}
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
        <Group title="API keys">
          <Row icon="24.lock.small" label="Gemini API key" status={keyAdded ? "Key added" : "Not added"} on={keyAdded} onClick={() => service.openSetting("gemini-key")} data-settings-row="gemini-key" />
          {custom.map((p) => (
            <Row key={p.id} icon={KIND_ICON(p)} label={p.label} status={stateText(p)} on={p.available} dim={!p.available} onClick={() => service.openSetting(`provider:${p.id}`)} statusProps={{ "data-provider-state": "" }} data-provider={p.id} data-available={p.available ? "" : undefined} />
          ))}
          <Row icon="24.plus" label="Add a server" onClick={() => service.openSetting("add-server")} data-settings-row="add-server" />
        </Group>
        <Group title="Connect other apps">
          <Row icon="24.link" label="MCP server" status={!state.mcp.url ? "Not running" : n === 1 ? "1 connection" : `${n} connections`} on={n > 0} onClick={() => service.openSetting("mcp")} data-settings-row="mcp" />
          {state.clients.map((c) => (
            <Row key={c.id} icon="24.plugin" label={c.label} status={c.connected ? "Connected" : c.installed ? "Not connected" : "Not installed"} on={c.connected} dim={!c.installed} onClick={() => service.openSetting(`client:${c.id}`)} data-client={c.id} data-connected={c.connected ? "" : undefined} />
          ))}
        </Group>
        <p className={styles.footnote}>Connected agents show up in the chat’s agent menu.</p>
      </div>
    </>
  );
}

// ---- An item's page -------------------------------------------------------------------------------------------------

function SettingsPage({ service, item }: { service: AgentsService; item: string }) {
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
    title = p?.label ?? "Agent";
    body = p ? <ProviderPage p={p} service={service} /> : <p className={styles.pageText}>This agent isn’t listed any more.</p>;
  } else if (kind === "client") {
    const c = state.clients.find((x) => x.id === id);
    title = c?.label ?? "App";
    body = c ? <ClientPage c={c} service={service} /> : null;
  } else if (kind === "gemini-key") {
    title = "Gemini API key";
    body = <GeminiKeyPage service={service} />;
  } else if (kind === "add-server") {
    title = "Add a server";
    body = <AddServer service={service} />;
  } else if (kind === "mcp") {
    title = "MCP server";
    body = <McpPage service={service} />;
  }
  return (
    <>
      <Bar title={title} onBack={back} />
      <div className={cx(styles.scroll, styles.page)}>{body}</div>
    </>
  );
}

/** A labelled line of an item's page: "Status  ● Connected". */
function Field({ label, children, ...data }: { label: string; children: ReactNode } & Record<`data-${string}`, string | undefined>) {
  return (
    <div className={styles.field} {...data}>
      <span className={styles.fieldLabel}>{label}</span>
      <span className={styles.fieldValue}>{children}</span>
    </div>
  );
}

function Block({ title, children, ...data }: { title?: string; children: ReactNode } & Record<`data-${string}`, string | undefined>) {
  return (
    <section className={styles.block} {...data}>
      {title && <h3 className={styles.blockTitle}>{title}</h3>}
      {children}
    </section>
  );
}

function About({ text, page, label }: { text?: string; page?: string; label: string }) {
  if (!text && !page) return null;
  return (
    <Block>
      {text && <p className={styles.pageText}>{text}</p>}
      {page && (
        <button type="button" className={styles.link} onClick={() => openExternal(page)}>
          {`Learn more about ${label}`}
        </button>
      )}
    </Block>
  );
}

/** One agent: its state and account, Install / Sign in / Sign out, its model, Test connection; Gemini's images and key. */
function ProviderPage({ p, service }: { p: ProviderInfo; service: AgentsService }) {
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
      if (!r.ok) showToast({ message: r.error ?? `Couldn't install ${p.label}`, kind: "error" });
      else {
        showToast({ message: r.opened === "installed" ? `${p.label} installed` : `Opened ${p.label}’s download page` });
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
        <Field label="Status">
          <span className={cx(styles.dot, on && styles.dotOn)} />
          <span data-provider-state="">{state}</span>
        </Field>
        {account && <Field label="Account">{account}</Field>}
        {where && <Field label={cli ? "Location" : "Address"}><span className={styles.mono}>{where}</span></Field>}
        {auth?.state === "signing-in" && (
          <div className={styles.pageText}>
            <Spinner size={16} /> Waiting for the sign-in to finish…{" "}
            {auth.url && (
              <button type="button" className={styles.link} onClick={() => openExternal(auth.url!)}>
                Open the sign-in page
              </button>
            )}
          </div>
        )}
        {notInstalled && p.install?.command && <code className={styles.command}>{p.install.command}</code>}
        {!cli && !p.available && !custom && <p className={styles.pageText}>{`Start ${p.label} and load a model, then Look again.`}</p>}
        {p.available && p.models.length > 1 && (
          <Field label="Model">
            <Select label="Model" className={styles.fieldSelect} value={service.modelOf(p) ?? ""} options={p.models.map((m) => ({ value: m, label: modelLabel(m) }))} onChange={(m) => void service.choose(p.id, m)} />
          </Field>
        )}
        <div className={styles.actions}>
          {notInstalled && (
            <Button variant="primary" loading={busy === "install"} onClick={() => void install()} data-install="">
              Install
            </Button>
          )}
          {cli && auth?.state === "signed-out" && (
            <Button variant="primary" loading={busy === "sign-in"} onClick={() => void run("sign-in", async () => setAuth(await api!.signIn(p.id)))} data-sign-in="">
              Sign in
            </Button>
          )}
          {!cli && !p.available && !custom && p.install && (
            <Button variant="secondary" loading={busy === "install"} onClick={() => void install()} data-install="">
              Install
            </Button>
          )}
          {!cli && !p.available && (
            <Button variant="secondary" loading={busy === "look"} onClick={() => void run("look", () => service.refreshProviders())}>
              Look again
            </Button>
          )}
          {(p.available || (cli && auth?.state === "signed-out")) && (
            <Button
              variant="secondary"
              loading={busy === "test"}
              onClick={() =>
                void run("test", async () => {
                  const r = await api!.test(p.id).catch((err: unknown) => ({ ok: false, models: [] as string[], error: String(err), version: undefined }));
                  setTest({ ok: r.ok, text: r.ok ? (cli ? `Ready${r.version ? ` · ${r.version}` : ""}` : `Connected · ${r.models.length} models`) : (r.error ?? "Failed") });
                  void service.refreshProviders();
                })
              }
              data-test-connection=""
            >
              Test connection
            </Button>
          )}
          {cli && auth?.state === "connected" && (
            <Button variant="secondary" loading={busy === "sign-out"} onClick={() => void run("sign-out", async () => { setAuth(await api!.signOut(p.id)); await service.refreshProviders(); })} data-sign-out="">
              Sign out
            </Button>
          )}
          {custom && (
            <Button variant="secondary" onClick={() => void api?.removeServer(p.id).then(() => { service.openSetting(null); return service.refreshProviders(); })} data-remove-server="">
              Remove server
            </Button>
          )}
        </div>
        {test && <div className={cx(styles.testResult, !test.ok && styles.testFail)} role="status">{test.text}</div>}
      </Block>
      {p.imageGen && p.imageGen.state !== "unavailable" && <ImageGeneration p={p} service={service} />}
      {p.imageGen && <Block title="Gemini API key"><KeyForm p={p} service={service} /></Block>}
      <About text={about?.text ?? (custom ? "An OpenAI-compatible server you added. Its models show up in the chat’s agent menu while it answers." : p.note)} page={about?.page ?? p.install?.page} label={p.label} />
    </div>
  );
}

const IMAGE_STATE: Record<ImageGenState["state"], string> = { ready: "Ready", "needs-sign-in": "Needs API key", "needs-key": "Needs API key", "not-installed": "Not installed", unavailable: "Not available" };

/** The Gemini image state the page shows: what Save / Remove key said, until the next report replaces it. */
function useImageGen(p: ProviderInfo) {
  const [local, setLocal] = useState<{ of: ImageGenState | undefined; gen: ImageGenState } | null>(null);
  const gen = local && local.of === p.imageGen ? local.gen : p.imageGen!;
  return [gen, (g: ImageGenState) => setLocal({ of: p.imageGen, gen: g })] as const;
}

/** Gemini's image generation (Nano Banana, a Gemini CLI extension): its state and Install. */
function ImageGeneration({ p, service }: { p: ProviderInfo; service: AgentsService }) {
  const [gen] = useImageGen(p);
  const [busy, setBusy] = useState(false);
  const api = service.api!;
  return (
    <Block title="Image generation" data-image-gen={gen.state}>
      <Field label="Status">
        <span className={cx(styles.dot, gen.state === "ready" && styles.dotOn)} />
        <span data-image-gen-state="">{IMAGE_STATE[gen.state]}</span>
      </Field>
      {gen.detail && gen.state !== "needs-key" && gen.state !== "needs-sign-in" && <p className={styles.pageText}>{gen.detail}</p>}
      {(gen.state === "needs-key" || gen.state === "needs-sign-in") && <p className={styles.pageText}>Images need your Gemini API key — add it below.</p>}
      {gen.state === "not-installed" && (
        <div className={styles.actions}>
          <Button
            variant="secondary"
            loading={busy}
            onClick={() => {
              setBusy(true);
              void api
                .install(p.id, "nanobanana")
                .then((r) => {
                  showToast(r.ok ? { message: "Nano Banana installed" } : { message: r.error ?? "Couldn't install Nano Banana", kind: "error" });
                  if (r.ok) void service.refreshProviders();
                })
                .finally(() => setBusy(false));
            }}
            data-install-images=""
          >
            Install Nano Banana
          </Button>
        </div>
      )}
    </Block>
  );
}

/**
 * The owner's Gemini API key — pasted here by them, kept with the OS keychain (safeStorage), handed to Gemini CLI's
 * runs only (the chat and Nano Banana's images).
 */
function KeyForm({ p, service }: { p: ProviderInfo; service: AgentsService }) {
  const [gen, setGen] = useImageGen(p);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const save = async (k: string | null) => {
    setBusy(true);
    try {
      setGen(await service.api!.setImageKey(k));
      setKey("");
      await service.refreshProviders();
    } catch (err) {
      showToast({ message: errorText(err), kind: "error" });
    } finally {
      setBusy(false);
    }
  };
  if (gen.keyAdded)
    return (
      <div className={styles.pageBody} data-image-key="added">
        <Field label="Key">
          <span className={cx(styles.dot, styles.dotOn)} />
          Key added
        </Field>
        <div className={styles.actions}>
          <Button variant="secondary" loading={busy} onClick={() => void save(null)} data-remove-image-key="">
            Remove key
          </Button>
        </div>
      </div>
    );
  return (
    <div className={styles.pageBody} data-image-key="none">
      <TextInput label="Gemini API key" placeholder="Paste your Gemini API key" secret value={key} onChange={setKey} />
      <div className={styles.actions}>
        <Button variant="primary" disabled={!key.trim()} loading={busy} onClick={() => void save(key)} data-save-image-key="">
          Save key
        </Button>
        <button type="button" className={styles.link} onClick={() => openExternal("https://aistudio.google.com/apikey")}>
          Get a key in Google AI Studio
        </button>
      </div>
    </div>
  );
}

function GeminiKeyPage({ service }: { service: AgentsService }) {
  const p = service.get().providers.find((x) => x.id === "gemini");
  return (
    <div className={styles.pageBody}>
      <Block>{p?.imageGen ? <KeyForm p={p} service={service} /> : <p className={styles.pageText}>Looking for Gemini CLI…</p>}</Block>
      <About text="Gemini CLI runs with a Gemini API key from Google AI Studio — the chat and Nano Banana’s images both. It is kept in your keychain and sent only to Google." page="https://aistudio.google.com/apikey" label="Gemini API keys" />
    </div>
  );
}

function AddServer({ service }: { service: AgentsService }) {
  const [label, setLabel] = useState("");
  const [url, setUrl] = useState("");
  const [key, setKey] = useState("");
  return (
    <div className={styles.pageBody}>
      <Block>
        <TextInput label="Name" placeholder="Name" value={label} onChange={setLabel} />
        <TextInput label="Base URL" placeholder="http://localhost:8080/v1" value={url} onChange={setUrl} />
        <TextInput label="API key (optional)" placeholder="API key (optional)" secret value={key} onChange={setKey} />
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
            Add server
          </Button>
        </div>
      </Block>
      <About text="Any server with an OpenAI-compatible chat API (/v1/chat/completions) — vLLM, llama.cpp, a hosted service. The key is kept in your keychain." label="servers" />
    </div>
  );
}

/** The MCP server this app runs: its address and who is connected. */
function McpPage({ service }: { service: AgentsService }) {
  const { mcp } = service.get();
  const n = mcp.connections.length;
  return (
    <div className={styles.pageBody}>
      <Block>
        <Field label="Address" data-mcp-url="">
          <span className={styles.mono}>{mcp.url ?? "Not running"}</span>
          {mcp.url && <IconButton icon="24.copy.small" label="Copy URL" tone="secondary" onClick={() => void navigator.clipboard.writeText(mcp.url!).then(() => showToast({ message: "Copied to clipboard" }))} />}
        </Field>
        <Field label="Connections">{n === 0 ? "None" : [...new Set(mcp.connections.map((c) => c.client))].join(", ")}</Field>
      </Block>
      <About text="Apps on this computer that have its token can read and edit the file in front. Connect them from the list." label="MCP" />
    </div>
  );
}

/** An MCP client: Connect (writes its config file) / Disconnect, and its config to copy. */
function ClientPage({ c, service }: { c: McpClientInfo; service: AgentsService }) {
  const copy = async () => {
    const cfg = await service.api!.clientConfig(c.id);
    await navigator.clipboard.writeText(cfg.text);
    showToast({ message: `Copied — paste it into ${cfg.path.replace(/^\/Users\/[^/]+/, "~")}` });
  };
  return (
    <div className={styles.pageBody} data-client={c.id} data-connected={c.connected || undefined}>
      <Block>
        <Field label="Status">
          <span className={cx(styles.dot, c.connected && styles.dotOn)} />
          {c.connected ? "Connected" : c.installed ? "Not connected" : "Not installed"}
        </Field>
        <Field label="Config"><span className={styles.mono}>{c.configPath}</span></Field>
        <div className={styles.actions}>
          {c.connected ? (
            <Button variant="secondary" onClick={async () => { const r = await service.api!.disconnect(c.id); if (!r.ok && r.error) showToast({ message: r.error, kind: "error" }); await service.refreshSetup(); }}>
              Disconnect
            </Button>
          ) : (
            <Button
              variant="primary"
              disabled={!c.installed}
              onClick={async () => {
                const r = await service.api!.connect(c.id);
                if (r.ok) showToast({ message: `Connected ${c.label}${r.backup ? " (the old config was kept as a backup)" : ""}. Restart it if it was open.` });
                else if (r.error) showToast({ message: r.error, kind: "error" });
                await service.refreshSetup();
              }}
            >
              {`Connect to ${c.label}`}
            </Button>
          )}
          <Button variant="secondary" onClick={() => void copy()}>
            Copy config
          </Button>
        </div>
      </Block>
      <About text={`Connect adds this app’s MCP server to ${c.label}’s config, so ${c.label} can read and edit the file in front. Restart ${c.label} after connecting.`} label="MCP" />
    </div>
  );
}
