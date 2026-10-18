import { describe, expect, it } from "vitest";
import { folderName, relativeTime, repoNameFromUrl, worktreeFolder } from "./format";

describe("relativeTime", () => {
  const now = 1_700_000_000_000;
  const at = (secondsAgo: number) => now / 1000 - secondsAgo;

  it("says just now for the last minute", () => {
    expect(relativeTime(at(0), now)).toBe("just now");
    expect(relativeTime(at(59), now)).toBe("just now");
  });

  it("picks the largest whole unit", () => {
    expect(relativeTime(at(5 * 60), now)).toBe("5 minutes ago");
    expect(relativeTime(at(3 * 3600), now)).toBe("3 hours ago");
    expect(relativeTime(at(24 * 3600), now)).toBe("yesterday");
    expect(relativeTime(at(400 * 24 * 3600), now)).toBe("last year");
  });
});

describe("folderName", () => {
  it("handles both separators and trailing slashes", () => {
    expect(folderName("C:\\Users\\me\\code\\repo")).toBe("repo");
    expect(folderName("/home/me/code/repo/")).toBe("repo");
  });
});

describe("repoNameFromUrl", () => {
  it("takes the last path segment without .git", () => {
    expect(repoNameFromUrl("https://github.com/team/app.git")).toBe("app");
    expect(repoNameFromUrl("git@github.com:team/app.git")).toBe("app");
    expect(repoNameFromUrl("git@host:app")).toBe("app");
    expect(repoNameFromUrl("C:\\repos\\app\\")).toBe("app");
    expect(repoNameFromUrl("")).toBe("");
  });
});

describe("worktreeFolder", () => {
  it("puts the worktree next to the repo", () => {
    expect(worktreeFolder("C:\\Users\\me\\app", "feature/login")).toBe("C:\\Users\\me\\app-feature-login");
    expect(worktreeFolder("/home/me/app/", "fix")).toBe("/home/me/app-fix");
  });
});
