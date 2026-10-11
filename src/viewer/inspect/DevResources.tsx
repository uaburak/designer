/**
 * Inspect's Dev resources (docs/editor.md D-3; help.figma.com 15023231995927): the layer's links, then — for an
 * instance — its main component's (a library's main reads the library file's links). "Add a dev resource link"
 * (Layer options, or the section's +) opens a field: paste, then Enter. Each row: the site's glyph, the name, ⋯ with
 * Edit and Delete link; a click opens the link in the browser. Names are the page's title (the desktop app reads it),
 * else the link's host and path.
 */
import { useEffect, useMemo, useState } from "react";
import { Icon, IconButton, MenuButton, PanelSection, TextInput, showToast } from "@/ds";
import type { ComponentInfo, Guid } from "@/engine/codec";
import { DEV_RESOURCE_LIMIT, type DevResourceRecord } from "@shared/devmode/types";
import { useViewer } from "../context";
import { targetOf } from "./codeConnect";
import styles from "../Viewer.module.css";

/** The site a link is on, for its glyph (GitHub, Jira, Storybook, Linear, Figma — by host — else a link). */
export function siteOf(url: string): "github" | "jira" | "storybook" | "linear" | "figma" | "link" {
  let host = "";
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return "link";
  }
  if (host === "github.com" || host.endsWith(".github.com") || host.endsWith(".github.io")) return "github";
  if (host.endsWith(".atlassian.net") || host.startsWith("jira.")) return "jira";
  if (host.includes("storybook") || host.endsWith(".chromatic.com")) return "storybook";
  if (host === "linear.app" || host.endsWith(".linear.app")) return "linear";
  if (host === "figma.com" || host.endsWith(".figma.com")) return "figma";
  return "link";
}

/** The name a link gets when its page has no title: host + path (as the store does). */
export function fallbackName(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname === "/" ? "" : u.pathname}`;
  } catch {
    return url;
  }
}

/** A link the field takes: http(s), with "https://" added to a bare host. null: not a link. */
export function linkOf(text: string): string | null {
  const t = text.trim();
  if (!t) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(t) ? t : `https://${t}`;
  try {
    const u = new URL(withScheme);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
  } catch {
    return null;
  }
}

const GLYPH: Record<ReturnType<typeof siteOf>, string> = { github: "GH", jira: "J", storybook: "S", linear: "L", figma: "", link: "" };

