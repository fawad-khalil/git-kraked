import { describe, expect, it } from "vitest";
import { THEMES, resolveTheme } from "./themes";

describe("themes", () => {
  it("resolves saved ids and falls back to the system for unknown ones", () => {
    expect(resolveTheme("lavender")?.name).toBe("Lavender");
    expect(resolveTheme("system")).toBeNull();
    expect(resolveTheme("gone-theme")).toBeNull();
  });
  it("has unique ids", () => {
    expect(new Set(THEMES.map((t) => t.id)).size).toBe(THEMES.length);
  });
});
