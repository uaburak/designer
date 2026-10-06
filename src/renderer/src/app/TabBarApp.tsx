import { useCallback, useEffect, useMemo, useState } from "react";
import type { TabsSnapshot, WindowState } from "@shared/ipc";
import { TABBAR_HEIGHT, TRAFFIC_LIGHT_ROOM } from "@shared/layout";
import { ThemeProvider } from "@/context/ThemeContext";
import { desktopAs, isMac } from "./native";
import { TabBar } from "./TabBar";

/**
 * The tab bar's own view (`?tabbar`, 38px at the window's top): the tabs as
 * main keeps them (`tabs:state`), and every click a message to main. Its
 * menus are native (main's), since nothing it draws may leave its 38px.
 */

// The measured bar (docs/research/visual-diff.md): 38px with a 1px line at the bottom; #3b3b3b dark.
// The line runs under the bar's free room and the tabs behind; the tab in front covers it (it opens onto its page).
const LOOK = `
:root { --tabbar-height: ${TABBAR_HEIGHT}px; --tabbar-line: #d9d9d9; }
[data-theme="dark"] { --tabbar-bg: #3b3b3b; --tabbar-hover: #444444; --tabbar-divider: #4f4f4f; --tabbar-line: #4a4a4a; }
html, body, #root { background: var(--tabbar-bg) !important; }
[role="tablist"], #root > .app-drag { box-shadow: inset 0 -1px 0 var(--tabbar-line); }
`;

export default function TabBarApp() {
  return (
    <ThemeProvider>
      <style>{LOOK}</style>
      <Bar />
    </ThemeProvider>
  );
}

function Bar() {
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

  const fullScreen = snapshot?.fullScreen || win.fullScreen;
  // In full screen the traffic lights are gone: a little room stays (docs/design-system.md §4.23).
  const room = isMac && !fullScreen ? TRAFFIC_LIGHT_ROOM : 8;
  const tabs = useMemo(() => (snapshot ? snapshot.tabs.filter((t) => t.kind !== "home") : []), [snapshot]);

  const onActivate = useCallback((id: string) => api?.tabs.activate(id), [api]);
  const onClose = useCallback((id: string) => api?.tabs.close(id), [api]);
  // The bar counts the file tabs from 0; main counts Home as 0.
  const onMove = useCallback((id: string, to: number) => api?.tabs.move(id, to + 1), [api]);
  const onNew = useCallback(() => api?.tabs.newFile(), [api]);
  const onTabMenu = useCallback((id: string, e: React.MouseEvent) => api?.tabs.contextMenu(id, e.clientX, e.clientY), [api]);

  if (!snapshot) return <div className="app-drag h-full" />;
  // Signed out (Home shows the sign-in): the bar only moves the window.
  if (!snapshot.signedIn) return <div className="app-drag h-full" />;
  return <TabBar tabs={tabs} room={room} active={snapshot.activeTabId} onActivate={onActivate} onClose={onClose} onMove={onMove} onNew={onNew} onTabMenu={onTabMenu} />;
}
