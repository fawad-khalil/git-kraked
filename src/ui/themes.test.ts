import { describe, expect, it } from "vitest";
import { THEMES, appliedTheme, pickTheme } from "./themes";

describe("themes", () => {
  it("uses the chosen light theme for Light and the dark one for Dark", () => {
    expect(appliedTheme("light", "lavender", "nord", true).id).toBe("lavender");
    expect(appliedTheme("dark", "lavender", "nord", false).id).toBe("nord");
  });
  it("follows the system between the chosen themes", () => {
    expect(appliedTheme("system", "lavender", "dracula", false).id).toBe("lavender");
    expect(appliedTheme("system", "lavender", "dracula", true).id).toBe("dracula");
  });
  it("falls back to Light or Dark for unknown or wrong-kind ids", () => {
    expect(pickTheme("gone-theme", false).id).toBe("light");
    expect(pickTheme("lavender", true).id).toBe("dark");
  });
  it("has unique ids", () => {
    expect(new Set(THEMES.map((t) => t.id)).size).toBe(THEMES.length);
  });
});
