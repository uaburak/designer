/**
 * Agent settings' Skills and Connectors (docs/ai.md §2.10–2.11): the list's two groups, and their pages — a skill's
 * editor (Name = its slash command, Description, Instructions; Upload a file, Export, Disable skill, Delete) and a
 * connector's (its state, Test connection, on/off, each tool's policy Allow / Ask / Off, Remove). Skills are the
 * store's (6g), connectors main's. No editor or engine import (Home's Settings › Agents shows these too).
 */
import { useRef, useState, type ReactNode } from "react";
import { Button, Select, Spinner, Switch, TextInput, showToast } from "@/ds";
import { SKILL_LIMITS, type AiSkill, type Connector, type ConnectorToolPolicy } from "@shared/ai/types";
import { parseSkillFile, skillFileText, skillNameOf, skillProblem, type SkillDraft } from "@shared/ai/skillFile";
import type { AgentSetupHost } from "../../agents/setup";
import { changeConnectors, removeSkill, saveSkill, testConnector, useConnectors, useSkills } from "./aiData";
import { Block, Field, Group, Row, errorText } from "./settingsParts";
import styles from "./Agents.module.css";

const POLICY_OPTIONS = [
  { value: "allow", label: "Allow" },
  { value: "ask", label: "Ask" },
  { value: "off", label: "Off" },
];

const connectorStatus = (c: Connector) => (!c.enabled ? "Off" : c.state === "connected" ? "Connected" : c.state === "error" ? "Can’t connect" : "Not tested");

// ---- The list's groups ----

export function SkillsGroup({ service }: { service: AgentSetupHost }) {
  const { list, loading, error } = useSkills();
  return (
    <Group title="Skills">
      {loading && <div className={styles.rowNote}><Spinner size={16} /> Reading skills…</div>}
      {error && <div className={styles.rowNote} data-skills-error="">{error}</div>}
      {list.map((s) => (
        <Row key={s.id} icon="24.agents" label={`/${s.name}`} status={s.enabled ? "On" : "Off"} on={s.enabled} dim={!s.enabled} onClick={() => service.openSetting(`skill:${s.id}`)} data-skill={s.name} />
      ))}
      {!error && <Row icon="24.plus" label="Add skill" onClick={() => service.openSetting("add-skill")} data-settings-row="add-skill" />}
    </Group>
  );
}

export function ConnectorsGroup({ service }: { service: AgentSetupHost }) {
  const { list, error } = useConnectors(service.api);
  if (!service.api?.connectors) return null;
  return (
    <Group title="Connectors">
      {error && <div className={styles.rowNote}>{error}</div>}
      {list.map((c) => (
        <Row key={c.id} icon="24.link" label={c.name} status={connectorStatus(c)} on={c.enabled && c.state === "connected"} dim={!c.enabled} onClick={() => service.openSetting(`connector:${c.id}`)} data-connector={c.id} />
      ))}
      <Row icon="24.plus" label="Add connector" onClick={() => service.openSetting("add-connector")} data-settings-row="add-connector" />
    </Group>
  );
}

/** A Skills or Connectors page of Agent settings, or null when `kind` is another's. */
export function aiSettingsPage(kind: string, id: string, service: AgentSetupHost): { title: string; body: ReactNode } | null {
  if (kind === "add-skill") return { title: "Add skill", body: <SkillPage service={service} /> };
  if (kind === "skill") return { title: "Skill", body: <SkillPage service={service} id={id} /> };
  if (kind === "add-connector") return { title: "Add connector", body: <AddConnector service={service} /> };
  if (kind === "connector") return { title: "Connector", body: <ConnectorPage service={service} id={id} /> };
  return null;
}

// ---- A skill ----

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/markdown" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function SkillPage({ service, id }: { service: AgentSetupHost; id?: string }) {
  const { list } = useSkills();
  const skill = id ? list.find((s) => s.id === id) : undefined;
  if (id && !skill) return <p className={styles.pageText}>This skill isn’t listed any more.</p>;
  return <SkillEditor key={skill?.id ?? "new"} service={service} skill={skill} />;
}

