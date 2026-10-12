import { describe, expect, it } from "vitest";
import { allTabEmptyNote } from "../panels/actionsTab";

// Found running round 5 end to end (2026-10-12): a plugin's parameter prompt with an error (or a freeform parameter
// without suggestions) also said "No results for “x”" under the prompt's header.
describe("Actions' All tab without rows", () => {
  it("says nothing while a plugin asks for a parameter", () => {
    expect(allTabEmptyNote("x", 0, true)).toEqual({ kind: "none" });
    expect(allTabEmptyNote("", 0, true)).toEqual({ kind: "none" });
  });
  it("says No results for a search and Recents before one", () => {
    expect(allTabEmptyNote("  rect ", 0, false)).toEqual({ kind: "no-results", query: "rect" });
    expect(allTabEmptyNote("", 0, false)).toEqual({ kind: "recents" });
    expect(allTabEmptyNote("rect", 3, false)).toEqual({ kind: "none" });
  });
});
