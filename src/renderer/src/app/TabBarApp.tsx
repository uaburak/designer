import { useCallback, useEffect, useMemo, useState } from "react";
import type { TabsSnapshot, UpdaterStatus, WindowState } from "@shared/ipc";
import { TabBar, TabBarUpdate, useThemeRoot, type TabBarUpdateState } from "@/ds";
import { desktopAs } from "./native";
import { t, useLocale } from "@/i18n";

/**
 * The tab bar's own view (`?tabbar`, 38px at the window's top): the design
 * system's TabBar (docs/design-system.md §4.23) over the tabs as main keeps
 * them (`tabs:state`); every click is a message to main. Its menus are
 * native (main's), since nothing it draws may leave its 38px.
 */
export default function TabBarApp() {
  useThemeRoot();
  const locale = useLocale();
  const api = desktopAs.tabbar();
  const [snapshot, setSnapshot] = useState<TabsSnapshot | null>(null);
  const [win, setWin] = useState<WindowState>({ fullScreen: false, focused: true });
  const [update, setUpdate] = useState<UpdaterStatus | null>(null);

  useEffect(() => {
    if (!api) return;
    let live = true;
    void api.tabs.get().then((s) => live && setSnapshot(s));
    const offState = api.tabs.onState(setSnapshot);
    const offWin = api.onWindowState(setWin);
    void api.updates.get().then((s) => live && setUpdate(s));
    const offUpdate = api.updates.onState(setUpdate);
    return () => {
      live = false;
      offState();
      offWin();
      offUpdate();
    };
  }, [api]);

  // Painted once: main may show the window.
  const hasSnapshot = snapshot !== null;
  useEffect(() => {
    if (api && hasSnapshot) requestAnimationFrame(() => api.ready());
  }, [api, hasSnapshot]);

  const tabs = useMemo(
    () =>
      (snapshot?.tabs ?? [])
        .filter((tab) => tab.kind !== "home")
        .map((tab) => ({ id: tab.id, kind: tab.kind === "prototype" ? ("prototype" as const) : ("design" as const), title: tab.status === "crashed" ? t("{title} — crashed", { title: tab.title }) : tab.status === "unresponsive" ? t("{title} — not responding", { title: tab.title }) : tab.title })),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the titles follow the language
    [snapshot, locale]
  );

  const onActivate = useCallback((id: string) => api?.tabs.activate(id), [api]);
  const onClose = useCallback((id: string) => api?.tabs.close(id), [api]);
  // The bar counts the file tabs from 0; main counts Home as 0.
  const onMove = useCallback((id: string, to: number) => api?.tabs.move(id, to + 1), [api]);
  const onNew = useCallback(() => api?.tabs.newFile(), [api]);
  const onContextMenu = useCallback((id: string, at: { x: number; y: number }) => api?.tabs.contextMenu(id, at.x, at.y), [api]);
  const onMainMenu = useCallback((at: { x: number; y: number }) => api?.tabs.mainMenu(at.x, at.y), [api]);
  const windows = api?.platform === "win32";
  const onRestart = useCallback(() => api?.updates.restart(), [api]);
  const notice = updateNotice(update);

  // In a browser (no main): an empty bar, to look at.
  return <TabBar tabs={tabs} active={snapshot?.activeTabId ?? "home"} fullScreen={Boolean(snapshot?.fullScreen || win.fullScreen)} onActivate={onActivate} onClose={onClose} onMove={onMove} onNew={onNew} onContextMenu={onContextMenu} windows={windows} onMainMenu={onMainMenu} notice={notice && <TabBarUpdate state={notice} onRestart={onRestart} />} />;
}

/** What the tab bar shows of the updater (docs/desktop.md §12.6): "Restart to update" once an update is in; a manual check's progress; nothing for the daily check. */
export function updateNotice(s: UpdaterStatus | null): TabBarUpdateState | null {
  if (!s?.enabled) return null;
  if (s.state.kind === "ready") return { kind: "ready", version: s.state.version };
  if (!s.manual) return null;
  if (s.state.kind === "checking") return { kind: "checking" };
  if (s.state.kind === "downloading") return { kind: "downloading", percent: s.state.percent };
  return null;
}
