import { describe, expect, it } from "vitest";
import { tabLabels } from "./tabLabels";

describe("tabLabels", () => {
  it("uses folder names", () => {
    expect(tabLabels(["C:\\code\\api", "/home/me/web"])).toEqual(["api", "web"]);
  });
  it("adds the parent folder when names clash", () => {
    expect(tabLabels(["C:\\work\\app", "C:\\personal\\app", "/x/other"])).toEqual(["app · work", "app · personal", "other"]);
  });
});
