import { useEffect, useLayoutEffect, useRef } from "react";
import { DesignSystemProvider } from "@/components/project/designSystem";
import { FigmaEditor } from "@/figma/FigmaEditor";
import { useEditSession } from "@/figma/session";
import { shellBridge } from "@/app/bridge";
import { Button, Spinner } from "@/app/ui";

/**
 * A project open in a tab: Figma, for its page (see FigmaEditor) — the
 * project and the site's design system loaded, edited in memory, written
 * back only with Save (see useEditSession). It tells the shell its name,
 * whether something is unsaved, and when a save went through; the shell
 * asks it to save before it closes.
 */
export function EditorTab({ slug, tabId }: { slug: string; tabId: string }) {
  const session = useEditSession(slug);
  const { status, file, system, meta } = session;
  const title = meta?.title || slug;

  const shell = shellBridge();
  useEffect(() => {
    shell?.report(tabId, { status: status.kind, title, dirty: session.dirty });
    document.title = title;
  }, [shell, tabId, status.kind, title, session.dirty]);
  // A save, a publish: the home's lists are out of date.
  useEffect(() => {
    if (session.saveState.kind === "saved") shell?.report(tabId, { savedAt: Date.now() });
  }, [shell, tabId, session.saveState]);
  useEffect(() => {
    if (meta?.publishedAt !== undefined) shell?.report(tabId, { savedAt: Date.now() });
  }, [shell, tabId, meta?.published, meta?.publishedAt]);

  const latest = useRef(session);
  useLayoutEffect(() => {
    latest.current = session;
  });
  useEffect(() => {
    window.designerTab = {
      save: async () => (latest.current.dirty ? latest.current.save() : true),
      isDirty: () => latest.current.dirty,
      command: () => {},
    };
    return () => {
      delete window.designerTab;
    };
  }, []);

  if (status.kind !== "ready" || !file || !system || !meta) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 h-full px-6 text-center bg-[var(--edit-canvas)] text-[var(--f-text)] select-none">
        {status.kind === "loading" && <Spinner />}
        {status.kind === "missing" && (
          <>
            <p className="text-[13px] font-[600] leading-5">There’s no project “{slug}”</p>
            <p className="text-[11px] leading-4 text-[var(--f-text-secondary)]">It was deleted, or its slug changed. Close this tab and pick it again from Home.</p>
            <Button className="mt-3" onClick={() => shell?.closeTab(tabId)}>Close tab</Button>
          </>
        )}
        {status.kind === "error" && (
          <>
            <p className="text-[13px] font-[600] leading-5">Couldn’t open the project</p>
            <p className="max-w-[440px] text-[11px] leading-4 text-[var(--f-text-secondary)]">{status.message}</p>
            <p className="max-w-[440px] text-[11px] leading-4 text-[var(--f-text-secondary)]">Nothing was changed or saved.</p>
            <div className="flex gap-2 mt-3">
              <Button onClick={() => shell?.closeTab(tabId)}>Close tab</Button>
              <Button kind="primary" onClick={() => window.location.reload()}>Try again</Button>
            </div>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <DesignSystemProvider variables={system.variables} textStyles={system.textStyles}>
        <FigmaEditor doc={file} onDoc={session.onDoc} title={meta.title} slug={slug} system={system} session={session} undo={session.undo} redo={session.redo} />
      </DesignSystemProvider>
    </div>
  );
}
