import { invoke } from "@tauri-apps/api/core";
import { UnlistenFn, listen } from "@tauri-apps/api/event";

// Mirrors the structs in crates/gitkraked-core/src/lib.rs.
export interface RepoSummary {
  path: string;
  headBranch: string | null;
  headCommit: string | null;
  localBranches: string[];
}

export interface CommitInfo {
  id: string;
  shortId: string;
  summary: string;
  authorName: string;
  authorEmail: string;
  /** Seconds since the Unix epoch. */
  time: number;
  parentIds: string[];
}

/** The shape of a failed command; mirrors `CommandError` in src-tauri/src/lib.rs. */
export type CommandError =
  | { kind: "notOwned"; message: string; path: string }
  | { kind: "other"; message: string };

export function asCommandError(e: unknown): CommandError {
  if (typeof e === "object" && e !== null && "kind" in e && "message" in e) {
    return e as CommandError;
  }
  return { kind: "other", message: String(e) };
}

/** A line segment from this row's centre to the next row's: `[fromColumn, toColumn, lane]`. */
export type GraphEdge = [from: number, to: number, lane: number];

export interface GraphRow {
  column: number;
  edges: GraphEdge[];
}

export type RefKind = "localBranch" | "remoteBranch" | "tag" | "detachedHead" | "stash";

export interface RefLabel {
  name: string;
  kind: RefKind;
  isHead: boolean;
}

export interface HistoryRow {
  commit: CommitInfo;
  graph: GraphRow;
  refs: RefLabel[];
}

export interface HistoryMeta {
  total: number;
  /** Width of the graph in lanes. */
  columns: number;
}

export const openRepo = (path: string) => invoke<RepoSummary>("open_repo", { path });

/** Loads the repo's history in the backend; rows are then fetched with `historyPage`. */
export const loadHistory = (path: string) => invoke<HistoryMeta>("load_history", { path });

export const historyPage = (offset: number, count: number) =>
  invoke<HistoryRow[]>("history_page", { offset, count });

/** Indexes of loaded history rows whose message, author or id matches `query`. */
export const filterHistory = (query: string) => invoke<number[]>("filter_history", { query });

/**
 * Refreshes the loaded history's branch and tag labels without walking history again.
 * False when a label points at a commit that isn't loaded; then call `loadHistory`.
 */
export const relabelHistory = (path: string) => invoke<boolean>("relabel_history", { path });

/** The loaded history rows at `indexes`, for a filtered list. */
export const historyRows = (indexes: number[]) => invoke<HistoryRow[]>("history_rows", { indexes });

/** Adds the repo to Git's safe.directory list so it opens despite belonging to another user. */
export const trustRepo = (path: string) => invoke<string>("trust_repo", { path });

// File changes, diffs, staging and committing. Mirrors crates/gitkraked-core/src/changes.rs.

export type ChangeKind =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "copied"
  | "typeChanged"
  | "untracked"
  | "conflicted";

export interface FileChange {
  path: string;
  oldPath: string | null;
  kind: ChangeKind;
  additions: number;
  deletions: number;
  binary: boolean;
}

export interface DiffLine {
  kind: "context" | "added" | "removed";
  oldLine: number | null;
  newLine: number | null;
  text: string;
}

export interface DiffHunk {
  header: string;
  lines: DiffLine[];
}

export interface FileDiff {
  change: FileChange;
  hunks: DiffHunk[];
}

export interface CommitDetails {
  commit: CommitInfo;
  message: string;
  committerName: string;
  committerTime: number;
  files: FileChange[];
}

export interface WorkingStatus {
  staged: FileChange[];
  unstaged: FileChange[];
  merging: boolean;
  /** A cherry-pick stopped on conflicts. */
  cherryPicking: boolean;
}

export const commitDetails = (path: string, id: string) =>
  invoke<CommitDetails>("commit_details", { path, id });

export const commitFileDiff = (path: string, id: string, file: string) =>
  invoke<FileDiff>("commit_file_diff", { path, id, file });

export const workingStatus = (path: string) => invoke<WorkingStatus>("working_status", { path });

export const workingFileDiff = (path: string, file: string, staged: boolean) =>
  invoke<FileDiff>("working_file_diff", { path, file, staged });

export const stageFiles = (path: string, files: string[]) => invoke<void>("stage_files", { path, files });

export const unstageFiles = (path: string, files: string[]) =>
  invoke<void>("unstage_files", { path, files });

export const stageHunk = (path: string, file: string, hunk: number) =>
  invoke<void>("stage_hunk", { path, file, hunk });

export const unstageHunk = (path: string, file: string, hunk: number) =>
  invoke<void>("unstage_hunk", { path, file, hunk });

/** Commits the staged changes (or amends HEAD) and returns the new commit id. */
export const commit = (path: string, message: string, amend: boolean) =>
  invoke<string>("commit", { path, message, amend });

// Branches. Mirrors crates/gitkraked-core/src/branches.rs.

export interface LocalBranch {
  name: string;
  isHead: boolean;
  target: string;
  upstream: string | null;
  ahead: number;
  behind: number;
  /** The branch it was started from, which "Pull from parent" brings in. */
  parent: string | null;
  /** Commits this branch has that its parent doesn't. */
  parentAhead: number;
  /** Commits its parent has that this branch doesn't yet. */
  parentBehind: number;
}

export interface RemoteBranch {
  name: string;
  remote: string;
  branch: string;
  target: string;
}

export interface Branches {
  local: LocalBranch[];
  remote: RemoteBranch[];
}

export type MergeResult = "upToDate" | "fastForward" | "merged" | "conflicts";

