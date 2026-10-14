/**
 * Agent settings › Access (docs/agents-reach.md §2, round 16 [ours]): what agents may reach outside the file — Web,
 * GitHub, Local files, Local apps — each Off (the default) / Ask each time / Always allow with its own grants, and the
 * access log. Everything is main's (`agents.reach`); a capability an organization turned off can't be turned on. No
 * editor or engine import: Home's Settings › Agents shows this too.
 */
import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { Button, IconButton, Select, Spinner, TextInput, showToast, type IconName } from "@/ds";
import type { ReachApi } from "@shared/agents/types";
import type { AccessLogEntry, ReachCapability, ReachPatch, ReachPolicy, ReachView } from "@shared/agents/reach";
import { normalizeAllowedHost } from "@shared/agents/reachNet";
import type { AgentSetupHost } from "../../agents/setup";
import { Block, Field, Group, Row, errorText } from "./settingsParts";
import { GithubConnection } from "./AccessGithub";
import styles from "./Agents.module.css";
import { intlLocale, t, useT } from "@/i18n";

export const CAPABILITIES: { cap: ReachCapability; label: string; icon: IconName; about: string }[] = [
  { cap: "web", label: "Web", icon: "24.globe", about: "Agents can open public web pages in a private browser (no cookies, no logins), see them and capture their design as layers." },
  { cap: "github", label: "GitHub", icon: "24.text.code", about: "Agents can read the GitHub repositories you pick — their files and code — to build designs from them. Nothing is run or changed." },
  { cap: "files", label: "Local files", icon: "24.folder", about: "Agents can read files in the folders you grant on this computer. Keys, passwords and .env files stay off limits. Nothing is changed." },
  { cap: "apps", label: "Local apps", icon: "24.window.layout", about: "Agents can see a window of another app on this computer: you pick the window each time. They can't click or type in it." },
];

const POLICIES: { value: ReachPolicy; label: string }[] = [
  { value: "off", label: "Off" },
  { value: "ask", label: "Ask each time" },
  { value: "allow", label: "Always allow" },
];

// ── The view, one copy per page ──

let api: ReachApi | null = null;
let value: { view: ReachView | null; error: string | null } = { view: null, error: null };
const listeners = new Set<() => void>();
const set = (v: Partial<typeof value>) => {
  value = { ...value, ...v };
  listeners.forEach((l) => l());
};
const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => void listeners.delete(fn);
};
const get = () => value;

/** Reads the view (again) through main. */
export async function refreshReach(): Promise<void> {
  if (!api) return set({ error: t("Access works in the desktop app.") });
  try {
    set({ view: await api.view(), error: null });
  } catch (err) {
    set({ error: errorText(err) });
  }
}

/** A change through main; its answer replaces the view. */
export async function changeReach(job: (a: ReachApi) => Promise<ReachView>): Promise<void> {
  if (!api) return;
  try {
    set({ view: await job(api), error: null });
  } catch (err) {
    showToast({ message: errorText(err), kind: "error" });
  }
}

export function useReach(host: AgentSetupHost) {
  useEffect(() => {
    if (host.api?.reach && api !== host.api.reach) {
      api = host.api.reach;
      void refreshReach();
    } else if (!value.view && !value.error) void refreshReach();
  }, [host]);
  return useSyncExternalStore(subscribe, get);
}

export const reachApi = () => api;

const policyText = (view: ReachView, cap: ReachCapability) => (view.forcedOff.includes(cap) ? t("Turned off by your organization") : t(POLICIES.find((p) => p.value === view.settings.policies[cap])?.label ?? "Off"));

// ── The list's group ──

