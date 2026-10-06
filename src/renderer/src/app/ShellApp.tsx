import { ThemeProvider } from "@/context/ThemeContext";
import { AuthGate } from "./AuthGate";
import { Shell } from "./Shell";

/**
 * The browser's page (`npm run web`): signed in with the site's admin
 * account, the shell (the tab bar, Home, the open files in frames); else the
 * sign-in. In the desktop app the same gate is Home's (app/HomeApp.tsx) —
 * the tab bar is a view of its own there.
 */
export default function ShellApp() {
  return (
    <ThemeProvider>
      <AuthGate dragStrip>{(user) => <Shell user={user} />}</AuthGate>
    </ThemeProvider>
  );
}
