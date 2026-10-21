/**
 * Agent settings' Skills and Connectors (docs/ai.md §2.10–2.11): the list's two groups, and their pages — a skill's
 * editor (Name = its slash command, Description, Instructions; Upload a file, Export, Disable skill, Delete — for
 * Wecra's default skills, docs/ai.md §8.6: a "Default" badge, saving keeps the owner's copy, Reset to default) and a
 * connector's (its state, Test connection, on/off, each tool's policy Allow / Ask / Off, Remove). Skills are the
 * store's (6g), connectors main's. No editor or engine import (Home's Settings › Agents shows these too).
 */
import { useRef, useState, type ReactNode } from "react";
import { Badge, Button, Select, Spinner, Switch, TextInput, showToast } from "@/ds";
import { SKILL_LIMITS, type AiSkill, type Connector, type ConnectorToolPolicy } from "@shared/ai/types";
import { parseSkillFile, skillFileText, skillNameOf, skillProblem, type SkillDraft } from "@shared/ai/skillFile";
import { defaultSkillId, type SkillEntry } from "@shared/agents/defaultSkills";
import type { AgentSetupHost } from "../../agents/setup";
import { changeConnectors, removeSkill, resetSkill, saveSkill, setDefaultSkillOn, signInConnector, testConnector, useConnectors, useSkills } from "./aiData";
import { Block, Field, Group, Row, errorText } from "./settingsParts";
import styles from "./Agents.module.css";
import { t, useT } from "@/i18n";

const POLICY_OPTIONS = [
  { value: "allow", label: "Allow" },
  { value: "ask", label: "Ask" },
  { value: "off", label: "Off" },
];

export const connectorStatus = (c: Connector) => (!c.enabled ? t("Off") : c.state === "connected" ? t("Connected") : c.state === "sign-in" ? t("Sign in needed") : c.state === "error" ? t("Can’t connect") : t("Not tested"));

// ---- The list's groups ----

export function SkillsGroup({ service }: { service: AgentSetupHost }) {
  useT();
  const { list, loading, error } = useSkills();
  return (
    <Group title={t("Skills")}>
      {loading && <div className={styles.rowNote}><Spinner size={16} /> {t("Reading skills…")}</div>}
      {error && <div className={styles.rowNote} data-skills-error="">{error}</div>}
      {list.map((s) => (
        <Row
          key={s.id}
          icon="24.agents"
          label={`/${s.name}`}
          badge={s.origin && <Badge className={styles.rowBadge} data-skill-default={s.origin}>{s.origin === "override" ? t("Default · edited") : t("Default")}</Badge>}
          status={s.enabled ? t("On") : t("Off")}
          on={s.enabled}
          dim={!s.enabled}
          onClick={() => service.openSetting(`skill:${s.id}`)}
          data-skill={s.name}
        />
      ))}
      {!error && <Row icon="24.plus" label={t("Add skill")} onClick={() => service.openSetting("add-skill")} data-settings-row="add-skill" />}
    </Group>
  );
}

export function ConnectorsGroup({ service }: { service: AgentSetupHost }) {
  useT();
  const { list, error } = useConnectors(service.api);
  if (!service.api?.connectors) return null;
  return (
    <Group title={t("Connectors")}>
      {error && <div className={styles.rowNote}>{error}</div>}
      {list.map((c) => (
        <Row key={c.id} icon="24.link" label={c.name} status={connectorStatus(c)} on={c.enabled && c.state === "connected"} dim={!c.enabled} onClick={() => service.openSetting(`connector:${c.id}`)} data-connector={c.id} />
      ))}
      <Row icon="24.plus" label={t("Add connector")} onClick={() => service.openSetting("add-connector")} data-settings-row="add-connector" />
    </Group>
  );
}

/** A Skills or Connectors page of Agent settings, or null when `kind` is another's. */
export function aiSettingsPage(kind: string, id: string, service: AgentSetupHost): { title: string; body: ReactNode } | null {
  if (kind === "add-skill") return { title: t("Add skill"), body: <SkillPage service={service} /> };
  if (kind === "skill") return { title: t("Skill"), body: <SkillPage service={service} id={id} /> };
  if (kind === "add-connector") return { title: t("Add connector"), body: <AddConnector service={service} /> };
  if (kind === "connector") return { title: t("Connector"), body: <ConnectorPage service={service} id={id} /> };
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
  useT();
  const { list } = useSkills();
  const skill = id ? list.find((s) => s.id === id) : undefined;
  if (id && !skill) return <p className={styles.pageText}>{t("This skill isn’t listed any more.")}</p>;
  return <SkillEditor key={skill?.id ?? "new"} service={service} skill={skill} />;
}

