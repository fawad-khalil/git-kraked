import { useEffect, useRef, useState } from "react";
import { PullMode, fetchAll, pull, pullFrom, push, stashApply, stashSave } from "../api";
import { ChevronDownIcon, FetchIcon, PopIcon, PullIcon, PushIcon, StashIcon } from "../ui/icons";

interface Props {
  repoPath: string;
  /** Whether there are uncommitted changes to stash. */
  canStash: boolean;
  /** Whether there's a stash to pop. */
  canPop: boolean;
  /** The current branch's parent, which "Pull from" offers first. */
  parent: string | null;
  /** Every other branch, local and remote, that "Pull from" can bring in. */
  otherBranches: string[];
  /** Runs an operation with the app's loader, reports its message, then reloads. */
  runTask: (label: string, action: () => Promise<string | void>) => Promise<void>;
}

const PULL_MODE_KEY = "gitkraked.pullMode";

function savedPullMode(): PullMode {
  try {
    return localStorage.getItem(PULL_MODE_KEY) === "rebase" ? "rebase" : "merge";
  } catch {
    return "merge";
  }
}

/** Toolbar icon buttons for fetch, pull (with its options), push, stash and pop. */
export function SyncButtons({ repoPath, canStash, canPop, parent, otherBranches, runTask }: Props) {
  const [pullMode, setPullMode] = useState<PullMode>(savedPullMode);
  const [pullMenu, setPullMenu] = useState(false);
  // Which branch "Pull from" brings in: the parent unless another one is picked.
  const [source, setSource] = useState(parent ?? "");
  useEffect(() => setSource(parent ?? ""), [parent]);
  const sources = parent ? [parent, ...otherBranches.filter((b) => b !== parent)] : otherBranches;

  const menuRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!pullMenu) return;
    const close = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setPullMenu(false);
    };
    const escape = (e: KeyboardEvent) => e.key === "Escape" && setPullMenu(false);
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", escape);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", escape);
    };
  }, [pullMenu]);

  function changePullMode(mode: PullMode) {
    setPullMode(mode);
    try {
      localStorage.setItem(PULL_MODE_KEY, mode);
    } catch {
      // Not saved; the choice still applies for this session.
    }
  }

  return (
    <div className="sync-buttons">
      <button
        className="icon-button"
        aria-label="Fetch"
        data-tip="Fetch: download new commits from all remotes without changing your branch"
        onClick={() => runTask("Fetching…", async () => (await fetchAll(repoPath), "Fetched from all remotes."))}
      >
        <FetchIcon />
      </button>

      <span className="split" ref={menuRef}>
        <button
          className="icon-button"
          aria-label="Pull"
          data-tip={`Pull: bring in your branch's remote changes (${pullMode})`}
          onClick={() => runTask("Pulling…", async () => (await pull(repoPath, pullMode), "Pulled."))}
        >
          <PullIcon />
        </button>
        <button
          className={`icon-button arrow${pullMenu ? " on" : ""}`}
          aria-label="Pull options"
          aria-expanded={pullMenu}
          data-tip="Pull options: merge or rebase, or pull from another branch"
          onClick={() => setPullMenu(!pullMenu)}
        >
          <ChevronDownIcon />
        </button>
        {pullMenu && (
          <div className="popover" role="dialog" aria-label="Pull options">
            <div className="popover-label">Pull combines commits by</div>
            <span className="segmented" role="group">
              {(["merge", "rebase"] as const).map((m) => (
                <button
                  key={m}
                  className={`small${pullMode === m ? " on" : ""}`}
                  aria-pressed={pullMode === m}
                  title={m === "merge" ? "Keep both histories and join them with a merge commit" : "Replay your commits on top of the remote's"}
                  onClick={() => changePullMode(m)}
                >
                  {m === "merge" ? "Merge" : "Rebase"}
                </button>
              ))}
            </span>
            {sources.length > 0 && (
              <>
                <div className="popover-label">Pull from another branch</div>
                <select value={source} onChange={(e) => setSource(e.target.value)}>
                  {!parent && <option value="">Choose a branch</option>}
                  {sources.map((b) => (
                    <option key={b} value={b}>
                      {b === parent ? `${b} (parent)` : b}
                    </option>
                  ))}
                </select>
                <button
                  className="primary"
                  disabled={!source}
                  onClick={() => {
                    setPullMenu(false);
                    runTask(`Pulling from ${source}…`, async () => (await pullFrom(repoPath, source, pullMode), `Pulled the latest from ${source}.`));
                  }}
                >
                  {source ? `Pull from ${source}` : "Pull from…"}
                </button>
              </>
            )}
          </div>
        )}
      </span>

      <button
        className="icon-button"
        aria-label="Push"
        data-tip="Push: upload your branch's commits to its remote"
        onClick={() => runTask("Pushing…", async () => (await push(repoPath), "Pushed."))}
      >
        <PushIcon />
      </button>

      <span className="toolbar-divider" />

      <button
        className="icon-button"
        aria-label="Stash"
        disabled={!canStash}
        data-tip={canStash ? "Stash: put all uncommitted changes aside, new files included" : "Stash: nothing to put aside"}
        onClick={() => runTask("Stashing…", async () => (await stashSave(repoPath, null), "Stashed your changes."))}
      >
        <StashIcon />
      </button>
      <button
        className="icon-button"
        aria-label="Pop stash"
        disabled={!canPop}
        data-tip={canPop ? "Pop: bring back the most recent stash" : "Pop: there are no stashes"}
        onClick={() => runTask("Restoring the stash…", async () => (await stashApply(repoPath, 0, true), "Restored the stash."))}
      >
        <PopIcon />
      </button>
    </div>
  );
}
