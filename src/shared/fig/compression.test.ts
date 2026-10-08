// Stored-block deflate-raw (the clipboard archive's chunks): what any inflater reads, read back synchronously.
import { inflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { deflateRawStored, inflateRawStored } from "./compression";

describe("stored deflate-raw", () => {
  it("round-trips through itself and zlib, across block boundaries, empty included", () => {
    for (const n of [0, 1, 1000, 0xffff, 0xffff + 1, 200_000]) {
      const data = new Uint8Array(n).map((_, i) => (i * 31) & 0xff);
      const packed = deflateRawStored(data);
      expect(Buffer.from(inflateRawStored(packed)).equals(Buffer.from(data))).toBe(true);
      expect(Buffer.from(inflateRawSync(packed)).equals(Buffer.from(data))).toBe(true);
    }
  });
  it("refuses compressed blocks (a real codec reads those)", async () => {
    const { deflateRawSync } = await import("node:zlib");
    expect(() => inflateRawStored(new Uint8Array(deflateRawSync(Buffer.from("hello hello hello hello"))))).toThrow();
  });
});
