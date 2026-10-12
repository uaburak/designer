/**
 * `?welcome`: the signed-out window's view (docs/desktop.md §18.6) — the splash, then the welcome page, on the
 * preload's account. The window shows once it has painted (`ready`).
 */
import "@/ds/global.css";
import { useEffect } from "react";
import { TooltipManager, useThemeRoot } from "@/ds";
import type { WelcomeApi } from "@shared/desktop";
import { WelcomeScreen } from "./Welcome";

const api = (): WelcomeApi | null => (window as unknown as { designer?: WelcomeApi }).designer ?? null;

export default function WelcomeApp() {
  useThemeRoot();
  const desktop = api();
  useEffect(() => {
    requestAnimationFrame(() => desktop?.ready());
  }, [desktop]);
  if (!desktop) return null;
  return (
    <>
      <WelcomeScreen account={desktop.account} version={desktop.version} />
      <TooltipManager />
    </>
  );
}
