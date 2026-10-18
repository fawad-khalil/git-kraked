import { useCallback, useEffect, useRef, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import {
  CommandError,
  Branches,
  HistoryMeta,
  HistoryRow,
  cherryPick,
  RepoSummary,
  StashEntry,
  Tag,
  Worktree,
  WorkingStatus,
  asCommandError,
  listBranches,
  listStashes,
  listTags,
  listWorktrees,
  relabelHistory,
  checkoutBranch,
  initRepo,
  loadHistory,
  openRepo,
  trustRepo,
  workingStatus,
} from "./api";
import { BranchPanel } from "./branches/BranchPanel";
import { BranchTreeView } from "./branches/BranchTreeView";
import { CommitPanel } from "./changes/CommitPanel";
import { DiffTarget, DiffView } from "./changes/DiffView";
import { StagingPanel } from "./changes/StagingPanel";
import { CloneDialog } from "./clone/CloneDialog";
import { CherryPickDialog } from "./cherry/CherryPickDialog";
import { SyncButtons } from "./sync/SyncButtons";
import { BranchCapsule } from "./branches/BranchCapsule";
import { folderName } from "./format";
import { usePref } from "./prefs";
import { PaneResizer } from "./ui/PaneResizer";
import { CommitGraph } from "./graph/CommitGraph";
import { ThemeSwitch } from "./ui/ThemeSwitch";
import { offerFix } from "./repos/fixes";
import { DialogHost, chooseDialog, confirmDialog, errorDialog } from "./ui/dialogs";
import { RepoTabs } from "./repos/RepoTabs";
import { CherryIcon, FolderOpenIcon, PlusIcon, RefreshIcon } from "./ui/icons";
import "./App.css";

function App() {
  const [repo, setRepo] = useState<RepoSummary | null>(null);
  const [history, setHistory] = useState<HistoryMeta | null>(null);
  // Bumped on every load so the graph remounts with an empty page cache.
  const [loadId, setLoadId] = useState(0);
  // The folder the user picked, kept so "Trust this folder" can retry it.
  const [pickedPath, setPickedPath] = useState<string | null>(null);
  const [status, setStatus] = useState<WorkingStatus | null>(null);
  const [branches, setBranches] = useState<Branches | null>(null);
  const [stashes, setStashes] = useState<StashEntry[]>([]);
  const [worktrees, setWorktrees] = useState<Worktree[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);
  /** While set, a Git operation is running: the window shows a loader and ignores clicks. */
  const [busy, setBusy] = useState<string | null>(null);
  // Bumped when only labels changed, so the graph refetches rows but keeps its scroll.
  const [refsVersion, setRefsVersion] = useState(0);
  const [notice, setNotice] = useState<{ message: string } | null>(null);
  /** What the right-hand panel shows: uncommitted work or one commit. */
  const [selection, setSelection] = useState<{ kind: "wip" } | { kind: "commit"; id: string } | null>(null);
  /** When set, the centre shows this diff instead of the graph. */
  const [diff, setDiff] = useState<DiffTarget | null>(null);
  // Bumped after any change so an open diff reloads.
  const [changeCount, setChangeCount] = useState(0);
  const [cloning, setCloning] = useState(false);
  const [newMenu, setNewMenu] = useState(false);
  /** Repositories open as tabs, in tab order, and the one to reopen on start. */
  const [openRepos, setOpenRepos] = usePref<string[]>("repos.open", []);
  const [lastRepo, setLastRepo] = usePref<string | null>("repos.active", null);
  const loadToken = useRef(0);
  const [leftWidth, setLeftWidth] = usePref<number>("pane.left", 220);
  const [rightWidth, setRightWidth] = usePref<number>("pane.right", 360);
  /** Open when choosing commits to cherry-pick; `branch` preselects the source. */
  const [cherry, setCherry] = useState<{ branch?: string } | null>(null);
  const [commitMenu, setCommitMenu] = useState<{ row: HistoryRow; x: number; y: number } | null>(null);
  /** The centre shows the commit graph or the branch tree. */
  const [centerView, setCenterView] = usePref<"commits" | "branches">("centerView", "commits");

  const refreshStatus = useCallback(async (path: string) => {
    try {
      setStatus(await workingStatus(path));
    } catch {
      // Keep the last status; opening or loading history reports real problems.
    }
  }, []);

  // Reopen the repository that was open last time.
  useEffect(() => {
    if (lastRepo && isTauri()) openPath(lastRepo);
    // Only on start.
  }, []);

  // Pick up edits made in other programs when the window regains focus.
  useEffect(() => {
    if (!repo) return;
    const onFocus = () => {
      refreshStatus(repo.path);
      setChangeCount((n) => n + 1);
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [repo, refreshStatus]);

  async function chooseRepo() {
    if (!isTauri()) {
      errorDialog(
        "This page only works inside the GitKraked window. Run `npm run tauri dev` and use the window it opens, not a browser tab.",
        "Open the GitKraked window",
      );
      return;
    }
    const path = await open({ directory: true, title: "Open a Git repository" });
    if (typeof path !== "string") return;
    await openPath(path);
  }

  async function createRepo() {
    if (!isTauri()) {
      chooseRepo(); // Shows the "run it in the GitKraked window" message.
      return;
    }
    const path = await open({ directory: true, title: "Choose an empty folder for the new repository" });
    if (typeof path !== "string") return;
    try {
      await initRepo(path);
      await openPath(path);
      showNotice(`Created a new repository in ${folderName(path)}. Add files, then commit them.`);
    } catch (e) {
      showNotice(asCommandError(e).message, true);
    }
  }

  function startClone() {
    if (!isTauri()) {
      chooseRepo(); // Shows the "run it in the GitKraked window" message.
      return;
    }
    setCloning(true);
  }

  /**
   * Loads (or reloads) a repository. `quick` is for operations that only move refs, such as
   * a checkout: the history already loaded is kept and only its labels are refreshed.
   */
  async function load(path: string, quick = false) {
    // A newer load (e.g. switching tabs quickly) wins; results of older ones are dropped.
    const token = ++loadToken.current;
    const current = () => token === loadToken.current;
    const keep =
      <T,>(set: (value: T) => void) =>
      (value: T) => {
        if (current()) set(value);
      };
    try {
      const summary = await openRepo(path);
      if (!current()) return;
      const sameRepo = summary.path === repo?.path;
      if (!sameRepo) {
        // Clear the previous repository's lists so they never show under the new tab.
        setSelection({ kind: "wip" });
        setDiff(null);
        setHistory(null);
        setBranches(null);
        setStatus(null);
        setStashes([]);
        setWorktrees([]);
        setTags([]);
      }
      setRepo(summary);
      addOpenRepo(summary.path);
      const side = Promise.all([
        workingStatus(summary.path).then(keep(setStatus), () => {}),
        listBranches(summary.path).then(keep(setBranches), () => keep(setBranches)(null)),
        listStashes(summary.path).then(keep(setStashes), () => keep(setStashes)([])),
        listWorktrees(summary.path).then(keep(setWorktrees), () => keep(setWorktrees)([])),
        listTags(summary.path).then(keep(setTags), () => keep(setTags)([])),
      ]);
      if (quick && sameRepo && history && (await relabelHistory(summary.path).catch(() => false))) {
        if (current()) setRefsVersion((n) => n + 1);
      } else {
        const loaded = await loadHistory(summary.path);
        if (!current()) return;
        setHistory(loaded);
        setLoadId((n) => n + 1);
      }
      await side;
    } catch (e) {
      if (!current()) return;
      setRepo(null);
      // Not awaited: the loader closes while the dialog is up.
      reportOpenError(path, asCommandError(e));
    }
  }

  /** Explains why a folder didn't open, with the fix (trust it) or a way out (close its tab). */
  async function reportOpenError(path: string, error: CommandError) {
    const name = folderName(path);
    if (error.kind === "notOwned") {
      const trust = await chooseDialog({
        title: `Git doesn't trust ${name}`,
        message: `${error.message}.\n\nTrusting it adds ${error.path} to safe.directory in your global Git config, the same fix the git command suggests.`,
        tone: "warning",
        dismissValue: false,
        actions: [
          { label: "Cancel", value: false },
          { label: "Trust and open", value: true, primary: true },
        ],
      });
      if (trust) trustAndRetry(path);
      return;
    }
    const inTabs = openRepos.includes(path);
    const choice = await chooseDialog<"ok" | "close" | "other">({
      title: `Couldn't open ${name}`,
      message: error.message,
      tone: "error",
      copyable: true,
      dismissValue: "ok",
      actions: [
        inTabs ? { label: "Close its tab", value: "close" } : { label: "Open another folder", value: "other" },
        { label: "OK", value: "ok", primary: true },
      ],
    });
    if (choice === "close") closeRepo(path);
    if (choice === "other") chooseRepo();
  }

  /** Adds a repository to the tabs (if new) and remembers it as the one to reopen. */
  function addOpenRepo(path: string) {
    setOpenRepos((list) => (list.includes(path) ? list : [...list, path]));
    setLastRepo(path);
  }

  /** Closes a tab; closing the open repository switches to its neighbour. */
  function closeRepo(path: string) {
    const index = openRepos.indexOf(path);
    const rest = openRepos.filter((p) => p !== path);
    setOpenRepos(rest);
    if (path !== activePath) return;
    const next = rest[Math.min(index, rest.length - 1)];
    if (next) {
      openPath(next);
    } else {
      loadToken.current++;
      setLastRepo(null);
      setRepo(null);
      setHistory(null);
      setBranches(null);
      setStatus(null);
    }
  }

  /**
   * Runs a Git operation with the loader showing, reports its message or error, then
   * reloads. The loader stays until the reload is done, so nothing stale can be clicked.
   */
  async function runTask(label: string, action: () => Promise<string | void>, quick = false) {
    if (!repo) return;
    setBusy(label);
    // A missing name and email, remote or sign-in gets a pop-up offering the fix; once it's
    // fixed the operation runs again.
    for (let attempt = 0; ; attempt++) {
      try {
        const message = await action();
        if (message) showNotice(message);
        break;
      } catch (e) {
        quick = false;
        setBusy(null);
        if (!(await offerFix(e, repo.path)) || attempt >= 2) break;
        setBusy(label);
      }
    }
    setBusy(label);
    try {
      await load(repo.path, quick);
    } finally {
      setBusy(null);
    }
  }

  /** Opens another folder, e.g. a worktree, with the loader showing. */
  async function openPath(path: string) {
    setPickedPath(path);
    setBusy(`Opening ${folderName(path)}…`);
    try {
      await load(path);
    } finally {
      setBusy(null);
    }
  }

  async function trustAndRetry(path: string) {
    try {
      await trustRepo(path);
      await openPath(path);
    } catch (e) {
      errorDialog(asCommandError(e).message, `Couldn't trust ${folderName(path)}`);
    }
  }

  /** After staging, unstaging or committing. A commit also changes history and HEAD. */
  async function onChanged(committed = false) {
    if (!repo) return;
    setChangeCount((n) => n + 1);
    await refreshStatus(repo.path);
    if (committed) {
      setDiff(null);
      await load(repo.path);
    }
  }

  /** Successes show briefly at the bottom; errors open a dialog that has to be dismissed. */
  function showNotice(message: string, isError = false) {
    if (isError) errorDialog(message, "That didn't work");
    else setNotice({ message });
  }

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 5000);
    return () => clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    if (!newMenu) return;
    const close = () => setNewMenu(false);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [newMenu]);

  useEffect(() => {
    if (!commitMenu) return;
    const close = () => setCommitMenu(null);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [commitMenu]);

  const currentBranch = branches?.local.find((b) => b.isHead)?.name ?? null;
  const pickSources = [
    ...(branches?.local.filter((b) => !b.isHead).map((b) => b.name) ?? []),
    ...(branches?.remote.map((b) => b.name) ?? []),
  ];

  async function pickOne(row: HistoryRow) {
    if (!repo || !currentBranch) return;
    const sure = await confirmDialog({
      title: `Cherry-pick ${row.commit.shortId} onto ${currentBranch}?`,
      message: `Copies "${row.commit.summary}" onto ${currentBranch} as a new commit.`,
      confirmLabel: "Cherry-pick",
    });
    if (!sure) return;
    await runTask(`Cherry-picking ${row.commit.shortId}…`, () => cherryPick(repo.path, [row.commit.id]));
  }

  /** The tab to highlight: the open repository, or the one that failed to open. */
  const activePath = repo?.path ?? pickedPath;
  const changeTotal = status ? status.staged.length + status.unstaged.length : 0;

  return (
    <div className="app">
      <header className="toolbar">
        <button className="icon-button" aria-label="Open a repository" data-tip="Open a repository folder" onClick={chooseRepo}>
          <FolderOpenIcon />
        </button>
        <span className="menu-anchor">
          <button
            className={`icon-button${newMenu ? " on" : ""}`}
            aria-label="New repository"
            aria-expanded={newMenu}
            data-tip="New: create an empty repository, or clone one"
            onClick={(e) => {
              e.stopPropagation();
              setNewMenu(!newMenu);
            }}
          >
            <PlusIcon />
          </button>
          {newMenu && (
            <ul className="menu dropdown" onClick={(e) => e.stopPropagation()}>
              <li onClick={() => (setNewMenu(false), createRepo())}>Create a new repository…</li>
              <li onClick={() => (setNewMenu(false), startClone())}>Clone a repository…</li>
            </ul>
          )}
        </span>
        {repo && (
          <button
            className="icon-button"
            aria-label="Refresh"
            data-tip="Refresh: reload history, branches and changes"
            onClick={() => openPath(repo.path)}
          >
            <RefreshIcon />
          </button>
        )}
        {repo && <span className="toolbar-divider" />}
        {repo && (
          <SyncButtons
            repoPath={repo.path}
            canStash={changeTotal > 0}
            canPop={stashes.length > 0}
            parent={branches?.local.find((b) => b.isHead)?.parent ?? null}
            otherBranches={pickSources}
            runTask={runTask}
          />
        )}
        {repo && <span className="toolbar-divider" />}
        {repo && (
          <button
            className="icon-button"
            aria-label="Cherry-pick"
            disabled={!currentBranch || pickSources.length === 0}
            data-tip="Cherry-pick: copy commits from another branch onto this one"
            onClick={() => setCherry({})}
          >
            <CherryIcon />
          </button>
        )}
        {repo && (
          <span className="repo-name" title={repo.path}>
            {folderName(repo.path)}
            <BranchCapsule
              name={repo.headBranch}
              branch={branches?.local.find((b) => b.isHead)}
              onShowTree={() => setCenterView("branches")}
            />
          </span>
        )}
        <ThemeSwitch />
      </header>

      {openRepos.length > 0 && (
        <RepoTabs
          repos={openRepos}
          active={activePath}
          onSelect={openPath}
          onClose={closeRepo}
          onAdd={chooseRepo}
        />
      )}

      {busy && (
        <div className="loader" role="status" aria-live="polite">
          <div className="loader-bar" />
          <div className="loader-pill">
            <span className="spinner" />
            {busy}
          </div>
        </div>
      )}

      {notice && (
        <div className="notice" role="status" onClick={() => setNotice(null)}>
          {notice.message}
        </div>
      )}

      <DialogHost />

      {cherry && repo && currentBranch && (
        <CherryPickDialog
          repoPath={repo.path}
          current={currentBranch}
          branches={pickSources}
          initialBranch={cherry.branch}
          onClose={() => setCherry(null)}
          onDone={(message, isError) => {
            setCherry(null);
            showNotice(message, isError);
            load(repo.path);
          }}
        />
      )}

      {commitMenu && (
        <ul className="menu" style={{ left: commitMenu.x, top: commitMenu.y }} onClick={(e) => e.stopPropagation()}>
          {currentBranch && (
            <li onClick={() => (setCommitMenu(null), pickOne(commitMenu.row))}>Cherry-pick onto {currentBranch}</li>
          )}
          <li
            onClick={() => {
              setCommitMenu(null);
              navigator.clipboard?.writeText(commitMenu.row.commit.id);
              showNotice(`Copied ${commitMenu.row.commit.shortId}.`);
            }}
          >
            Copy commit id
          </li>
        </ul>
      )}

      {cloning && (
        <CloneDialog
          onClose={() => setCloning(false)}
          onCloned={(path) => {
            setCloning(false);
            openPath(path);
          }}
        />
      )}

      {!repo && (
        <div className="welcome">
          <h1>GitKraked</h1>
          <p className="muted">Open a repository to see its history, or start a new one.</p>
          <div className="welcome-actions">
            <button className="primary" onClick={chooseRepo}>
              <FolderOpenIcon /> Open a repository
            </button>
            <button onClick={createRepo}>
              <PlusIcon /> Create a new one
            </button>
            <button onClick={startClone}>Clone from a URL</button>
          </div>
        </div>
      )}

      {repo && (
        <div
          className="body"
          style={{ "--left-width": `${leftWidth}px`, "--right-width": `${rightWidth}px` } as React.CSSProperties}
        >
          {branches && (
            <BranchPanel
              repoPath={repo.path}
              branches={branches}
              stashes={stashes}
              worktrees={worktrees}
              tags={tags}
              runTask={runTask}
              onCherryPick={(branch) => setCherry({ branch })}
              onOpenRepo={openPath}
              onChanged={() => load(repo.path)}
              onNotice={showNotice}
            />
          )}

          {branches && <PaneResizer width={leftWidth} direction={1} min={160} max={520} onResize={setLeftWidth} />}

          <main className="center">
            {diff ? (
              <DiffView
                repoPath={repo.path}
                target={diff}
                refreshKey={changeCount}
                onClose={() => setDiff(null)}
                onChanged={() => onChanged()}
              />
            ) : (
              <>
                <div className="center-bar">
                  <span className="segmented" role="group" aria-label="Show">
                    {(["commits", "branches"] as const).map((v) => (
                      <button
                        key={v}
                        className={`small${centerView === v ? " on" : ""}`}
                        aria-pressed={centerView === v}
                        title={v === "commits" ? "Every commit, newest first" : "Branches under the branch they were started from"}
                        onClick={() => setCenterView(v)}
                      >
                        {v === "commits" ? "Commits" : "Branch tree"}
                      </button>
                    ))}
                  </span>
                  {centerView === "branches" && (
                    <button
                      className={`wip-bar${selection?.kind === "wip" ? " selected" : ""}`}
                      onClick={() => setSelection({ kind: "wip" })}
                    >
                      {changeTotal > 0
                        ? `Uncommitted changes: ${changeTotal} ${changeTotal === 1 ? "file" : "files"}`
                        : "No uncommitted changes"}
                    </button>
                  )}
                </div>
                {centerView === "branches" && branches ? (
                  <BranchTreeView
                    branches={branches}
                    selectedId={selection?.kind === "commit" ? selection.id : undefined}
                    onSelect={(id) => setSelection({ kind: "commit", id })}
                    onCheckout={(name) => runTask(`Switching to ${name}…`, () => checkoutBranch(repo.path, name), true)}
                  />
                ) : history ? (
                  <CommitGraph
                    key={loadId}
                    meta={history}
                    selectedId={selection?.kind === "commit" ? selection.id : undefined}
                    onSelect={(id) => setSelection({ kind: "commit", id })}
                    onCommitMenu={(row, x, y) => setCommitMenu({ row, x, y })}
                    refreshKey={refsVersion}
                    headId={repo.headCommit}
                    wip={status ? { staged: status.staged.length, unstaged: status.unstaged.length } : undefined}
                    wipSelected={selection?.kind === "wip"}
                    onSelectWip={() => setSelection({ kind: "wip" })}
                  />
                ) : (
                  <p className="empty">Loading history…</p>
                )}
              </>
            )}
          </main>

          <PaneResizer width={rightWidth} direction={-1} min={260} max={720} onResize={setRightWidth} />

          <aside className="side">
            {selection?.kind === "commit" && (
              <CommitPanel
                repoPath={repo.path}
                id={selection.id}
                activeFile={diff?.source === "commit" ? diff.file : undefined}
                onOpenFile={(file) => setDiff({ source: "commit", id: selection.id, file })}
                onChanged={() => load(repo.path)}
              />
            )}
            {selection?.kind === "wip" && status && (
              <StagingPanel
                repoPath={repo.path}
                status={status}
                headCommit={repo.headCommit}
                activeFile={diff?.source === "working" ? { path: diff.file, staged: diff.staged } : undefined}
                onOpenFile={(file, staged) => setDiff({ source: "working", file, staged })}
                onChanged={onChanged}
              />
            )}
          </aside>
        </div>
      )}
    </div>
  );
}

export default App;
