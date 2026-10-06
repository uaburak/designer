import { describe, expect, it } from "vitest";
import { currentTheme, parsePreference, resolveTheme, THEME_STORAGE_KEY } from "../theme";

describe("theme preference", () => {
  it("keeps the app's localStorage key", () => expect(THEME_STORAGE_KEY).toBe("designer-theme"));
  it("parses what is stored (anything else is the system's)", () => {
    expect(parsePreference("dark")).toBe("dark");
    expect(parsePreference("light")).toBe("light");
    expect(parsePreference(null)).toBe("system");
    expect(parsePreference("sepia")).toBe("system");
  });
  it("resolves against the system", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });
  it("falls back to system / light without a window", () => {
    expect(currentTheme()).toEqual({ preference: "system", resolved: "light" });
  });
});