function SkillEditor({ service, skill }: { service: AgentSetupHost; skill?: SkillEntry }) {
  useT();
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
  // A default as shipped: saving makes the owner's copy (same name, no id yet); on / off alone is kept apart.
  const shipped = skill?.origin === "default";
  const run = async (job: () => Promise<void>) => {
    setBusy(true);
    try {
      await job();
    } catch (err) {
      setProblem(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  const toggle = () => (skill?.origin === "default" ? run(() => setDefaultSkillOn(skill.name, !skill.enabled)) : save({ enabled: !skill?.enabled }));
  const save = async (patch: Partial<AiSkill> = {}) => {
    const clean = { ...draft, name: skill?.origin ? skill.name : skillNameOf(draft.name) };
    const p = skillProblem(clean);
    if (p) return setProblem(p);
    setBusy(true);
    try {
      const saved = await saveSkill({ ...(skill && !shipped ? { id: skill.id } : {}), ...clean, enabled: patch.enabled ?? skill?.enabled ?? true });
      showToast({ message: skill ? t("Skill saved") : t("Skill added — type /{name} in a message to use it", { name: saved.name }) });
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
          <p className={styles.pageText}>{t("A skill is a set of instructions agents follow when you type its name with a /, or when its description fits the task.")}</p>
          <div className={styles.actions}>
            <Button variant="secondary" onClick={() => file.current?.click()} data-skill-upload="">
              {t("Upload a file")}
            </Button>
            <input ref={file} type="file" accept=".md,text/markdown" hidden onChange={(e) => void upload(e.target.files?.[0]).finally(() => (e.target.value = ""))} />
          </div>
        </Block>
      )}
      {skill?.origin && (
        <Block data-skill-origin={skill.origin}>
          <p className={styles.pageText}>
            {skill.origin === "default"
              ? t("A default skill that comes with Wecra. Your changes are saved as your own copy; Reset to default brings back Wecra’s version.")
              : t("You changed this default skill. Reset to default brings back Wecra’s version.")}
          </p>
        </Block>
      )}
      <Block title={skill ? undefined : t("Start from scratch")}>
        <TextInput label={t("Name")} placeholder="brand-voice" value={draft.name} maxLength={SKILL_LIMITS.name} disabled={!!skill?.origin} onChange={(v) => setDraft({ ...draft, name: v.toLowerCase().replace(/[^a-z0-9-]+/g, "-") })} data-skill-name="" />
        <TextInput label={t("Description")} placeholder={t("When to use it")} value={draft.description} maxLength={SKILL_LIMITS.description} onChange={(v) => setDraft({ ...draft, description: v })} data-skill-description="" />
        <textarea className={styles.textArea} aria-label={t("Instructions")} placeholder={t("Instructions")} value={draft.instructions} rows={8} onChange={(e) => setDraft({ ...draft, instructions: e.target.value })} onKeyDown={(e) => e.stopPropagation()} data-skill-instructions="" />
        {problem && <div className={styles.attachProblem} role="alert">{problem}</div>}
        <div className={styles.actions}>
          <Button variant="primary" disabled={busy} onClick={() => void save()} data-skill-save="">
            {skill ? t("Save") : t("Add skill")}
          </Button>
          {skill && (
            <>
              <Button variant="secondary" onClick={() => download(`${skill.name}.md`, skillFileText(draft))}>{t("Export")}</Button>
              <Button variant="secondary" disabled={busy} onClick={() => void toggle()} data-skill-toggle="">
                {skill.enabled ? t("Disable skill") : t("Enable skill")}
              </Button>
              {skill.origin === "override" && (
                <Button
                  variant="secondary"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await resetSkill(skill);
                      showToast({ message: t("Skill reset to default") });
                      service.openSetting(`skill:${defaultSkillId(skill.name)}`);
                    })
                  }
                  data-skill-reset=""
                >
                  {t("Reset to default")}
                </Button>
              )}
              {!skill.origin && (
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
                  {t("Delete")}
                </Button>
              )}
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
  useT();
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
        <TextInput label={t("Name")} placeholder={t("Name")} value={name} onChange={setName} data-connector-name="" />
        <Select
          label={t("Connection")}
          value={kind}
          options={[
            { value: "http", label: t("Server URL") },
            { value: "stdio", label: t("Command on this computer") },
          ]}
          onChange={(v) => setKind(v as "http" | "stdio")}
        />
        {kind === "http" ? (
          <>
            <TextInput label={t("Server URL")} placeholder="https://example.com/mcp" value={url} onChange={setUrl} data-connector-url="" />
            <TextInput label={t("API key (optional)")} placeholder={t("API key (optional)")} secret value={key} onChange={setKey} />
            <p className={styles.pageText}>{t("A server you sign in to (Notion, Linear, Asana) needs no key: add it, then Sign in on its page.")}</p>
          </>
        ) : (
          <TextInput label={t("Command")} placeholder="npx -y @example/mcp-server" value={command} onChange={setCommand} data-connector-command="" />
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
            {t("Add connector")}
          </Button>
        </div>
      </Block>
      <Block>
        <p className={styles.pageText}>{t("An MCP server your agents can use in chats where you turn it on. Agents reach it through this app: each tool asks before it runs unless you allow it. Keys are kept in your keychain.")}</p>
      </Block>
    </div>
  );
}

function ConnectorPage({ service, id }: { service: AgentSetupHost; id: string }) {
  useT();
  const { list } = useConnectors(service.api);
  const c = list.find((x) => x.id === id);
  const [testing, setTesting] = useState(false);
  const [signing, setSigning] = useState(false);
  const api = service.api;
  if (!c || !api?.updateConnector) return <p className={styles.pageText}>{t("This connector isn’t listed any more.")}</p>;
  // A server that answered with a Bearer challenge is signed in to with OAuth, in the owner's browser (docs/ai.md §2.11).
  const signedIn = c.transport.kind === "http" && !!c.transport.signedIn;
  const canSignIn = c.transport.kind === "http" && !c.transport.hasKey && !!api.signInConnector && (c.state === "sign-in" || signedIn);
  const signIn = async () => {
    setSigning(true);
    try {
      const r = await signInConnector(api, c.id);
      showToast(r.state === "connected" ? { message: t("{name} is connected", { name: r.name }) } : { message: r.error ?? t("Can’t connect"), kind: "error" });
    } catch (err) {
      showToast({ message: errorText(err), kind: "error" });
    } finally {
      setSigning(false);
    }
  };
  const update = (p: { enabled?: boolean; policies?: Record<string, ConnectorToolPolicy> }) => void changeConnectors(api.updateConnector!({ id: c.id, ...p })).catch((err) => showToast({ message: errorText(err), kind: "error" }));
  const test = async () => {
    setTesting(true);
    try {
      const r = await testConnector(api, c.id);
      showToast(r.state === "connected" ? { message: t("{name} is connected", { name: r.name }) } : { message: r.error ?? t("Can’t connect"), kind: "error" });
    } catch (err) {
      showToast({ message: errorText(err), kind: "error" });
    } finally {
      setTesting(false);
    }
  };
  return (
    <div className={styles.pageBody} data-connector-page={c.id}>
      <Block>
        <Field label={t("Name")}>{c.name}</Field>
        <Field label={t("Status")} data-connector-state={c.state}>
          {connectorStatus(c)}
        </Field>
        {c.error && <p className={styles.attachProblem}>{c.error}</p>}
        <Field label={c.transport.kind === "http" ? t("Server URL") : t("Command")}>
          <span className={styles.mono}>{c.transport.kind === "http" ? c.transport.url : [c.transport.command, ...c.transport.args].join(" ")}</span>
        </Field>
        <Field label={t("On")}>
          <Switch label={t("Connector on")} checked={c.enabled} onChange={(on) => update({ enabled: on })} />
        </Field>
        {canSignIn && (
          <Field label={t("Account")} data-connector-account={signedIn && c.state !== "sign-in" ? "signed-in" : "signed-out"}>
            {signedIn && c.state !== "sign-in" ? t("You’re signed in") : t("Not signed in")}
          </Field>
        )}
        <div className={styles.actions}>
          {canSignIn && (!signedIn || c.state === "sign-in") && (
            <Button variant="primary" disabled={signing} onClick={() => void signIn()} data-connector-sign-in="">
              {signing ? t("Signing in…") : t("Sign in")}
            </Button>
          )}
          <Button variant="secondary" disabled={testing || signing} onClick={() => void test()} data-connector-test="">
            {testing ? t("Testing…") : t("Test connection")}
          </Button>
          {signedIn && api.signOutConnector && (
            <Button variant="secondary" onClick={() => void changeConnectors(api.signOutConnector!(c.id)).catch((err) => showToast({ message: errorText(err), kind: "error" }))} data-connector-sign-out="">
              {t("Sign out")}
            </Button>
          )}
        </div>
        {signing && <p className={styles.pageText}>{t("Finish signing in in your browser, then come back here.")}</p>}
      </Block>
      <Block title={t("Tools")}>
        {!c.tools.length && <p className={styles.pageText}>{t("Test the connection to list its tools.")}</p>}
        {c.tools.map((tool) => (
          <div key={tool.name} className={styles.toolPolicy} data-connector-tool={tool.name}>
            <span className={styles.toolPolicyName} title={tool.description}>
              {tool.name}
            </span>
            <Select label={t("{name} permission", { name: tool.name })} variant="ghost" width="hug" value={tool.policy} options={POLICY_OPTIONS.map((o) => ({ ...o, label: t(o.label) }))} onChange={(v) => update({ policies: { [tool.name]: v as ConnectorToolPolicy } })} />
          </div>
        ))}
        {c.tools.length > 0 && <p className={styles.pageText}>{t("Allow runs the tool; Ask shows a card in the chat first; Off hides it from agents.")}</p>}
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
            {t("Remove connector")}
          </Button>
        </div>
      </Block>
    </div>
  );
}
