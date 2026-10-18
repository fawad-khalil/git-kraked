import { useEffect, useState } from "react";
import { ask } from "@tauri-apps/plugin-dialog";
import {
  Branches,
  MergeResult,
  StashEntry,
  Tag,
  Worktree,
  checkoutTag,
  pruneWorktrees,
  removeWorktree,
  stashApply,
  stashDrop,
  asCommandError,
  checkoutBranch,
  checkoutRemoteBranch,
  createBranch,
  deleteBranch,
  mergeBranch,
  renameBranch,
  setParentBranch,
} from "../api";
import { setPref } from "../prefs";
import { Section } from "../ui/Section";
import { ListFilter, matchesFilter } from "../ui/ListFilter";
import { folderName } from "../format";
import { WorktreeDialog } from "./WorktreeDialog";

interface Props {
  repoPath: string;
  branches: Branches;
  stashes: StashEntry[];
  worktrees: Worktree[];
  tags: Tag[];
  /** Opens the cherry-pick picker on this branch's commits. */
  onCherryPick: (branch: string) => void;
  /** Switches the window to another worktree's folder. */
  onOpenRepo: (path: string) => void;
  /**
   * Runs a Git operation with the app's loader showing, reports its message or error,
   * then refreshes. `quick` refreshes only labels when no commits were added or removed.
   */
  runTask: (label: string, action: () => Promise<string | void>, quick?: boolean) => Promise<void>;
  /** Called after changes made outside `runTask`, so the app reloads. */
  onChanged: () => void;
  /** Shows a short message to the user; errors are flagged. */
  onNotice: (message: string, isError?: boolean) => void;
}

const MERGE_MESSAGES: Record<MergeResult, (name: string, into: string) => string> = {
  upToDate: (name, into) => `${into} already has everything in ${name}.`,
  fastForward: (name, into) => `Fast-forwarded ${into} to ${name}.`,
  merged: (name, into) => `Merged ${name} into ${into}.`,
  conflicts: (name) =>
    `Merging ${name} hit conflicts. Resolve them under Working changes, then commit to finish.`,
};

