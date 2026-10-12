import { describe, expect, it } from "vitest";
import { fromHeaderText, headerText } from "./identityHeaders";
import { roomsOn } from "./policy/region";
import { sqliteD1 } from "./testing/sqliteD1";
import type { ObjectNamespace } from "./libraries/db";

describe("the identity headers of a room call", () => {
  it("carry any name as ASCII, read back as it was (2026-10-12: 'Burak Koç' was refused as a header value)", async () => {
    const seen: Request[] = [];
    const ns = { idFromName: (n: string) => n, get: () => ({ fetch: async (r: Request) => (seen.push(r), new Response("ok")) }) } as unknown as ObjectNamespace;
    const rooms = roomsOn(ns, sqliteD1());
    for (const name of ["Burak Koç", "Şule Öztürk", "李雷", "a%b c", ""]) {
      await rooms.fetch("file_abcdef", "/room/snapshot", { method: "GET", identity: { userId: "u1", name, role: "editor" }, jurisdiction: null });
      const v = seen.at(-1)!.headers.get("x-user-name")!;
      expect(v).toMatch(/^[\x20-\x7e]*$/);
      expect(fromHeaderText(v)).toBe(name || null);
    }
    expect(seen.at(-1)!.headers.get("x-user-id")).toBe("u1");
    expect(seen.at(-1)!.headers.get("x-role")).toBe("editor");
  });

  it("an older Worker's raw name, or nothing, reads as it is", () => {
    expect(fromHeaderText(null)).toBeNull();
    expect(fromHeaderText("")).toBeNull();
    expect(fromHeaderText("100%")).toBe("100%");
    expect(fromHeaderText(headerText("Koç"))).toBe("Koç");
  });
});
