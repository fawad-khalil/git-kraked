const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 365 * 24 * 3600],
  ["month", 30 * 24 * 3600],
  ["week", 7 * 24 * 3600],
  ["day", 24 * 3600],
  ["hour", 3600],
  ["minute", 60],
];

/** "3 days ago", "just now": how the commit list shows commit times. */
export function relativeTime(unixSeconds: number, nowMs = Date.now()): string {
  const elapsed = Math.round(nowMs / 1000 - unixSeconds);
  const format = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  for (const [unit, seconds] of UNITS) {
    if (Math.abs(elapsed) >= seconds) {
      return format.format(-Math.floor(elapsed / seconds), unit);
    }
  }
  return "just now";
}

/** The last segment of a path, for the window header. Handles Windows and POSIX separators. */
export function folderName(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/** The folder name `git clone` would pick for a URL: `https://host/team/app.git` → `app`. */
export function repoNameFromUrl(url: string): string {
  const last = url.trim().replace(/[\\/]+$/, "").split(/[\\/:]/).pop() ?? "";
  return last.replace(/\.git$/, "");
}

/** A suggested folder for a new worktree: next to the repo, named `repo-branch`. */
export function worktreeFolder(repoPath: string, branch: string): string {
  const sep = repoPath.includes("\\") ? "\\" : "/";
  const trimmed = repoPath.replace(/[\\/]+$/, "");
  const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  const parent = cut >= 0 ? trimmed.slice(0, cut) : ".";
  const slug = branch.trim().replace(/[\\/:*?"<>|\s]+/g, "-");
  return `${parent}${sep}${folderName(trimmed)}${slug ? `-${slug}` : ""}`;
}