function Glyph({ url }: { url: string }) {
  const site = siteOf(url);
  if (site === "figma") return <Icon name="24.figma" />;
  if (site === "link") return <Icon name="24.link" />;
  return (
    <span className={styles.resourceGlyph} data-site={site} aria-hidden>
      {GLYPH[site]}
    </span>
  );
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function DevResourcesSection({ id, adding, onAdding }: { id: Guid; adding: boolean; onAdding: (on: boolean) => void }) {
  const { engine, host } = useViewer();
  const dev = host?.dev ?? null;
  const info = useMemo<ComponentInfo | null>(() => {
    try {
      return engine.componentInfo(id);
    } catch {
      return null;
    }
  }, [engine, id]);
  const [own, setOwn] = useState<DevResourceRecord[]>([]);
  const [inherited, setInherited] = useState<DevResourceRecord[]>([]);
  const [version, setVersion] = useState(0);
  const [editing, setEditing] = useState<string | null>(null);

  useEffect(() => (dev ? dev.watch((what) => what === "resources" && setVersion((v) => v + 1)) : undefined), [dev]);
  useEffect(() => {
    if (!dev) return;
    let live = true;
    const fileKey = dev.fileKey;
    void (async () => {
      const mine = fileKey ? await dev.devResources(fileKey, [id]).catch(() => []) : [];
      // An instance shows its main component's links too (a link on a component shows on all its instances).
      let main: DevResourceRecord[] = [];
      if (info && (info.kind === "INSTANCE" || info.kind === "NESTED_INSTANCE") && info.main) {
        const t = targetOf(info, fileKey);
        if (t) main = await dev.devResources(t.fileKey, [info.main.ref]).catch(() => []);
      }
      if (!live) return;
      setOwn(mine.filter((r) => r.nodeId === id));
      setInherited(main);
    })();
    return () => {
      live = false;
    };
  }, [dev, id, info, version]);

  if (!dev) return null;
  const canEdit = dev.canEdit && !!dev.addDevResource;
  if (!own.length && !inherited.length && !adding && !canEdit) return null;

  const add = async (text: string) => {
    const url = linkOf(text);
    if (!url) return void showToast({ message: "Enter a link that starts with https://", kind: "error" });
    if (own.length >= DEV_RESOURCE_LIMIT) return void showToast({ message: "You can add up to 10 links to a layer.", kind: "error" });
    if (own.some((r) => r.url === url)) return void showToast({ message: "This link has already been added.", kind: "error" });
    onAdding(false);
    const name = (await dev.linkTitle?.(url).catch(() => null)) || fallbackName(url);
    try {
      const r = await dev.addDevResource!(id, { name, url });
      setOwn((list) => [...list.filter((x) => x.id !== r.id), r]);
    } catch (e) {
      showToast({ message: errorText(e), kind: "error" });
    }
  };
  const open = (url: string) => (dev.openUrl ? dev.openUrl(url) : void window.open(url, "_blank", "noopener"));

  return (
    <PanelSection title="Dev resources" empty={!own.length && !inherited.length && !adding} actions={canEdit ? <IconButton icon="24.plus.small" label="Add a dev resource link" onClick={() => onAdding(true)} /> : undefined} data-dev-resources="">
      {own.map((r) =>
        editing === r.id ? (
          <ResourceEditor
            key={r.id}
            record={r}
            onDone={async (patch) => {
              setEditing(null);
              if (!patch) return;
              try {
                const next = await dev.editDevResource!(r.id, patch);
                setOwn((list) => list.map((x) => (x.id === r.id ? next : x)));
              } catch (e) {
                showToast({ message: errorText(e), kind: "error" });
              }
            }}
          />
        ) : (
          <ResourceRow
            key={r.id}
            record={r}
            onOpen={() => open(r.url)}
            menu={
              canEdit
                ? (action) => {
                    if (action === "edit") setEditing(r.id);
                    else
                      void dev.removeDevResource!(r.id).then(
                        () => setOwn((list) => list.filter((x) => x.id !== r.id)),
                        (e: unknown) => showToast({ message: errorText(e), kind: "error" })
                      );
                  }
                : null
            }
          />
        )
      )}
      {inherited.map((r) => (
        <ResourceRow key={r.id} record={r} onOpen={() => open(r.url)} menu={null} inherited />
      ))}
      {adding && (
        <div className={styles.resourceField}>
          <TextInput label="Dev resource link" value="" placeholder="Paste a link" autoFocus onCommit={(v) => void add(v)} onExit={(r) => r === "escape" && onAdding(false)} data-dev-resource-field="" />
        </div>
      )}
    </PanelSection>
  );
}

function ResourceRow({ record, onOpen, menu, inherited }: { record: DevResourceRecord; onOpen: () => void; menu: ((action: "edit" | "delete") => void) | null; inherited?: boolean }) {
  return (
    <div className={styles.resourceRow} data-dev-resource={record.id}>
      <button type="button" className={styles.resourceLink} onClick={onOpen} title={record.url}>
        <Glyph url={record.url} />
        <span className={styles.assetName}>{record.name}</span>
        {inherited && <span className={styles.resourceFrom}>Main component</span>}
      </button>
      {menu && (
        <MenuButton
          label="More options"
          entries={[
            { id: "edit", label: "Edit" },
            { id: "delete", label: "Delete link" },
          ]}
          onSelect={(a) => menu(a as "edit" | "delete")}
        >
          <Icon name="24.more" />
        </MenuButton>
      )}
    </div>
  );
}

function ResourceEditor({ record, onDone }: { record: DevResourceRecord; onDone: (patch: { name?: string; url?: string } | null) => void }) {
  const [name, setName] = useState(record.name);
  const [url, setUrl] = useState(record.url);
  const save = () => {
    const link = linkOf(url);
    if (!link) return void showToast({ message: "Enter a link that starts with https://", kind: "error" });
    const patch: { name?: string; url?: string } = {};
    if (name.trim() !== record.name) patch.name = name.trim();
    if (link !== record.url) patch.url = link;
    onDone(Object.keys(patch).length ? patch : null);
  };
  return (
    <div className={styles.resourceEditor} data-dev-resource-editor="">
      <TextInput label="Name" value={name} autoFocus onChange={setName} onExit={(r) => (r === "escape" ? onDone(null) : r === "enter" ? save() : undefined)} />
      <TextInput label="Link" value={url} onChange={setUrl} onExit={(r) => (r === "escape" ? onDone(null) : r === "enter" ? save() : undefined)} />
    </div>
  );
}
