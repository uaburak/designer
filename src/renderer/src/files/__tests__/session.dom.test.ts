// @vitest-environment happy-dom
/**
 * Home and the session's end (docs/multiplayer.md §15.18): the store's `session` event signs the account out and says
 * why — inactivity, or any other end of the session.
 */
import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionEnded } from "@shared/multiplayer/types";
import type { ToastOptions } from "@/ds/components/Toast";
import { mount, type Mounted } from "@/ds/__tests__/dom";
import { IDLE_LOGGED_OUT_TEXT } from "../../account/IdleWarning";
import { FileBrowser } from "../FileBrowser";
import { SESSION_ENDED_TEXT } from "../session";
import type { FilesBackend } from "../storeAccess";
import { MemoryWorkspace } from "./memoryWorkspace";

let m: Mounted | null = null;
afterEach(() => {
  m?.unmount();
  m = null;
  document.body.innerHTML = "";
  delete (window as unknown as { designer?: unknown }).designer;
});

const settle = () => act(async () => new Promise((r) => setTimeout(r, 40)));

describe("the session's end in Home", () => {
  it("idle_timeout and expired both sign out; each says why", async () => {
    const calls: string[] = [];
    const state = { server: "https://s", user: { id: "u", email: "me@x.co", name: "Me", picture: null }, signingIn: false };
    (window as unknown as { designer: unknown }).designer = {
      account: { get: async () => state, signIn: async () => ({ ok: true, state }), cancelSignIn: async () => state, signOut: async () => (calls.push("signOut"), state), onChanged: () => () => {} },
    };
    const listeners = new Set<(e: SessionEnded) => void>();
    const ws = new MemoryWorkspace({ teamName: "Team" });
    const toasts: ToastOptions[] = [];
    const backend: FilesBackend = { workspace: ws, source: "memory", thumbnailUrl: () => null, watchSession: (l) => (listeners.add(l), () => listeners.delete(l)) };
    m = mount(FileBrowser, { backend, initialLocation: { kind: "drafts" }, toast: (t: ToastOptions) => toasts.push(t) });
    await settle();
    expect(listeners.size).toBe(1);
    act(() => listeners.forEach((l) => l({ reason: "idle_timeout" })));
    act(() => listeners.forEach((l) => l({ reason: "expired" })));
    await settle();
    expect(calls).toEqual(["signOut", "signOut"]);
    expect(toasts).toEqual([{ message: IDLE_LOGGED_OUT_TEXT }, { message: SESSION_ENDED_TEXT }]);
    m.unmount();
    m = null;
    expect(listeners.size).toBe(0);
  });
});
