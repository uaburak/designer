import type { AuthState } from "../../shared/agents/types";

/**
 * Signing in to a CLI agent from the Agents panel, with the CLI's own documented commands (never a password in
 * this app: the provider's sign-in happens in its own browser page). Claude Code: `claude auth status` (JSON),
 * `claude auth login --claudeai` (opens claude.ai in the browser and waits), `claude auth logout`.
 * Electron-free: `run` / `start` are child processes in the host, fakes in the tests.
 */

export interface RunResult {
  code: number;
  stdout: string;
}
export type RunFn = (args: string[]) => Promise<RunResult>;

export const CLAUDE_STATUS = ["auth", "status", "--json"];
export const CLAUDE_LOGIN = ["auth", "login", "--claudeai"];
export const CLAUDE_LOGOUT = ["auth", "logout"];

export function parseClaudeStatus(stdout: string): AuthState {
  try {
    const s = JSON.parse(stdout) as { loggedIn?: boolean; email?: string; authMethod?: string; subscriptionType?: string; orgName?: string };
    if (!s.loggedIn) return { state: "signed-out" };
    const plan = s.subscriptionType ? `Claude ${s.subscriptionType.charAt(0).toUpperCase()}${s.subscriptionType.slice(1)}` : s.authMethod;
    return { state: "connected", account: s.email, plan: [plan, s.orgName].filter(Boolean).join(" · ") || undefined };
  } catch {
    return { state: "signed-out", detail: "Couldn't read “claude auth status”" };
  }
}

export async function claudeAuthStatus(path: string | null, run: RunFn): Promise<AuthState> {
  if (!path) return { state: "not-installed", detail: "Claude Code isn't installed (looked for “claude” on PATH and in ~/.local/bin)" };
  const r = await run(CLAUDE_STATUS);
  return parseClaudeStatus(r.stdout);
}

/** The sign-in page's address in the CLI's output (shown in the panel when the browser didn't open by itself). */
export const loginUrl = (out: string): string | null => /https:\/\/[^\s"'<>]+/.exec(out)?.[0] ?? null;
