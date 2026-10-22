import { Button } from "@/ds";
import { t as tr, useT } from "@/i18n";
import { useIsOperator } from "../settings/useIsOperator";
import { openDeveloper } from "./desktop";

/** Whether Home shows the Developer button: in a development build (not under tests) or to the server's operators. */
export const showDeveloper = (operator: boolean, env: { DEV: boolean; MODE: string } = import.meta.env) => operator || (env.DEV && env.MODE !== "test");

/**
 * Home's Developer button, before Design (ours, the owner's 2026-10-22 ask): the design system's gallery with every
 * component and hand-made control as the app uses it, in a Developer tab — for reviewing them on one screen.
 */
export function DeveloperButton() {
  useT();
  // A development build shows it without asking the server; tests never do (Home's headers stay as Figma's)
  const dev = showDeveloper(false);
  const operator = useIsOperator(!dev && import.meta.env.MODE !== "test");
  if (!dev && !operator) return null;
  return (
    <Button variant="tinted" size="large" icon="24.mode.dev" tooltip={tr("Every component and control as the app uses it")} onClick={() => openDeveloper()} data-home-developer="">
      {tr("Developer")}
    </Button>
  );
}
