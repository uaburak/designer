import { afterEach, describe, expect, it, vi } from "vitest";
import { Status } from "@/engine/abi";
import type { Engine } from "@/engine/Engine";
import type { Message } from "@/engine/codec";
import { messageToKiwi } from "@/store/engineMessage";
import { encodeMessage } from "@shared/schema/codec";
import { PEER_RETRY_MS, RemoteApplier } from "../multiplayer/remoteApply";

const msg = (name: string): Message => ({ type: "NODE_CHANGES", sessionID: 0, nodeChanges: [{ guid: "1:1", name }] });

/** An engine that is busy while `busy` is set and records what it applied, as which kind */
function fakeEngine() {
  const applied: { name: string; kind: string }[] = [];
  const e = {
    busy: false,
    destroyed: false,
    applied,
    idle: () => !e.busy,
    applyChanges: (m: Message, kind: string) => {
      if (e.busy) return Status.E_BUSY;
      applied.push({ name: String(m.nodeChanges[0]?.name), kind });
      return Status.OK;
    },
  };
  return e;
}

afterEach(() => void vi.useRealTimers());

describe("RemoteApplier (docs/multiplayer.md §18.2)", () => {
  it("applies another session's changes as a peer's, and waits in order while the engine is busy (a drag)", () => {
    vi.useFakeTimers();
    const e = fakeEngine();
    const r = new RemoteApplier(e as unknown as Engine, null);
    r.push(msg("one"));
    expect(e.applied).toEqual([{ name: "one", kind: "peer" }]);
    e.busy = true;
    r.push(msg("two"));
    r.push(msg("three"));
    vi.advanceTimersByTime(PEER_RETRY_MS * 3);
    expect(e.applied).toHaveLength(1);
    expect(r.waiting).toBe(2);
    e.busy = false;
    vi.advanceTimersByTime(PEER_RETRY_MS);
    expect(e.applied.map((a) => a.name)).toEqual(["one", "two", "three"]);
    expect(r.waiting).toBe(0);
  });

  it("asks the source at each attempt what this editor changed since, so a property it changed while the change waited stays its own", () => {
    vi.useFakeTimers();
    const e = fakeEngine();
    const local = { mine: false, withoutLocal: vi.fn((bytes: Uint8Array) => (local.mine ? null : bytes)) };
    const r = new RemoteApplier(e as unknown as Engine, local);
    e.busy = true;
    const bytes = encodeMessage(messageToKiwi(msg("theirs")));
    r.push(msg("theirs"), { seq: 9, bytes });
    // The user's drag ends with a rename of the same layer: journaled after the waiting frame, it wins.
    local.mine = true;
    e.busy = false;
    vi.advanceTimersByTime(PEER_RETRY_MS);
    expect(local.withoutLocal).toHaveBeenLastCalledWith(bytes, 9);
    expect(e.applied).toEqual([]);
    expect(r.waiting).toBe(0);
  });

  it("drops what waits when the editor goes", () => {
    vi.useFakeTimers();
    const e = fakeEngine();
    const r = new RemoteApplier(e as unknown as Engine, null);
    e.busy = true;
    r.push(msg("late"));
    r.stop();
    e.busy = false;
    vi.advanceTimersByTime(PEER_RETRY_MS * 2);
    expect(e.applied).toEqual([]);
  });
});
