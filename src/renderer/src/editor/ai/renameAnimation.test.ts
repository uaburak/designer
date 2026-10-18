// Rename layers' row animation (atlas 18 §4.3): the old name deleted at 0.03 s a character, the new typed at 0.07 s.
import { describe, expect, it } from "vitest";
import { renameFrame } from "./renameAnimation";

describe("Rename layers' row animation", () => {
  it("deletes the old name, then types the new one, then is done", () => {
    // "Frame 1": 7 characters, 210 ms to delete; "Card": 4 characters, 280 ms to type.
    expect(renameFrame("Frame 1", "Card", 0)).toBe("Frame 1");
    expect(renameFrame("Frame 1", "Card", 31)).toBe("Frame ");
    expect(renameFrame("Frame 1", "Card", 209)).toBe("F");
    expect(renameFrame("Frame 1", "Card", 210)).toBe("");
    expect(renameFrame("Frame 1", "Card", 210 + 71)).toBe("C");
    expect(renameFrame("Frame 1", "Card", 210 + 279)).toBe("Car");
    expect(renameFrame("Frame 1", "Card", 210 + 280)).toBeNull();
  });
});
