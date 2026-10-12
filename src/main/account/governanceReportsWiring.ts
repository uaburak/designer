import { app } from "electron";
import { mainFetch } from "../net";
import { storeClient } from "../storeHost";
import { desktopUserAgent, serverUrl, sessionToken } from "./index";
import { GovernanceReports, setGovernanceReports } from "./governanceReports";

/** Wires the reports to the account (session, server) and the store (a file's org: `FileMeta.space.orgId`). */
export function initGovernanceReports(): void {
  const r = new GovernanceReports({
    signedIn: () => sessionToken() !== null,
    orgOf: async (fileKey) => {
      const c = storeClient();
      if (!c) return null;
      const f = await c.workspace.getFile(fileKey).catch(() => null);
      return f?.space?.orgId ?? null;
    },
    post: async (path, body) => {
      const token = sessionToken();
      if (!token) return;
      await mainFetch(`${serverUrl()}${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "user-agent": desktopUserAgent() },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
    },
  });
  setGovernanceReports(r);
  app.once("before-quit", () => void r.drain());
}
