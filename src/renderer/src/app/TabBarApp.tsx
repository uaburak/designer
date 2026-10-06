import { useCallback, useEffect, useMemo, useState } from "react";
import type { TabsSnapshot, WindowState } from "@shared/ipc";
import { TabBar, useThemeRoot } from "@/ds";
import { desktopAs } from "./native";

/**
 * The tab bar's own view (`?tabbar`, 38px at the window's top): the design
 * system's TabBar (docs/design-system.md §4.23) over the tabs as main keeps
 * them (`tabs:state`); every click is a message to main. Its menus are
 * native (main's), since nothing it draws may leave its 38px.
 */
export default function TabBarApp() {
  useThemeRoot();
  const api = desktopAs.tabbar();
  const [snapshot, setSnapshot] = useState<TabsSnapshot | null>(null);
  const [win, setWin] = useState<WindowState>({ fullScreen: false, focused: true });

  useEffect(() => {
    if (!api) return;
    let live = true;
    void api.tabs.get().then((s) => live && setSnapshot(s));
    const offState = api.tabs.onState(setSnapshot);
    const offWin = api.onWindowState(setWin);
    return () => {
      live = false;
      offState();
      offWin();
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
        .filter((t) => t.kind !== "home")
        .map((t) => ({ id: t.id, kind: "design" as const, title: t.status === "crashed" ? `${t.title} — crashed` : t.status === "unresponsive" ? `${t.title} — not responding` : t.title })),
    [snapshot]
  );

  const onActivate = useCallback((id: string) => api?.tabs.activate(id), [api]);
  const onClose = useCallback((id: string) => api?.tabs.close(id), [api]);
  // The bar counts the file tabs from 0; main counts Home as 0.
  const onMove = useCallback((id: string, to: number) => api?.tabs.move(id, to + 1), [api]);
  const onNew = useCallback(() => api?.tabs.newFile(), [api]);
  const onContextMenu = useCallback((id: string, at: { x: number; y: number }) => api?.tabs.contextMenu(id, at.x, at.y), [api]);

  // In a browser (no main): an empty bar, to look at.
  return <TabBar tabs={tabs} active={snapshot?.activeTabId ?? "home"} fullScreen={Boolean(snapshot?.fullScreen || win.fullScreen)} onActivate={onActivate} onClose={onClose} onMove={onMove} onNew={onNew} onContextMenu={onContextMenu} />;
}
