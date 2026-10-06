import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import type { User } from "firebase/auth";
import { ContextMenu, keys, type MenuEntry } from "@/components/admin/ContextMenu";
import { signOutUser } from "@/lib/auth";
import { SITE_URL } from "@/lib/siteConfig";
import { cn } from "@/lib/utils";
import { Home } from "@/home/Home";
import { NewProjectDialog } from "@/home/dialogs";
import { rememberOpened } from "@/home/prefs";
import type { TabBridge } from "./bridge";
import { TabBar } from "./TabBar";
import { forgetTabs, HOME, keepTabs, restoredTabs, tabsReducer, type Tab } from "./tabs";
import { Button, Modal } from "./ui";

/**
 * The browser's shell (`npm run web`; the desktop app's tabs are views of
 * their own, kept by main — src/main/tabs.ts): the tab bar over Home and the
 * open files. Each file is a page of its own in a frame (`?tab=…`, see tab/TabApp) — its keys, clipboard and
 * listeners stay its own, its unsaved work lives in it while it is behind
 * another. The shell asks before anything unsaved goes: a tab closed, the
 * window closed, signing out.
 */

type Question =
  | { kind: "close-tab"; title: string }
  | { kind: "unsaved"; titles: string[]; action: "close" | "sign-out" };
type Answer = "save" | "discard" | "cancel";

/** A tab's page URL: this page as the tab (see main.tsx). */
const frameUrl = (tab: Tab) => {
  const url = new URL(window.location.href);
  url.hash = "";
  url.search = new URLSearchParams({ tab: tab.id, kind: tab.kind, slug: tab.slug }).toString();
  return url.toString();
};

