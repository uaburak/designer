/**
 * Tests only (signIn.test.ts, idle.test.ts): round 4a's identity world — the Worker's real handler on node:sqlite with
 * a test IdP — loaded by a path TypeScript doesn't follow: its test IdP imports @xmldom/xmldom, whose types reference
 * lib "dom", which clashes with @types/node in this (main's) tsconfig. The few members the tests use are typed here.
 */
import type { Deps } from "../../../server/src/api";

export interface WorldAnswer {
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
  text: string;
  location: URL | null;
}

export interface World {
  deps: Deps;
  google: Record<string, unknown>;
  admin: { token: string; id: string };
  call(method: string, path: string, o?: { token?: string; body?: unknown; form?: Record<string, string> }): Promise<WorldAnswer>;
  rows<T>(sql: string, ...args: unknown[]): Promise<T[]>;
  addIdp(): Promise<string>;
  verifiedDomain(domain: string): Promise<void>;
  settings(patch: Record<string, unknown>): Promise<void>;
  acs(tenantId: string, xml: string, relayState?: string): Promise<WorldAnswer>;
}

export interface TestIdp {
  IDP_SSO: string;
  testKeys(): unknown;
  buildResponse(o: { sp: string; inResponseTo: string | null; nameId?: string }): string;
  signAssertion(xml: string): string;
}

const at = (p: string) => new URL(p, import.meta.url).href;

export const ORIGIN = "https://designer.example.workers.dev";

export async function loadWorld(): Promise<World> {
  const m = (await import(/* @vite-ignore */ at("../../../server/src/testing/identityWorld.ts"))) as { identityWorld(): Promise<World>; ORIGIN: string };
  if (m.ORIGIN !== ORIGIN) throw new Error("the identity world's origin changed");
  return m.identityWorld();
}

export const loadIdp = async (): Promise<TestIdp> => (await import(/* @vite-ignore */ at("../../../server/src/testing/samlIdp.ts"))) as TestIdp;