/** The sidebar: local and remote branches, with checkout, create, rename, delete and merge. */
export function BranchPanel({ repoPath, branches, stashes, worktrees, tags, onCherryPick, onOpenRepo, runTask, onChanged, onNotice }: Props) {
  const [menu, setMenu] = useState<{ name: string; remote: boolean; x: number; y: number } | null>(null);
  const [stashMenu, setStashMenu] = useState<{ index: number; x: number; y: number } | null>(null);
  const [worktreeMenu, setWorktreeMenu] = useState<{ worktree: Worktree; x: number; y: number } | null>(null);
  const [tagMenu, setTagMenu] = useState<{ tag: Tag; x: number; y: number } | null>(null);
  const [tagQuery, setTagQuery] = useState("");
  const [localQuery, setLocalQuery] = useState("");
  const [remoteQuery, setRemoteQuery] = useState("");
  /** Open when adding a worktree; `branch` preselects one. */
  const [newWorktree, setNewWorktree] = useState<{ branch?: string } | null>(null);
  /** Inline name entry: a new branch, or renaming an existing one. */
  const [editing, setEditing] = useState<{ mode: "new"; from?: string } | { mode: "rename"; name: string } | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  /** The branch being dragged, so the current branch can show itself as the drop target. */
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropHover, setDropHover] = useState(false);
  const current = branches.local.find((b) => b.isHead)?.name;

  useEffect(() => {
    if (!menu && !stashMenu && !worktreeMenu && !tagMenu) return;
    const close = () => {
      setMenu(null);
      setStashMenu(null);
      setWorktreeMenu(null);
      setTagMenu(null);
    };
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [menu, stashMenu, worktreeMenu, tagMenu]);

  /** Branch name → the other worktree it's checked out in. */
  const elsewhere = new Map(
    worktrees.filter((w) => !w.isCurrent && w.branch).map((w) => [w.branch as string, w] as const),
  );
  const freeBranches = branches.local.filter((b) => !b.isHead && !elsewhere.has(b.name)).map((b) => b.name);

  async function dropWorktree(w: Worktree) {
    const label = folderName(w.path);
    if (!(await ask(`Remove the worktree ${label}? Its folder is deleted; the branch${w.branch ? ` ${w.branch}` : ""} and its commits stay.`, { title: "Remove worktree", kind: "warning" }))) return;
    run(async () => {
      try {
        await removeWorktree(repoPath, w.path, false);
      } catch (e) {
        const { message } = asCommandError(e);
        if (!/modified or untracked|locked/.test(message)) throw e;
        const force = await ask(`${message}\n\nRemove it anyway? Uncommitted changes in it are lost.`, { title: "Worktree has changes", kind: "warning" });
        if (!force) return;
        await removeWorktree(repoPath, w.path, true);
      }
      return `Removed the worktree ${label}.`;
    });
  }

  async function dropStash(index: number) {
    if (!(await ask(`Delete stash@{${index}}? Its changes will be gone.`, { title: "Delete stash", kind: "warning" }))) return;
    run(() => stashDrop(repoPath, index), "Deleting the stash…", true);
  }

  async function run(action: () => Promise<string | void>, label = "Working…", quick = false) {
    setBusy(true);
    try {
      await runTask(label, action, quick);
    } finally {
      setBusy(false);
    }
  }

  const checkout = (name: string) => run(async () => checkoutBranch(repoPath, name), `Switching to ${name}…`, true);
  const checkoutRemote = (name: string) =>
    run(
      async () => `Checked out ${await checkoutRemoteBranch(repoPath, name)}, tracking ${name}.`,
      `Switching to ${name}…`,
      true,
    );
  const checkoutTagNamed = (name: string) =>
    run(
      async () => {
        await checkoutTag(repoPath, name);
        return `Checked out ${name}. You're not on a branch now; create one from it to keep new commits.`;
      },
      `Switching to ${name}…`,
      true,
    );
  // The current branch stays listed whatever the filter, so it's always there to drop onto.
  const shownLocal = branches.local.filter((b) => b.isHead || matchesFilter(b.name, localQuery));
  const shownRemote = branches.remote.filter((b) => matchesFilter(b.name, remoteQuery));
  const shownTags = tags.filter((t) => matchesFilter(t.name, tagQuery));

  async function dropToMerge(name: string) {
    setDragging(null);
    setDropHover(false);
    if (!current || name === current) return;
    const sure = await ask(`Merge ${name} into ${current}?`, { title: "Merge branch", kind: "info", okLabel: "Merge" });
    if (sure) merge(name);
  }

  const dragProps = (name: string) => ({
    draggable: true,
    onDragStart: (e: React.DragEvent) => {
      e.dataTransfer.setData("text/branch", name);
      e.dataTransfer.effectAllowed = "move";
      setDragging(name);
    },
    onDragEnd: () => {
      setDragging(null);
      setDropHover(false);
    },
  });

  const merge = (name: string) =>
    run(async () => current && MERGE_MESSAGES[await mergeBranch(repoPath, name)](name, current), `Merging ${name}…`);

  async function remove(name: string) {
    if (!(await ask(`Delete the branch ${name}?`, { title: "Delete branch", kind: "warning" }))) return;
    run(async () => {
      try {
        await deleteBranch(repoPath, name, false);
      } catch (e) {
        const { message } = asCommandError(e);
        if (!message.includes("aren't merged")) throw e;
        const force = await ask(`${message}.\n\nDelete it anyway?`, { title: "Unmerged branch", kind: "warning" });
        if (!force) return;
        await deleteBranch(repoPath, name, true);
      }
    });
  }

  function submitName() {
    const name = draft.trim();
    const edit = editing;
    setEditing(null);
    if (!name || !edit) return;
    if (edit.mode === "new") run(() => createBranch(repoPath, name, edit.from ?? null, true), `Creating ${name}…`, true);
    else if (name !== edit.name) run(() => renameBranch(repoPath, edit.name, name), `Renaming ${edit.name}…`, true);
  }

  function openMenu(e: React.MouseEvent, name: string, remote: boolean) {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ name, remote, x: e.clientX, y: e.clientY });
  }

  const nameInput = (
    <input
      className="branch-input"
      autoFocus
      value={draft}
      placeholder="branch-name"
      onChange={(e) => setDraft(e.target.value)}
      onBlur={submitName}
      onKeyDown={(e) => {
        if (e.key === "Enter") submitName();
        if (e.key === "Escape") setEditing(null);
      }}
    />
  );

  const remotes = [...new Set(branches.remote.map((b) => b.remote))];

  return (
    <aside className={`branches${busy ? " busy" : ""}`}>
      <Section
        id="local"
        heading="h2"
        title={`Local (${branches.local.length})`}
        actions={
          <button
            className="small"
            disabled={busy || !current}
            title="Create a branch from the current commit and switch to it"
            onClick={() => {
              setDraft("");
              setEditing({ mode: "new" });
              setPref("collapsed.local", false);
            }}
          >
            New
          </button>
        }
      >
        {branches.local.length > 1 && <ListFilter value={localQuery} onChange={setLocalQuery} placeholder="Filter local branches" />}
        <ul>
          {editing?.mode === "new" && <li>{nameInput}</li>}
          {shownLocal.map((b) =>
            editing?.mode === "rename" && editing.name === b.name ? (
              <li key={b.name}>{nameInput}</li>
            ) : (
              <li
                key={b.name}
                className={[
                  b.isHead && "current",
                  b.isHead && dragging && dragging !== b.name && "drop-target",
                  b.isHead && dropHover && "drop-hover",
                ]
                  .filter(Boolean)
                  .join(" ") || undefined}
                title={[b.name, b.upstream && `tracks ${b.upstream}`, b.parent && `parent ${b.parent}`].filter(Boolean).join(", ")}
                {...(b.isHead ? {} : dragProps(b.name))}
                onDragOver={(e) => {
                  if (!b.isHead) return;
                  e.preventDefault();
                  setDropHover(true);
                }}
                onDragLeave={() => b.isHead && setDropHover(false)}
                onDrop={(e) => {
                  const dragged = e.dataTransfer.getData("text/branch");
                  if (b.isHead && dragged) dropToMerge(dragged);
                }}
                onDoubleClick={() => {
                const other = elsewhere.get(b.name);
                if (other) onOpenRepo(other.path);
                else if (!b.isHead) checkout(b.name);
              }}
                onContextMenu={(e) => openMenu(e, b.name, false)}
              >
                <span className="branch-name">{b.name}</span>
                {b.isHead && dragging && dragging !== b.name && <span className="drop-label">⤵ drop here to merge {dragging}</span>}
                {b.ahead > 0 && <span className="sync" title={`${b.ahead} to push`}>↑{b.ahead}</span>}
                {b.behind > 0 && <span className="sync" title={`${b.behind} to pull`}>↓{b.behind}</span>}
                {elsewhere.has(b.name) && (
                  <span className="sync" title={`Checked out in the worktree at ${elsewhere.get(b.name)?.path}`}>
                    ⧉
                  </span>
                )}
                <button className="menu-button" onClick={(e) => openMenu(e, b.name, false)} title="Branch actions">
                  ⋯
                </button>
              </li>
            ),
          )}
          {localQuery.trim() && shownLocal.length <= 1 && <li className="muted no-match">No other branches match.</li>}
        </ul>
      </Section>

      {remotes.length > 0 && (
        <Section id="remotes" heading="h2" title={`Remotes (${remotes.length})`}>
        {branches.remote.length > 1 && <ListFilter value={remoteQuery} onChange={setRemoteQuery} placeholder="Filter remote branches" />}
        {remoteQuery.trim() && shownRemote.length === 0 && <p className="muted no-match">No remote branches match.</p>}
        {remotes.filter((remote) => shownRemote.some((b) => b.remote === remote)).map((remote) => (
          <Section key={remote} id={`remote.${remote}`} heading="h3" title={remote} className="nested">
            <ul>
              {shownRemote
                .filter((b) => b.remote === remote)
                .map((b) => (
                  <li
                    key={b.name}
                    title={`${b.name}. Double-click to check out.`}
                    {...dragProps(b.name)}
                    onDoubleClick={() => checkoutRemote(b.name)}
                    onContextMenu={(e) => openMenu(e, b.name, true)}
                  >
                    <span className="branch-name">{b.branch}</span>
                    <button className="menu-button" onClick={(e) => openMenu(e, b.name, true)} title="Branch actions">
                      ⋯
                    </button>
                  </li>
                ))}
            </ul>
          </Section>
        ))}
        </Section>
      )}

      {tags.length > 0 && (
        <Section id="tags" heading="h2" title={`Tags (${tags.length})`}>
          {tags.length > 1 && <ListFilter value={tagQuery} onChange={setTagQuery} placeholder="Filter tags" />}
          <ul>
            {shownTags.map((t) => (
              <li
                key={t.name}
                className="tag-item"
                title={`${t.name}${t.message ? `: ${t.message}` : ""}. Double-click to check out.`}
                onDoubleClick={() => checkoutTagNamed(t.name)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setTagMenu({ tag: t, x: e.clientX, y: e.clientY });
                }}
              >
                <span className="tag-icon" aria-hidden>
                  ◆
                </span>
                <span className="branch-name">{t.name}</span>
                <button
                  className="menu-button"
                  title="Tag actions"
                  onClick={(e) => {
                    e.stopPropagation();
                    setTagMenu({ tag: t, x: e.clientX, y: e.clientY });
                  }}
                >
                  ⋯
                </button>
              </li>
            ))}
            {shownTags.length === 0 && <li className="muted no-match">No tags match.</li>}
          </ul>
        </Section>
      )}

      {stashes.length > 0 && (
        <Section id="stashes" heading="h2" title={`Stashes (${stashes.length})`}>
          <ul>
            {stashes.map((s) => (
              <li
                key={s.id}
                title={`${s.message}. Double-click to apply and remove it.`}
                onDoubleClick={() => run(() => stashApply(repoPath, s.index, true), "Applying the stash…", true)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setStashMenu({ index: s.index, x: e.clientX, y: e.clientY });
                }}
              >
                <span className="branch-name">{s.message.split(": ").pop()}</span>
                <button
                  className="menu-button"
                  title="Stash actions"
                  onClick={(e) => {
                    e.stopPropagation();
                    setStashMenu({ index: s.index, x: e.clientX, y: e.clientY });
                  }}
                >
                  ⋯
                </button>
              </li>
            ))}
          </ul>
        </Section>
      )}

      <Section
        id="worktrees"
        heading="h2"
        title={worktrees.length > 1 ? `Worktrees (${worktrees.length})` : "Worktrees"}
        actions={
          <button className="small" disabled={busy} title="Check out another branch in a second folder" onClick={() => setNewWorktree({})}>
            New
          </button>
        }
      >
        <ul>
          {worktrees.map((w) => (
            <li
              key={w.path}
              className={w.isCurrent ? "current" : w.missing ? "missing" : undefined}
              title={`${w.path}${w.missing ? " (folder not found)" : w.isCurrent ? " (open now)" : ". Double-click to open."}`}
              onDoubleClick={() => !w.isCurrent && !w.missing && onOpenRepo(w.path)}
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setWorktreeMenu({ worktree: w, x: e.clientX, y: e.clientY });
              }}
            >
              <span className="branch-name">{folderName(w.path)}</span>
              <span className="sync">{w.branch ?? (w.head ? w.head.slice(0, 7) : "")}</span>
              {w.locked !== null && <span className="sync" title={`Locked${w.locked ? `: ${w.locked}` : ""}`}>🔒</span>}
              <button
                className="menu-button"
                title="Worktree actions"
                onClick={(e) => {
                  e.stopPropagation();
                  setWorktreeMenu({ worktree: w, x: e.clientX, y: e.clientY });
                }}
              >
                ⋯
              </button>
            </li>
          ))}
        </ul>
      </Section>

      <p className="hint small-print">
        To merge, drag any branch onto the current one (shown in blue), or right-click a branch and choose Merge.
      </p>

      {newWorktree && (
        <WorktreeDialog
          repoPath={repoPath}
          freeBranches={freeBranches}
          initialBranch={newWorktree.branch}
          onClose={() => setNewWorktree(null)}
          onDone={(path, openIt) => {
            setNewWorktree(null);
            if (openIt) onOpenRepo(path);
            else {
              onNotice(`Created the worktree ${folderName(path)}.`);
              onChanged();
            }
          }}
        />
      )}

      {worktreeMenu && (
        <ul className="menu" style={{ left: worktreeMenu.x, top: worktreeMenu.y }} onClick={(e) => e.stopPropagation()}>
          {!worktreeMenu.worktree.isCurrent && !worktreeMenu.worktree.missing && (
            <li onClick={() => (setWorktreeMenu(null), onOpenRepo(worktreeMenu.worktree.path))}>Open</li>
          )}
          {worktreeMenu.worktree.missing && (
            <li onClick={() => (setWorktreeMenu(null), run(async () => (await pruneWorktrees(repoPath), "Tidied away worktrees whose folders are gone.")))}>
              Prune missing worktrees
            </li>
          )}
          {!worktreeMenu.worktree.isMain && !worktreeMenu.worktree.isCurrent && !worktreeMenu.worktree.missing && (
            <li className="danger" onClick={() => (setWorktreeMenu(null), dropWorktree(worktreeMenu.worktree))}>
              Remove
            </li>
          )}
          {(worktreeMenu.worktree.isMain || worktreeMenu.worktree.isCurrent) && (
            <li className="muted">{worktreeMenu.worktree.isCurrent ? "This is the worktree open now" : "The main folder can't be removed"}</li>
          )}
        </ul>
      )}

      {tagMenu && (
        <ul className="menu" style={{ left: tagMenu.x, top: tagMenu.y }} onClick={(e) => e.stopPropagation()}>
          <li onClick={() => (setTagMenu(null), checkoutTagNamed(tagMenu.tag.name))}>Check out {tagMenu.tag.name}</li>
          <li
            onClick={() => {
              setTagMenu(null);
              setDraft("");
              setEditing({ mode: "new", from: tagMenu.tag.target });
              setPref("collapsed.local", false);
            }}
          >
            Create a branch here…
          </li>
          <li
            onClick={() => {
              setTagMenu(null);
              navigator.clipboard?.writeText(tagMenu.tag.name);
              onNotice(`Copied ${tagMenu.tag.name}.`);
            }}
          >
            Copy name
          </li>
        </ul>
      )}

      {stashMenu && (
        <ul className="menu" style={{ left: stashMenu.x, top: stashMenu.y }} onClick={(e) => e.stopPropagation()}>
          <li onClick={() => (setStashMenu(null), run(() => stashApply(repoPath, stashMenu.index, true), "Applying the stash…", true))}>
            Pop (apply and remove)
          </li>
          <li onClick={() => (setStashMenu(null), run(() => stashApply(repoPath, stashMenu.index, false), "Applying the stash…", true))}>
            Apply (keep the stash)
          </li>
          <li className="danger" onClick={() => (setStashMenu(null), dropStash(stashMenu.index))}>
            Delete
          </li>
        </ul>
      )}

      {menu && (
        <ul className="menu" style={{ left: menu.x, top: menu.y }} onClick={(e) => e.stopPropagation()}>
          {menu.name !== current && !elsewhere.has(menu.name) && (
            <li onClick={() => (setMenu(null), menu.remote ? checkoutRemote(menu.name) : checkout(menu.name))}>
              Check out
            </li>
          )}
          {elsewhere.has(menu.name) && (
            <li onClick={() => (setMenu(null), onOpenRepo(elsewhere.get(menu.name)!.path))}>Open its worktree</li>
          )}
          {!menu.remote && freeBranches.includes(menu.name) && (
            <li onClick={() => (setMenu(null), setNewWorktree({ branch: menu.name }))}>Check out in a new worktree</li>
          )}
          {menu.name !== current && current && (
            <li onClick={() => (setMenu(null), merge(menu.name))}>
              Merge into {current}
            </li>
          )}
          {menu.name !== current && current && (
            <li onClick={() => (setMenu(null), onCherryPick(menu.name))}>Cherry-pick commits from {menu.name}…</li>
          )}
          {menu.name !== current && current && (
            <li
              onClick={() => (
                setMenu(null),
                run(async () => {
                  await setParentBranch(repoPath, current, menu.name);
                  return `"Pull from" now brings ${menu.name} into ${current}.`;
                })
              )}
            >
              Set as parent of {current}
            </li>
          )}
          {!menu.remote && (
            <li
              onClick={() => {
                setMenu(null);
                setDraft(menu.name);
                setEditing({ mode: "rename", name: menu.name });
              }}
            >
              Rename
            </li>
          )}
          {!menu.remote && menu.name !== current && (
            <li className="danger" onClick={() => (setMenu(null), remove(menu.name))}>
              Delete
            </li>
          )}
        </ul>
      )}
    </aside>
  );
}