export function Shell({ user }: { user: User }) {
  const [state, dispatch] = useReducer(tabsReducer, undefined, restoredTabs);
  const frames = useRef(new Map<string, HTMLIFrameElement>());
  const homeRef = useRef<HTMLDivElement>(null);
  const [question, setQuestion] = useState<(Question & { resolve: (answer: Answer) => void }) | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; entries: MenuEntry[] } | null>(null);
  const [creating, setCreating] = useState(false);
  /** The last save in a tab: the home's lists are read again */
  const [savedAt, setSavedAt] = useState(0);

  const latest = useRef(state);
  useLayoutEffect(() => {
    latest.current = state;
  });
  useEffect(() => keepTabs(state), [state]);

  const tabBridge = useCallback((id: string): TabBridge | undefined => {
    try {
      return frames.current.get(id)?.contentWindow?.designerTab;
    } catch {
      return undefined;
    }
  }, []);

  const ask = useCallback((q: Question) => new Promise<Answer>((resolve) => setQuestion({ ...q, resolve })), []);
  const answer = (a: Answer) => {
    question?.resolve(a);
    setQuestion(null);
  };

  const activate = useCallback((id: string) => dispatch({ type: "activate", id }), []);

  const openProject = useCallback((slug: string, title?: string) => {
    rememberOpened(slug);
    dispatch({ type: "open", kind: "project", slug, title });
  }, []);

  const openCv = useCallback(() => dispatch({ type: "open", kind: "cv", slug: "cv", title: "CV" }), []);

  /** Tabs closed — an unsaved one asks first (Save, Don't save, Cancel): false when the user kept it. */
  const closeTabs = useCallback(async (ids: string[]) => {
    for (const id of ids) {
      const tab = latest.current.tabs.find((t) => t.id === id);
      if (!tab) continue;
      const bridge = tabBridge(id);
      if (bridge?.isDirty()) {
        dispatch({ type: "activate", id });
        const a = await ask({ kind: "close-tab", title: tab.title });
        if (a === "cancel") return false;
        if (a === "save" && !(await bridge.save())) return false;
      }
      dispatch({ type: "close", ids: [id] });
    }
    return true;
  }, [ask, tabBridge]);

  /** Before the window closes or the account signs out: every unsaved tab saved, or let go — false when the user stayed. */
  const settleAll = useCallback(async (action: "sign-out") => {
    const dirty = latest.current.tabs.filter((t) => tabBridge(t.id)?.isDirty());
    if (!dirty.length) return true;
    const a = await ask({ kind: "unsaved", titles: dirty.map((t) => t.title), action });
    if (a === "cancel") return false;
    if (a === "save") {
      for (const tab of dirty) {
        if (!(await tabBridge(tab.id)?.save())) {
          dispatch({ type: "activate", id: tab.id });
          return false;
        }
      }
    }
    return true;
  }, [ask, tabBridge]);

  const signOut = useCallback(async () => {
    if (!(await settleAll("sign-out"))) return;
    forgetTabs();
    dispatch({ type: "reset" });
    await signOutUser();
  }, [settleAll]);

  // ── What the tabs ask (see bridge.ts) ──
  const actions = useRef({ openProject, closeTabs, signOut });
  useLayoutEffect(() => {
    actions.current = { openProject, closeTabs, signOut };
  });
  useEffect(() => {
    window.designerShell = {
      report: (id, report) => {
        dispatch({ type: "report", id, report });
        if (report.savedAt) setSavedAt(report.savedAt);
      },
      openProject: (slug) => actions.current.openProject(slug),
      openPreview: (slug) => dispatch({ type: "open", kind: "preview", slug, title: `${slug} — Preview` }),
      goHome: () => dispatch({ type: "activate", id: HOME }),
      closeTab: (id) => void actions.current.closeTabs([id]),
      signOut: () => void actions.current.signOut(),
    };
    return () => {
      delete window.designerShell;
    };
  }, []);

  // ── Closing the page: its own question when a tab holds unsaved work ──
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (!latest.current.tabs.some((t) => t.dirty)) return;
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, []);

  // The one in front takes the keys.
  useEffect(() => {
    if (state.active === HOME) homeRef.current?.focus({ preventScroll: true });
    else {
      const frame = frames.current.get(state.active);
      frame?.focus();
      frame?.contentWindow?.focus();
    }
  }, [state.active]);

  const tabMenu = useCallback((id: string, e: React.MouseEvent) => {
    const { tabs } = latest.current;
    const at = tabs.findIndex((t) => t.id === id);
    const tab = tabs[at];
    if (!tab) return;
    setMenu({
      x: e.clientX,
      y: e.clientY,
      entries: [
        { label: "Close tab", shortcut: keys("mod", "w"), onSelect: () => void closeTabs([id]) },
        { label: "Close other tabs", disabled: tabs.length < 2, onSelect: () => void closeTabs(tabs.filter((t) => t.id !== id).map((t) => t.id)) },
        { label: "Close tabs to the right", disabled: at === tabs.length - 1, onSelect: () => void closeTabs(tabs.slice(at + 1).map((t) => t.id)) },
        "-",
        { label: "Reopen closed tab", shortcut: keys("shift", "mod", "t"), disabled: !latest.current.closed.length, onSelect: () => dispatch({ type: "reopen" }) },
        "-",
        { label: "Copy link to the site page", onSelect: () => void navigator.clipboard?.writeText(tab.kind === "cv" ? `${SITE_URL}/cv` : `${SITE_URL}/projects/${tab.slug}`) },
      ],
    });
  }, [closeTabs]);

  const onMove = useCallback((id: string, to: number) => dispatch({ type: "move", id, to }), []);
  const onClose = useCallback((id: string) => void closeTabs([id]), [closeTabs]);
  const onNew = useCallback(() => {
    dispatch({ type: "activate", id: HOME });
    setCreating(true);
  }, []);
  const openTabs = useMemo(() => new Set(state.tabs.filter((t) => t.kind === "project").map((t) => t.slug)), [state.tabs]);

  return (
    <div className="flex flex-col h-full bg-[var(--f-bg)] text-[var(--f-text)]">
      <TabBar tabs={state.tabs} room={8} active={state.active} onActivate={activate} onClose={onClose} onMove={onMove} onNew={onNew} onTabMenu={tabMenu} />
      <div className="relative flex-1 min-h-0">
        <div ref={homeRef} tabIndex={-1} className={cn("absolute inset-0 outline-none", state.active !== HOME && "invisible pointer-events-none")} aria-hidden={state.active !== HOME}>
          <Home user={user} visible={state.active === HOME} openTabs={openTabs} savedAt={savedAt} onOpen={openProject} onOpenCv={openCv} onNewProject={() => setCreating(true)} onSignOut={() => void signOut()} />
        </div>
        {state.tabs.map((tab) => (
          <iframe
            key={tab.id}
            ref={(el) => {
              if (el) frames.current.set(tab.id, el);
              else frames.current.delete(tab.id);
            }}
            title={tab.title}
            src={frameUrl(tab)}
            // Kept laid out while behind another tab (its canvas keeps its size and view); only the one in front is seen and takes the pointer.
            className={cn("absolute inset-0 w-full h-full border-0 bg-[var(--f-bg)]", tab.id !== state.active && "invisible pointer-events-none")}
          />
        ))}
      </div>

      {creating && (
        <NewProjectDialog
          onClose={() => setCreating(false)}
          onCreated={(slug, title) => {
            setCreating(false);
            setSavedAt(Date.now());
            openProject(slug, title);
          }}
        />
      )}

      {question?.kind === "close-tab" && (
        <Modal
          title="Unsaved changes"
          onClose={() => answer("cancel")}
          footer={
            <>
              <Button onClick={() => answer("discard")} className="mr-auto">Don’t save</Button>
              <Button onClick={() => answer("cancel")}>Cancel</Button>
              <Button kind="primary" autoFocus onClick={() => answer("save")}>Save</Button>
            </>
          }
        >
          <p>
            Save the changes to <strong className="font-[600]">“{question.title}”</strong> before closing it?
          </p>
          <p className="text-[var(--f-text-secondary)]">They’re lost if you don’t save them. Saving writes the draft — the site changes only when you publish.</p>
        </Modal>
      )}
      {question?.kind === "unsaved" && (
        <Modal
          title="Unsaved changes"
          onClose={() => answer("cancel")}
          footer={
            <>
              <Button onClick={() => answer("discard")} className="mr-auto">{question.action === "close" ? "Close without saving" : "Sign out without saving"}</Button>
              <Button onClick={() => answer("cancel")}>Cancel</Button>
              <Button kind="primary" autoFocus onClick={() => answer("save")}>Save all</Button>
            </>
          }
        >
          <p>{question.titles.length === 1 ? "This file has" : `These ${question.titles.length} files have`} unsaved changes:</p>
          <ul className="flex flex-col gap-1 pl-4 list-disc">
            {question.titles.map((t, i) => (
              <li key={i} className="font-[500]">{t}</li>
            ))}
          </ul>
        </Modal>
      )}

      {menu && <ContextMenu at={menu} entries={menu.entries} onClose={() => setMenu(null)} />}
    </div>
  );
}
