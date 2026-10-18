import { describe, expect, it } from "vitest";
import { matchesFilter } from "./ListFilter";

describe("matchesFilter", () => {
  it("matches every word anywhere, ignoring case", () => {
    expect(matchesFilter("feature/Login-Form", "login feat")).toBe(true);
    expect(matchesFilter("feature/login", "logout")).toBe(false);
  });
  it("matches everything for an empty query", () => {
    expect(matchesFilter("main", "  ")).toBe(true);
  });
});