function SkillEditor({ service, skill }: { service: AgentSetupHost; skill?: AiSkill }) {
  const [draft, setDraft] = useState<SkillDraft>(skill ? { name: skill.name, description: skill.description, instructions: skill.instructions } : { name: "", description: "", instructions: "" });
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const upload = async (f: File | undefined) => {
    if (!f) return;
    const parsed = parseSkillFile(await f.text(), f.name);
    if ("error" in parsed) return setProblem(parsed.error);
    setProblem(null);
    setDraft(parsed);
  };
  const save = async (patch: Partial<AiSkill> = {}) => {
    const clean = { ...draft, name: skillNameOf(draft.name) };
    const p = skillProblem(clean);
    if (p) return setProblem(p);
    setBusy(true);
    try {
      const saved = await saveSkill({ ...(skill ? { id: skill.id } : {}), ...clean, enabled: patch.enabled ?? skill?.enabled ?? true });
      showToast({ message: skill ? "Skill saved" : `Skill added — type /${saved.name} in a message to use it` });
      service.openSetting(`skill:${saved.id}`);
    } catch (err) {
      setProblem(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={styles.pageBody} data-skill-editor="">
      {!skill && (
        <Block>
          <p className={styles.pageText}>A skill is a set of instructions agents follow when you type its name with a /, or when its description fits the task.</p>
          <div className={styles.actions}>
            <Button variant="secondary" onClick={() => file.current?.click()} data-skill-upload="">
              Upload a file
            </Button>
            <input ref={file} type="file" accept=".md,text/markdown" hidden onChange={(e) => void upload(e.target.files?.[0]).finally(() => (e.target.value = ""))} />
          </div>
        </Block>
      )}
      <Block title={skill ? undefined : "Start from scratch"}>
        <TextInput label="Name" placeholder="brand-voice" value={draft.name} maxLength={SKILL_LIMITS.name} onChange={(v) => setDraft({ ...draft, name: v.toLowerCase().replace(/[^a-z0-9-]+/g, "-") })} data-skill-name="" />
        <TextInput label="Description" placeholder="When to use it" value={draft.description} maxLength={SKILL_LIMITS.description} onChange={(v) => setDraft({ ...draft, description: v })} data-skill-description="" />
        <textarea className={styles.textArea} aria-label="Instructions" placeholder="Instructions" value={draft.instructions} rows={8} onChange={(e) => setDraft({ ...draft, instructions: e.target.value })} onKeyDown={(e) => e.stopPropagation()} data-skill-instructions="" />
        {problem && <div className={styles.attachProblem} role="alert">{problem}</div>}
        <div className={styles.actions}>
          <Button variant="primary" disabled={busy} onClick={() => void save()} data-skill-save="">
            {skill ? "Save" : "Add skill"}
          </Button>
          {skill && (
            <>
              <Button variant="secondary" onClick={() => download(`${skill.name}.md`, skillFileText(draft))}>Export</Button>
              <Button variant="secondary" disabled={busy} onClick={() => void save({ enabled: !skill.enabled })} data-skill-toggle="">
                {skill.enabled ? "Disable skill" : "Enable skill"}
              </Button>
              <Button
                variant="secondary"
                disabled={busy}
                onClick={async () => {
                  try {
                    await removeSkill(skill.id);
                    service.openSetting(null);
                  } catch (err) {
                    setProblem(errorText(err));
                  }
                }}
                data-skill-delete=""
              >
                Delete
              </Button>
            </>
          )}
        </div>
      </Block>
    </div>
  );
}

// ---- A connector ----

/** "npx -y @acme/mcp --port 3" → the command and its arguments ("quoted words" kept together). */
export function splitCommand(line: string): string[] {
  return (line.match(/"([^"]*)"|'([^']*)'|\S+/g) ?? []).map((w) => w.replace(/^"(.*)"$|^'(.*)'$/, "$1$2"));
}

function AddConnector({ service }: { service: AgentSetupHost }) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"http" | "stdio">("http");
  const [url, setUrl] = useState("");
  const [key, setKey] = useState("");
  const [command, setCommand] = useState("");
  const [busy, setBusy] = useState(false);
  const api = service.api;
  const ready = name.trim() && (kind === "http" ? /^https?:\/\/\S+$/i.test(url.trim()) : splitCommand(command).length > 0);
  return (
    <div className={styles.pageBody}>
      <Block>
        <TextInput label="Name" placeholder="Name" value={name} onChange={setName} data-connector-name="" />
        <Select
          label="Connection"
          value={kind}
          options={[
            { value: "http", label: "Server URL" },
            { value: "stdio", label: "Command on this computer" },
          ]}
          onChange={(v) => setKind(v as "http" | "stdio")}
        />
        {kind === "http" ? (
          <>
            <TextInput label="Server URL" placeholder="https://example.com/mcp" value={url} onChange={setUrl} data-connector-url="" />
            <TextInput label="API key (optional)" placeholder="API key (optional)" secret value={key} onChange={setKey} />
          </>
        ) : (
          <TextInput label="Command" placeholder="npx -y @example/mcp-server" value={command} onChange={setCommand} data-connector-command="" />
        )}
        <div className={styles.actions}>
          <Button
            variant="primary"
            disabled={!ready || busy || !api?.addConnector}
            onClick={async () => {
              setBusy(true);
              try {
                const words = splitCommand(command);
                const before = new Set((await api!.connectors!()).map((c) => c.id));
                const list = await api!.addConnector!({ name: name.trim(), transport: kind === "http" ? { kind, url: url.trim(), ...(key ? { key } : {}) } : { kind, command: words[0], args: words.slice(1) } });
                await changeConnectors(Promise.resolve(list));
                const added = list.find((c) => !before.has(c.id));
                if (added) {
                  service.openSetting(`connector:${added.id}`);
                  await testConnector(api!, added.id);
                } else service.openSetting(null);
              } catch (err) {
                showToast({ message: errorText(err), kind: "error" });
              } finally {
                setBusy(false);
              }
            }}
            data-add-connector=""
          >
            Add connector
          </Button>
        </div>
      </Block>
      <Block>
        <p className={styles.pageText}>An MCP server your agents can use in chats where you turn it on. Agents reach it through this app: each tool asks before it runs unless you allow it. Keys are kept in your keychain.</p>
      </Block>
    </div>
  );
}

function ConnectorPage({ service, id }: { service: AgentSetupHost; id: string }) {
  const { list } = useConnectors(service.api);
  const c = list.find((x) => x.id === id);
  const [testing, setTesting] = useState(false);
  const api = service.api;
  if (!c || !api?.updateConnector) return <p className={styles.pageText}>This connector isn’t listed any more.</p>;
  const update = (p: { enabled?: boolean; policies?: Record<string, ConnectorToolPolicy> }) => void changeConnectors(api.updateConnector!({ id: c.id, ...p })).catch((err) => showToast({ message: errorText(err), kind: "error" }));
  const test = async () => {
    setTesting(true);
    try {
      const r = await testConnector(api, c.id);
      showToast(r.state === "connected" ? { message: `${r.name} is connected` } : { message: r.error ?? "Can’t connect", kind: "error" });
    } catch (err) {
      showToast({ message: errorText(err), kind: "error" });
    } finally {
      setTesting(false);
    }
  };
  return (
    <div className={styles.pageBody} data-connector-page={c.id}>
      <Block>
        <Field label="Name">{c.name}</Field>
        <Field label="Status" data-connector-state={c.state}>
          {connectorStatus(c)}
        </Field>
        {c.error && <p className={styles.attachProblem}>{c.error}</p>}
        <Field label={c.transport.kind === "http" ? "Server URL" : "Command"}>
          <span className={styles.mono}>{c.transport.kind === "http" ? c.transport.url : [c.transport.command, ...c.transport.args].join(" ")}</span>
        </Field>
        <Field label="On">
          <Switch label="Connector on" checked={c.enabled} onChange={(on) => update({ enabled: on })} />
        </Field>
        <div className={styles.actions}>
          <Button variant="secondary" disabled={testing} onClick={() => void test()} data-connector-test="">
            {testing ? "Testing…" : "Test connection"}
          </Button>
        </div>
      </Block>
      <Block title="Tools">
        {!c.tools.length && <p className={styles.pageText}>Test the connection to list its tools.</p>}
        {c.tools.map((t) => (
          <div key={t.name} className={styles.toolPolicy} data-connector-tool={t.name}>
            <span className={styles.toolPolicyName} title={t.description}>
              {t.name}
            </span>
            <Select label={`${t.name} permission`} variant="ghost" width="hug" value={t.policy} options={POLICY_OPTIONS} onChange={(v) => update({ policies: { [t.name]: v as ConnectorToolPolicy } })} />
          </div>
        ))}
        {c.tools.length > 0 && <p className={styles.pageText}>Allow runs the tool; Ask shows a card in the chat first; Off hides it from agents.</p>}
      </Block>
      <Block>
        <div className={styles.actions}>
          <Button
            variant="secondary"
            onClick={async () => {
              try {
                await changeConnectors(api.removeConnector!(c.id));
                service.openSetting(null);
              } catch (err) {
                showToast({ message: errorText(err), kind: "error" });
              }
            }}
            data-connector-remove=""
          >
            Remove connector
          </Button>
        </div>
      </Block>
    </div>
  );
}