export function AccessGroup({ service }: { service: AgentSetupHost }) {
  useT();
  const { view, error } = useReach(service);
  if (!service.api?.reach) return null;
  return (
    <Group title={t("Access")}>
      {error && <div className={styles.rowNote}>{error}</div>}
      {!view && !error && <div className={styles.rowNote}><Spinner size={16} /></div>}
      {view &&
        CAPABILITIES.map(({ cap, label, icon }) => {
          const on = !view.forcedOff.includes(cap) && view.settings.policies[cap] !== "off";
          return <Row key={cap} icon={icon} label={t(label)} status={policyText(view, cap)} on={on} dim={!on} onClick={() => service.openSetting(`access:${cap}`)} data-access={cap} data-access-policy={view.forcedOff.includes(cap) ? "forced-off" : view.settings.policies[cap]} />;
        })}
      <Row icon="24.lock.small" label={t("Access log")} onClick={() => service.openSetting("access:log")} data-settings-row="access-log" />
    </Group>
  );
}

/** Access's pages of Agent settings, or null when `kind` is another's. */
export function accessSettingsPage(kind: string, id: string, service: AgentSetupHost): { title: string; body: ReactNode } | null {
  if (kind !== "access") return null;
  if (id === "log") return { title: t("Access log"), body: <AccessLog service={service} /> };
  const c = CAPABILITIES.find((x) => x.cap === id);
  return c ? { title: t(c.label), body: <CapabilityPage service={service} cap={c.cap} /> } : null;
}

// ── A capability's page ──

function CapabilityPage({ service, cap }: { service: AgentSetupHost; cap: ReachCapability }) {
  useT();
  const { view, error } = useReach(service);
  if (error) return <p className={styles.pageText}>{error}</p>;
  if (!view) return <div className={styles.rowNote}><Spinner size={16} /></div>;
  const c = CAPABILITIES.find((x) => x.cap === cap)!;
  const forced = view.forcedOff.includes(cap);
  const patch = (p: ReachPatch) => void changeReach((a) => a.set(p));
  return (
    <div className={styles.pageBody} data-access-page={cap}>
      <Block>
        <p className={styles.pageText}>{t(c.about)}</p>
        <Field label={t("Permission")}>
          <Select label={t("{name} access", { name: t(c.label) })} variant="ghost" width="hug" disabled={forced} value={forced ? "off" : view.settings.policies[cap]} options={POLICIES.map((o) => ({ ...o, label: t(o.label) }))} onChange={(v) => patch({ policies: { [cap]: v as ReachPolicy } })} data-access-select={cap} />
        </Field>
        {forced && <p className={styles.attachProblem}>{t("Your organization turned this off for its members.")}</p>}
        <p className={styles.pageText}>{t("Ask each time shows a card in the chat before each use; Always allow lets agents use it without asking. Every use is in the access log.")}</p>
      </Block>
      {cap === "web" && <WebHosts view={view} patch={patch} />}
      {cap === "github" && <GithubConnection view={view} patch={patch} />}
      {cap === "files" && <Folders view={view} patch={patch} />}
      {cap === "apps" && <AppsPermission view={view} />}
    </div>
  );
}

/** A removable line of a list (a host, a folder, a repository). */
export function ListLine({ text, onRemove, ...data }: { text: string; onRemove: () => void } & Record<`data-${string}`, string | undefined>) {
  useT();
  return (
    <div className={styles.toolPolicy} {...data}>
      <span className={styles.toolPolicyName} title={text}>{text}</span>
      <IconButton icon="24.close.small" label={t("Remove")} tone="secondary" onClick={onRemove} />
    </div>
  );
}

function WebHosts({ view, patch }: { view: ReachView; patch: (p: ReachPatch) => void }) {
  useT();
  const [text, setText] = useState("");
  const host = normalizeAllowedHost(text);
  const hosts = view.settings.web.allowedHosts;
  const add = () => {
    if (!host) return;
    patch({ allowedHosts: [...hosts, host] });
    setText("");
  };
  return (
    <Block title={t("Allowed local addresses")}>
      <p className={styles.pageText}>{t("Agents can't open local or private addresses — this computer, your network, cloud metadata. Add one here to let them, such as your dev server (localhost:5173).")}</p>
      {hosts.map((h) => <ListLine key={h} text={h} onRemove={() => patch({ allowedHosts: hosts.filter((x) => x !== h) })} data-allowed-host={h} />)}
      <div className={styles.actions}>
        <TextInput label={t("Address")} placeholder="localhost:5173" value={text} onChange={setText} onExit={(r) => r === "enter" && add()} data-allowed-host-input="" />
        <Button variant="secondary" disabled={!host} onClick={add} data-allowed-host-add="">{t("Add")}</Button>
      </div>
    </Block>
  );
}