export const listBranches = (path: string) => invoke<Branches>("list_branches", { path });

/** Creates a branch at `from` (a commit id), or at HEAD when `from` is null. */
export const createBranch = (path: string, name: string, from: string | null, checkout: boolean) =>
  invoke<void>("create_branch", { path, name, from, checkout });

export const checkoutBranch = (path: string, name: string) => invoke<void>("checkout_branch", { path, name });

/** Checks out e.g. `origin/feature` as a local tracking branch; returns the local name. */
export const checkoutRemoteBranch = (path: string, name: string) =>
  invoke<string>("checkout_remote_branch", { path, name });

export const renameBranch = (path: string, name: string, newName: string) =>
  invoke<void>("rename_branch", { path, name, newName });

export const deleteBranch = (path: string, name: string, force: boolean) =>
  invoke<void>("delete_branch", { path, name, force });

/** Merges `name` into the checked-out branch. */
export const mergeBranch = (path: string, name: string) => invoke<MergeResult>("merge_branch", { path, name });

export const abortMerge = (path: string) => invoke<void>("abort_merge", { path });

export const resolveConflict = (path: string, file: string, side: "ours" | "theirs") =>
  invoke<void>("resolve_conflict", { path, file, side });

// Fetch, pull, push (run through the `git` command) and stashes.

export type PullMode = "merge" | "rebase";

export const fetchAll = (path: string) => invoke<void>("fetch", { path });

/** Pulls the current branch; returns git's output. */
export const pull = (path: string, mode: PullMode) => invoke<string>("pull", { path, mode });

/** Brings the latest from `parent` (fetched first if it's a remote branch) into the current branch. */
export const pullFrom = (path: string, parent: string, mode: PullMode) =>
  invoke<string>("pull_from", { path, parent, mode });

export const setParentBranch = (path: string, branch: string, parent: string) =>
  invoke<void>("set_parent_branch", { path, branch, parent });

/** Pushes the current branch, setting its upstream on the first push; returns git's output. */
export const push = (path: string) => invoke<string>("push", { path });

export interface StashEntry {
  index: number;
  message: string;
  id: string;
  base: string;
}

export const listStashes = (path: string) => invoke<StashEntry[]>("list_stashes", { path });

export const stashSave = (path: string, message: string | null) => invoke<void>("stash_save", { path, message });

export const stashApply = (path: string, index: number, pop: boolean) =>
  invoke<void>("stash_apply", { path, index, pop });

export const stashDrop = (path: string, index: number) => invoke<void>("stash_drop", { path, index });

// Cloning. Mirrors crates/gitkraked-core/src/clone.rs.

export interface CloneProgress {
  phase: string;
  /** The whole clone's progress, 0 to 100. */
  percent: number;
  detail: string;
}

/** Clones `url` into `parent/name` and returns the new repository's path. */
export const cloneRepo = (url: string, parent: string, name: string) =>
  invoke<string>("clone_repo", { url, parent, name });

export const cancelClone = () => invoke<void>("cancel_clone");

export const onCloneProgress = (handler: (progress: CloneProgress) => void): Promise<UnlistenFn> =>
  listen<CloneProgress>("clone-progress", (event) => handler(event.payload));

// Worktrees. Mirrors crates/gitkraked-core/src/worktrees.rs.

export interface Worktree {
  path: string;
  /** null when the worktree is on a detached commit. */
  branch: string | null;
  head: string | null;
  isMain: boolean;
  /** The worktree this window has open. */
  isCurrent: boolean;
  /** Why it's locked, if it is ("" when no reason was given). */
  locked: string | null;
  /** Its folder is gone; pruning tidies it away. */
  missing: boolean;
}

export const listWorktrees = (path: string) => invoke<Worktree[]>("list_worktrees", { path });

/** Adds a worktree at `dest` with `branch` checked out; `newBranch` creates the branch first. */
export const addWorktree = (path: string, dest: string, branch: string, newBranch: boolean) =>
  invoke<void>("add_worktree", { path, dest, branch, newBranch });

export const removeWorktree = (path: string, worktree: string, force: boolean) =>
  invoke<void>("remove_worktree", { path, worktree, force });

export const pruneWorktrees = (path: string) => invoke<void>("prune_worktrees", { path });

// Cherry-picking. Mirrors crates/gitkraked-core/src/cherry.rs.

export interface PickCandidate {
  commit: CommitInfo;
  /** The current branch already has an equivalent change. */
  alreadyApplied: boolean;
}

/** Commits on `branch` that the current branch doesn't have, newest first. */
export const pickCandidates = (path: string, branch: string) =>
  invoke<PickCandidate[]>("pick_candidates", { path, branch });

/** Copies commits onto the current branch, oldest first; returns a summary. */
export const cherryPick = (path: string, ids: string[]) => invoke<string>("cherry_pick", { path, ids });

export const continueCherryPick = (path: string) => invoke<string>("continue_cherry_pick", { path });

export const abortCherryPick = (path: string) => invoke<void>("abort_cherry_pick", { path });

export interface Tag {
  name: string;
  /** The tagged commit. */
  target: string;
  /** An annotated tag's message summary; null for a lightweight tag. */
  message: string | null;
  time: number;
}

/** Tags pointing at commits, newest first. */
export const listTags = (path: string) => invoke<Tag[]>("list_tags", { path });

/** Checks out a tag's commit with HEAD detached. */
export const checkoutTag = (path: string, name: string) => invoke<void>("checkout_tag", { path, name });

/** Creates an empty repository in `path` (opens it if it already is one). */
export const initRepo = (path: string) => invoke<RepoSummary>("init_repo", { path });
