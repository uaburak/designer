import { useCallback, useEffect, useMemo, useState } from "react";
import type { User } from "firebase/auth";
import type { HomeState } from "@shared/ipc";
import { signOutUser } from "@/lib/auth";
import { ThemeProvider, useTheme } from "@/context/ThemeContext";
import { Home } from "@/home/Home";
import { NewProjectDialog } from "@/home/dialogs";
import { rememberOpened } from "@/home/prefs";
import { AuthGate } from "./AuthGate";
import { desktopAs } from "./native";

/**
 * Home's own view (`?home`, under the tab bar): the file browser — and, until
 * the data layer replaces it, the sign-in gate, which tells main whether the
 * site's admin is in (no file tab is shown otherwise). Opening a file asks
 * main for a tab; main says which projects are open and when one was saved.
 */
export default function HomeApp() {
  const api = desktopAs.home();
  const onAdmin = useCallback((admin: boolean) => api?.session.auth(admin), [api]);
  // Painted once: main may show the window.
  useEffect(() => {
    if (api) requestAnimationFrame(() => api.ready());
  }, [api]);
  // Main settled the unsaved tabs (or there were none): sign out now — from the gate too (the menu's Sign Out).
  useEffect(() => api?.session.onSignOut(() => void signOutUser()), [api]);
  return (
    <ThemeProvider>
      <ThemeCommand />
      <AuthGate onAdmin={onAdmin}>{(user) => <SignedIn user={user} />}</AuthGate>
    </ThemeProvider>
  );
}

/**
 * A theme chosen in main (the menu's Theme ▸, the system's appearance) carried
 * over to the site admin's pages, which keep it in localStorage
 * (ThemeContext): Home writes it, every view follows.
 */
function ThemeCommand() {
  const { preference, setPreference } = useTheme();
  useEffect(() => desktopAs.home()?.onThemeChanged((t) => t.preference !== preference && setPreference(t.preference)), [preference, setPreference]);
  return null;
}

function SignedIn({ user }: { user: User }) {
  const api = desktopAs.home();
  const [home, setHome] = useState<HomeState>({ visible: true, openSlugs: [], savedAt: 0 });
  const [creating, setCreating] = useState(false);
  const [createdAt, setCreatedAt] = useState(0);

  useEffect(() => api?.home.onState(setHome), [api]);
  useEffect(
    () =>
      api?.menu.onCommand(({ id }) => {
        if (id === "file.new") setCreating(true);
      }),
    [api]
  );

  const openProject = useCallback(
    (slug: string, title?: string) => {
      rememberOpened(slug);
      void api?.nav.openFile({ kind: "project", slug, title });
    },
    [api]
  );
  const openCv = useCallback(() => void api?.nav.openFile({ kind: "cv", slug: "cv", title: "CV" }), [api]);
  const openTabs = useMemo(() => new Set(home.openSlugs), [home.openSlugs]);

  return (
    <div className="h-full bg-[var(--f-bg)] text-[var(--f-text)]">
      <Home
        user={user}
        visible={home.visible}
        openTabs={openTabs}
        savedAt={Math.max(home.savedAt, createdAt)}
        onOpen={openProject}
        onOpenCv={openCv}
        onNewProject={() => setCreating(true)}
        onSignOut={() => api?.session.requestSignOut()}
      />
      {creating && (
        <NewProjectDialog
          onClose={() => setCreating(false)}
          onCreated={(slug, title) => {
            setCreating(false);
            setCreatedAt(Date.now());
            openProject(slug, title);
          }}
        />
      )}
    </div>
  );
}
