import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SCHEMA_SHA1 } from "../../shared/schema/document.generated";
import { nodeCodecs } from "../kiwi/codecs";
import { tempDir } from "../testing/harness";
import { decodeHeader, DEFLATE_THRESHOLD, encodeFrame, encodeHeader, HEADER_SIZE, scanSegment, SegmentWriter, type FrameMeta } from "./journal";

const header = { formatVersion: 1, documentFormatVersion: 1, schemaSha1: SCHEMA_SHA1, baseSeq: 1, createdAt: 1759752000000 };
const meta = (seq: number, label = "Move"): FrameMeta => ({ seq, sessionID: (1 << 20) | 3, batchSeq: seq, wallClock: 1759752000000 + seq, hlc: "0mfdcq1pc.000.01", kind: "edit", label });

describe("journal segments (docs/data.md §5.2)", () => {
  it("writes the 64-byte header and FRM1 frames that scan back exactly", () => {
    const h = encodeHeader(header);
    expect(h.length).toBe(HEADER_SIZE);
    expect(new TextDecoder().decode(h.subarray(0, 8))).toBe("DSGNJRNL");
    expect(decodeHeader(h)).toEqual(header);
    const f1 = encodeFrame(meta(1), new Uint8Array([1, 2, 3]), nodeCodecs.deflateRaw);
    expect([...f1.subarray(0, 4)]).toEqual([0x46, 0x52, 0x4d, 0x31]); // "FRM1" in file order
    const big = new Uint8Array(DEFLATE_THRESHOLD + 10).fill(7);
    const f2 = encodeFrame({ ...meta(2), kind: "undo", label: "Ändern" }, big, nodeCodecs.deflateRaw);
    expect(f2.length).toBeLessThan(big.length); // stored deflate-raw (flag bit 0)
    const scan = scanSegment(new Uint8Array([...h, ...f1, ...f2]), nodeCodecs.inflateRaw);
    expect(scan.frames.map((f) => [f.seq, f.kind, f.label, f.message.length])).toEqual([
      [1, "edit", "Move", 3],
      [2, "undo", "Ändern", big.length],
    ]);
    expect(scan.badBytes).toBe(0);
  });

  it("stops at a torn tail, a CRC failure or a seq gap, and counts the frames lost after a hole", () => {
    const h = encodeHeader(header);
    const frames = [1, 2, 3, 4].map((s) => encodeFrame(meta(s), new Uint8Array([s, s, s]), nodeCodecs.deflateRaw));
    const all = new Uint8Array([...h, ...frames.flatMap((f) => [...f])]);
    const torn = all.subarray(0, all.length - 5);
    const s1 = scanSegment(torn, nodeCodecs.inflateRaw);
    expect(s1.frames.map((f) => f.seq)).toEqual([1, 2, 3]);
    expect(s1.badBytes).toBe(frames[3].length - 5);
    expect(s1.droppedFrames).toBe(0);
    const flipped = all.slice();
    flipped[HEADER_SIZE + frames[0].length + 20] ^= 0xff; // inside frame 2's payload
    const s2 = scanSegment(flipped, nodeCodecs.inflateRaw);
    expect(s2.frames.map((f) => f.seq)).toEqual([1]);
    expect(s2.droppedFrames).toBe(2); // frames 3 and 4 were readable but come after the hole
    expect(scanSegment(all, nodeCodecs.inflateRaw, 2).frames).toEqual([]); // expected seq 2, found 1
  });

  it("appends with one write per frame and fsyncs on demand; reopen truncates at the last good frame", async () => {
    const dir = tempDir();
    try {
      const path = join(dir, "journal-000000000001.log");
      const w = SegmentWriter.create(path, header);
      w.append(encodeFrame(meta(1), new Uint8Array([9]), nodeCodecs.deflateRaw));
      expect(w.unsynced).toBe(true);
      await w.sync();
      expect(w.unsynced).toBe(false);
      w.append(new Uint8Array([0x46, 0x52, 0x4d])); // a torn frame
      await w.close();
      const scan = scanSegment(new Uint8Array(readFileSync(path)), nodeCodecs.inflateRaw);
      expect(scan.frames).toHaveLength(1);
      const r = SegmentWriter.reopen(path, scan.header, scan.goodLength, scan.frames.length);
      r.append(encodeFrame(meta(2), new Uint8Array([8]), nodeCodecs.deflateRaw));
      await r.close();
      expect(scanSegment(new Uint8Array(readFileSync(path)), nodeCodecs.inflateRaw).frames.map((f) => f.seq)).toEqual([1, 2]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
