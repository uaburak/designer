import { describe, expect, it } from "vitest";
import { loginBypassed, OpenQueue } from "./gateRules";

describe("the login gate's rules (docs/desktop.md §18.6)", () => {
  it("is on unless development or a test turns it off", () => {
    expect(loginBypassed({})).toBe(false);
    expect(loginBypassed({ DESIGNER_SERVER: "http://localhost:8787" })).toBe(false);
    expect(loginBypassed({ DESIGNER_NO_LOGIN: "1" })).toBe(true);
    expect(loginBypassed({ DESIGNER_SEED: "demo" })).toBe(true);
    expect(loginBypassed({ DESIGNER_TEST: "1" })).toBe(true);
    // The driven app can ask for the gate.
    expect(loginBypassed({ DESIGNER_TEST: "1", DESIGNER_LOGIN: "1" })).toBe(false);
    expect(loginBypassed({ DESIGNER_NO_LOGIN: "0" })).toBe(false);
  });

  it("keeps a shared file's link and a Finder .fig while signed out, and opens them after the sign-in, in order", () => {
    let open = false;
    const ran: string[] = [];
    const q = new OpenQueue(() => open);
    expect(q.add("link:abc", () => ran.push("link abc"))).toBe("queued");
    expect(q.add("fig:/a.fig", () => ran.push("fig a"))).toBe("queued");
    // The same link twice opens once (the newer one).
    expect(q.add("link:abc", () => ran.push("link abc again"))).toBe("queued");
    expect(ran).toEqual([]);
    // Still signed out: nothing runs.
    expect(q.flush()).toBe(0);
    expect(q.size).toBe(2);
    open = true;
    expect(q.flush()).toBe(2);
    expect(ran).toEqual(["fig a", "link abc again"]);
    expect(q.size).toBe(0);
    // Signed in: at once.
    expect(q.add("link:def", () => ran.push("link def"))).toBe("ran");
    expect(ran.at(-1)).toBe("link def");
  });

  it("keeps at most `max`, dropping the oldest; one that throws doesn't stop the others", () => {
    let open = false;
    const ran: number[] = [];
    const q = new OpenQueue(() => open, 3);
    for (let i = 0; i < 5; i++) q.add(`k${i}`, () => ran.push(i));
    q.add("bad", () => {
      throw new Error("gone");
    });
    open = true;
    expect(q.flush()).toBe(3);
    expect(ran).toEqual([3, 4]);
  });
});
