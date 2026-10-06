import { describe, expect, it } from "vitest";
import { slugify, slugProblem } from "./slug";

describe("slugify", () => {
  it("makes Turkish letters Latin", () => {
    expect(slugify("Şablon Çalışması")).toBe("sablon-calismasi");
    expect(slugify("Görkem Işık Ünlü")).toBe("gorkem-isik-unlu");
  });
  it("keeps only a-z, 0-9 and single hyphens", () => {
    expect(slugify("  Hello,   World!! 2026 ")).toBe("hello-world-2026");
    expect(slugify("---")).toBe("");
  });
});

describe("slugProblem", () => {
  it("accepts a clean slug", () => expect(slugProblem("my-project-2")).toBeNull());
  it("refuses Turkish letters, capitals and spaces", () => {
    expect(slugProblem("şablon")).not.toBeNull();
    expect(slugProblem("Test")).not.toBeNull();
    expect(slugProblem("a b")).not.toBeNull();
  });
  it("refuses hyphens at the ends or doubled", () => {
    expect(slugProblem("-a")).not.toBeNull();
    expect(slugProblem("a--b")).not.toBeNull();
  });
});
