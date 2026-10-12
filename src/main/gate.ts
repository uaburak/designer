import { app } from "electron";
import { loadSession, onSessionChanged, sessionKnown, sessionToStore, setSignOutGuard, signedIn } from "./account";
import { loginBypassed, OpenQueue } from "./gateRules";
import { setMenuSignedOut } from "./menu";
import { WelcomeWindow } from "./welcome";
import { controllers, openWindow, savedBounds, type WindowController } from "./window";

/**
 * The login gate (docs/desktop.md §18.6): signed out, the whole app is the welcome window — no tab bar, no Home, no
 * files. At launch the kept session is read first (the keychain may ask) with the welcome window's splash meanwhile,
 * so someone signed in never sees the welcome page; offline with a kept session the app opens as usual. A sign-in
 * opens the app window where the welcome window was, then closes it; Log out (or a session the server refuses, or the
 * idle timeout) flushes every open file and the store, closes the app window — its file tabs not kept — and shows the
 * welcome page. Shared-file links and .fig files opened from the Finder wait for the next sign-in (`whenOpen`); the
 * menu bar's file commands are off; the store refuses to create or open files without a session (src/store/server.ts).
 * Off for development and tests (gateRules.ts `loginBypassed`).
 */

export const bypassed = (): boolean => loginBypassed(process.env);

/** The app (tab bar, Home, files) may be used: signed in, or the gate is off */
export const appOpen = (): boolean => bypassed() || (sessionKnown() && signedIn());

let welcome: WelcomeWindow | null = null;
let opening = false;
const queue = new OpenQueue(() => appOpen() && controllers.size > 0 && !opening);

const current = (): WindowController | null => [...controllers.values()][0] ?? null;

/** Run now in the app window when it's open, else after the next sign-in (`key`: the same link once). */
export function whenOpen(key: string, run: (ctl: WindowController) => void): "ran" | "queued" {
  return queue.add(key, () => {
    const ctl = current();
    if (ctl) run(ctl);
  });
}

/** The welcome view painted: its window shows. */
export function welcomeReady(): void {
  welcome?.show();
}

function showWelcome(bounds = savedBounds()): WelcomeWindow {
  if (welcome) return welcome;
  const w = new WelcomeWindow(bounds, () => {
    if (welcome === w) welcome = null;
  });
  welcome = w;
  return w;
}

/** Wired once at launch (before the first window). */
export function initGate(): void {
  if (bypassed()) return;
  setMenuSignedOut(true);
  // Log out: every file settled first (a failed save asks; Cancel keeps the person signed in).
  setSignOutGuard(async () => {
    for (const ctl of [...controllers.values()]) if (!(await ctl.tabs.settleAll("close"))) return false;
    return true;
  });
  onSessionChanged(() => void reconcile());
}

/** At launch, on the Dock's click with no window, on a second launch: the app window, or the welcome window. */
export function openMain(): void {
  const ctl = current();
  if (ctl) {
    if (ctl.win.isMinimized()) ctl.win.restore();
    ctl.win.focus();
    return;
  }
  if (bypassed()) return void openWindow();
  if (welcome) return welcome.focus();
  if (sessionKnown() && signedIn()) return void openApp(savedBounds());
  // Not known yet (the keychain), or signed out: the welcome window — its splash until the session is known.
  showWelcome();
  void loadSession().then(() => reconcile());
}

/** The app window, once the store has the session (it refuses files without one); the welcome window closes when it shows. */
async function openApp(bounds: ReturnType<typeof savedBounds>): Promise<void> {
  if (opening || current()) return;
  opening = true;
  try {
    await sessionToStore();
    if (!appOpen()) return;
    const ctl = openWindow(bounds);
    setMenuSignedOut(false);
    await ctl.whenShown();
    welcome?.close();
    welcome = null;
    app.focus({ steal: true });
  } finally {
    opening = false;
  }
  queue.flush();
}

/** The session changed (or became known): the window that matches. */
async function reconcile(): Promise<void> {
  if (bypassed() || !sessionKnown()) return;
  if (signedIn()) {
    // Signed in from the welcome window: the app takes its place. No window at all (closed on a Mac): nothing opens.
    if (!current() && welcome) await openApp(welcome.placement());
    else if (current()) {
      setMenuSignedOut(false);
      queue.flush();
    }
    return;
  }
  setMenuSignedOut(true);
  const open = [...controllers.values()];
  if (!open.length) return;
  // The welcome window first (where the app window is), then the app window closes: never no window mid-swap.
  showWelcome(open[0].placement());
  await Promise.all(open.map((c) => c.closeForSignOut()));
}