function Folders({ view, patch }: { view: ReachView; patch: (p: ReachPatch) => void }) {
  useT();
  const folders = view.settings.files.folders;
  return (
    <Block title={t("Folders agents can read")}>
      {!folders.length && <p className={styles.pageText}>{t("No folders yet: agents can't read any file.")}</p>}
      {folders.map((f) => <ListLine key={f} text={f} onRemove={() => patch({ folders: folders.filter((x) => x !== f) })} data-access-folder={f} />)}
      <div className={styles.actions}>
        <Button variant="secondary" onClick={() => void changeReach((a) => a.addFolder())} data-access-add-folder="">{t("Add folder…")}</Button>
      </div>
      <p className={styles.pageText}>{t("Read-only. Pick a project's folder, not your whole home folder.")}</p>
    </Block>
  );
}

function AppsPermission({ view }: { view: ReachView }) {
  useT();
  const state = view.screenPermission;
  const a = reachApi();
  return (
    <Block title={t("Screen Recording")}>
      <Field label={t("Status")} data-screen-permission={state}>
        {state === "granted" ? t("Allowed") : state === "unknown" ? t("Not needed on this computer") : t("Not allowed yet")}
      </Field>
      {state !== "granted" && state !== "unknown" && (
        <>
          <p className={styles.pageText}>{t("macOS asks before an app can see other windows. Allow Wecra in System Settings › Privacy & Security › Screen & System Audio Recording, then quit and reopen Wecra.")}</p>
          {a?.openScreenSettings && (
            <div className={styles.actions}>
              <Button variant="secondary" onClick={() => void a.openScreenSettings!()} data-screen-settings="">{t("Open System Settings")}</Button>
            </div>
          )}
        </>
      )}
      <p className={styles.pageText}>{t("You pick the window in the chat each time an agent asks.")}</p>
    </Block>
  );
}

// ── The access log ──

const OUTCOME: Record<AccessLogEntry["outcome"], string> = { ok: "Allowed", denied: "Denied", refused: "Refused", error: "Failed" };

function AccessLog({ service }: { service: AgentSetupHost }) {
  useT();
  useReach(service);
  const [list, setList] = useState<AccessLogEntry[] | null>(null);
  const a = service.api?.reach;
  useEffect(() => {
    if (a) void a.log().then(setList, (err) => showToast({ message: errorText(err), kind: "error" }));
  }, [a]);
  if (!a) return <p className={styles.pageText}>{t("Access works in the desktop app.")}</p>;
  if (!list) return <div className={styles.rowNote}><Spinner size={16} /></div>;
  const when = new Intl.DateTimeFormat(intlLocale(), { dateStyle: "short", timeStyle: "short" });
  const label = (cap: ReachCapability) => t(CAPABILITIES.find((c) => c.cap === cap)?.label ?? cap);
  return (
    <div className={styles.pageBody} data-access-log="">
      <Block>
        {!list.length && <p className={styles.pageText}>{t("Nothing yet. Each time an agent reaches outside the file, it is listed here.")}</p>}
        {list.map((e, i) => (
          <div key={`${e.at}-${i}`} className={styles.logEntry} data-log-outcome={e.outcome}>
            <span className={styles.logHead}>
              <span>{label(e.capability)} · {e.tool}</span>
              <span className={styles.logOutcome}>{t(OUTCOME[e.outcome])}</span>
            </span>
            <span className={styles.mono} title={e.target}>{e.target}</span>
            <span className={styles.logMeta}>{[when.format(e.at), e.agent, e.detail].filter(Boolean).join(" · ")}</span>
          </div>
        ))}
      </Block>
      {list.length > 0 && (
        <Block>
          <div className={styles.actions}>
            <Button variant="secondary" onClick={() => void a.clearLog().then(() => setList([]))} data-access-clear-log="">{t("Clear log")}</Button>
          </div>
        </Block>
      )}
    </div>
  );
}
