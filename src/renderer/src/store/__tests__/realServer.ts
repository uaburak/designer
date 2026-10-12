/**
 * The real Worker handler on node:sqlite (src/store/org/fake/real.ts) for the renderer's tests of the web app. Imported
 * by a computed path so the renderer's type check (DOM lib) doesn't take in the server's sources (Workers types): the
 * part the tests use is typed here.
 */
export interface TestServer {
  readonly fetch: typeof fetch;
  readonly log: string[];
  readonly snapshots: Map<string, { seq: number; bytes: Uint8Array }>;
  addUser(email: string, name?: string): Promise<{ user: { id: string; email: string; name: string }; token: string }>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  call(method: string, path: string, token?: string, body?: unknown): Promise<{ status: number; body: any }>;
}

const REAL = "../../../../store/org/fake/real";

export async function realServer(): Promise<TestServer> {
  const m = (await import(/* @vite-ignore */ REAL)) as { RealOrgServer: new () => TestServer };
  return new m.RealOrgServer();
}
