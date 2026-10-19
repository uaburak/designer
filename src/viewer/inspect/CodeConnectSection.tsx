/**
 * Inspect's Code Connect snippets (docs/editor.md D-1): for an instance or main component with mappings, one tab per
 * label (Figma's language selector) above the generated code; the snippet with nested connected instances inline or as
 * pills (a click selects the instance), "‹component› · ‹source›" (a link opens the browser), Figma's error names in a
 * quiet block, and "Generated from properties" under a Code Connect UI mapping. Without a mapping, editors get
 * "Connect components" (the Code Connect UI); a component gets "Explore component behavior" (the playground, D-2) —
 * under Figma's "Not started" chip and its hint, which any other layer shows too (the owner's capture owner-2026-10-18).
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Button, IconButton, PanelSection, Tabs, showToast } from "@/ds";
import type { ComponentInfo, Guid } from "@/engine/codec";
import { useViewer, type DevData } from "../context";
import { t, useT } from "@/i18n";
import { codeConnectSnippets, sourceUrl, targetOf, type ViewSnippet } from "./codeConnect";
import styles from "../Viewer.module.css";

const LABEL_KEY = "designer-viewer-code-connect-label";

function storedLabel(): string | null {
  try {
    return localStorage.getItem(LABEL_KEY);
  } catch {
    return null;
  }
}

/** The snippets of a layer (re-read when the file's mappings change). */
export function useSnippets(id: Guid): { snippets: ViewSnippet[]; loading: boolean } {
  const { engine, host } = useViewer();
  const dev = host?.dev ?? null;
  const [state, setState] = useState<{ id: Guid; snippets: ViewSnippet[]; loading: boolean }>({ id, snippets: [], loading: !!dev });
  const [version, setVersion] = useState(0);
  useEffect(() => (dev ? dev.watch((what) => what === "codeConnect" && setVersion((v) => v + 1)) : undefined), [dev]);
  useEffect(() => {
    if (!dev) return;
    let live = true;
    codeConnectSnippets(engine, id, dev.codeConnect).then(
      (snippets) => live && setState({ id, snippets, loading: false }),
      () => live && setState({ id, snippets: [], loading: false })
    );
    return () => {
      live = false;
    };
  }, [engine, dev, id, version]);
  return state.id === id ? state : { snippets: [], loading: true };
}

export function CodeConnectSection({ id, info }: { id: Guid; info: ComponentInfo | null }) {
  const { engine, host } = useViewer();
  const dev = host?.dev ?? null;
  const { snippets, loading } = useSnippets(id);
  const [label, setLabel] = useState<string | null>(storedLabel);
  const connectable = !!info && (info.kind === "INSTANCE" || info.kind === "NESTED_INSTANCE" || info.kind === "COMPONENT" || info.kind === "VARIANT" || info.kind === "COMPONENT_SET");
  const target = useMemo(() => targetOf(info, dev?.fileKey ?? null), [info, dev]);
  // The editor without the store's Dev Mode data (a file of no account): the section as Figma shows it, nothing to map.
  if (!dev) return host ? <NotStarted dev={null} /> : null;
  // Nothing mapped (Figma's Dev Mode, the owner's capture): "Code Connect" with its status chip "Not started", how to
  // start, and for a component its actions.
  if (!connectable) return <NotStarted dev={dev} />;
  const choose = (l: string) => {
    setLabel(l);
    try {
      localStorage.setItem(LABEL_KEY, l);
    } catch {
      // this visit only
    }
  };
  const playground = dev.onPlayground && info && info.kind !== "COMPONENT_SET" ? (
    <Button variant="secondary" onClick={() => dev.onPlayground!(id)} data-playground="">
      Explore component behavior
    </Button>
  ) : null;
  if (!snippets.length) {
    // Inspect › Connect components: the selection's unmapped component, in the Code Connect UI (its own file only).
    const own = target && target.fileKey === dev.fileKey;
    const connect = !loading && dev.canEdit && dev.onConnectComponents && own ? (
      <Button variant="secondary" onClick={() => dev.onConnectComponents!(target!.nodeIds.slice(-1))} data-connect-components="">
        Connect components
      </Button>
    ) : null;
    return (
      <NotStarted dev={dev}>
        {(connect || playground) && (
          <div className={styles.connectActions}>
            {playground}
            {connect}
          </div>
        )}
      </NotStarted>
    );
  }
  const current = snippets.find((s) => s.label === label) ?? snippets[0];
  const url = sourceUrl(current.source);
  return (
    <PanelSection title="Code Connect" actions={!current.error ? <IconButton icon="24.copy.small" label="Copy" onClick={() => void navigator.clipboard?.writeText(current.code).then(() => showToast({ message: "Copied to clipboard" }))} /> : undefined} data-code-connect="">
      {snippets.length > 1 && <Tabs className={styles.connectTabs} label="Code Connect languages" value={current.label} tabs={snippets.map((s) => ({ value: s.label, label: s.label }))} onChange={choose} />}
      {(current.component || current.source) && (
        <div className={styles.connectSource} data-connect-source="">
          {current.component && <span>{current.component}</span>}
          {current.component && current.source && <span>·</span>}
          {current.source &&
            (url ? (
              <a
                href={url}
                onClick={(e) => {
                  e.preventDefault();
                  if (dev.openUrl) dev.openUrl(url);
                  else window.open(url, "_blank", "noopener");
                }}
              >
                {current.source}
              </a>
            ) : (
              <span>{current.source}</span>
            ))}
        </div>
      )}
      {current.error ? (
        <div className={styles.connectError} data-connect-error={current.error.type}>
          <div className={styles.connectErrorName}>{current.error.type}</div>
          <div>{current.error.message}</div>
        </div>
      ) : (
        <pre className={styles.connectCode} data-language={current.language} data-connect-snippet={current.label}>
          {current.segments.map((s, i) =>
            "text" in s ? (
              <span key={i}>{s.text}</span>
            ) : "pill" in s ? (
              <button
                key={i}
                type="button"
                className={styles.connectPill}
                data-connect-pill={s.nodeId}
                onClick={() => {
                  engine.setSelection([s.nodeId]);
                }}
              >
                {s.pill}
              </button>
            ) : (
              <span key={i} className={styles.connectErrorName}>
                {s.error}
              </span>
            )
          )}
        </pre>
      )}
      {current.origin === "ui" && <div className={styles.hint}>Generated from properties</div>}
      {playground && <div className={styles.connectActions}>{playground}</div>}
    </PanelSection>
  );
}

/** Figma's Code Connect help, "Learn more" in the section (its status "Not started"). */
const CODE_CONNECT_HELP = "https://help.figma.com/hc/en-us/articles/23920389749655-Code-Connect";

/** "Code Connect" before anything is mapped: the status chip "Not started", how to start, and `children` (its actions). */
function NotStarted({ dev, children }: { dev: DevData | null; children?: ReactNode }) {
  useT();
  return (
    <PanelSection title={t("Code Connect")} actions={<span className={styles.connectStatus}>{t("Not started")}</span>} data-code-connect="not-started">
      <div className={styles.connectHint}>
        {t("Publish components to a library, then you can connect them to your codebase with Code Connect.")}{" "}
        <a
          href={CODE_CONNECT_HELP}
          className={styles.devLink}
          onClick={(e) => {
            e.preventDefault();
            if (dev?.openUrl) dev.openUrl(CODE_CONNECT_HELP);
            else window.open(CODE_CONNECT_HELP, "_blank", "noopener");
          }}
        >
          {t("Learn more")}
        </a>
      </div>
      {children}
    </PanelSection>
  );
}
