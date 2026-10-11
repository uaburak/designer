/**
 * The idle session timeout in main (docs/desktop.md §18.2): the timer itself is shared with the web app
 * (`src/shared/idleTimer.ts`); account/index.ts wires it to Electron and to the server.
 */
export { ACTIVE_POST_MS, IDLE_WARNING_MS, IdleTimer, type IdleDeps, type IdleState } from "../../shared/idleTimer";
