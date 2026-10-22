import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { SCHEMA_SHA1 } from "../../shared/schema/document.generated";
import { nodeCodecs } from "../kiwi/codecs";
import { tempDir } from "../testing/harness";
import { encodeFrame, scanSegment, SegmentWriter, type FrameMeta } from "./journal";

// The disk fills part-way through a frame: the next write call writes some bytes, the one after fails with ENOSPC.
const fail = vi.hoisted(() => ({ armed: false }));
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  const writeSync = ((fd: number, buf: Uint8Array, off?: number, len?: number) => {
    if (fail.armed && len !== undefined && len > 4) {
      fail.armed = false;
      const n = fs.writeSync(fd, buf, off, 4);
      // The rest of the frame fails on the next call
      fail.armed = "next" as never;
      return n;
    }
    if ((fail.armed as unknown) === "next") {
      fail.armed = false;
      throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
    }
    return (fs.writeSync as (...a: unknown[]) => number)(fd, buf, off, len);
  }) as typeof fs.writeSync;
  return { ...fs, default: { ...fs, writeSync }, writeSync };
});

const header = { formatVersion: 1, documentFormatVersion: 1, schemaSha1: SCHEMA_SHA1, baseSeq: 1, createdAt: 1759752000000 };
const meta = (seq: number): FrameMeta => ({ seq, sessionID: (1 << 20) | 3, batchSeq: seq, wallClock: 1759752000000 + seq, hlc: "0mfdcq1pc.000.01", kind: "edit", label: "Move" });
const frame = (seq: number) => encodeFrame(meta(seq), new Uint8Array([seq, seq, seq]), nodeCodecs.deflateRaw);

describe("a journal append that fails part-way", () => {
  it("cuts the torn bytes off, so the frames written after it still scan back", async () => {
    const dir = tempDir();
    try {
      const path = join(dir, "journal-000000000001.log");
      const w = SegmentWriter.create(path, header);
      w.append(frame(1));
      fail.armed = true;
      expect(() => w.append(frame(2))).toThrow(/ENOSPC/);
      // Sent again once there is room: the same seq follows the last whole frame.
      w.append(frame(2));
      w.append(frame(3));
      await w.close();
      const scan = scanSegment(new Uint8Array(readFileSync(path)), nodeCodecs.inflateRaw);
      expect(scan.frames.map((f) => f.seq)).toEqual([1, 2, 3]);
      expect(scan.badBytes).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
