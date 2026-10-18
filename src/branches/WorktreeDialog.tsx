import { FormEvent, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { addWorktree, asCommandError } from "../api";
import { folderName, worktreeFolder } from "../format";

interface Props {
  repoPath: string;
  /** Local branches not checked out anywhere yet: the ones a new worktree can take. */
  freeBranches: string[];
  /** Preselects an existing branch, e.g. from a branch's menu. */
  initialBranch?: string;
  onDone: (path: string, openIt: boolean) => void;
  onClose: () => void;
}

/** Adds a worktree: a second working folder with its own branch checked out. */
export function WorktreeDialog({ repoPath, freeBranches, initialBranch, onDone, onClose }: Props) {
  const [mode, setMode] = useState<"existing" | "new">(initialBranch || freeBranches.length ? "existing" : "new");
  const [existing, setExisting] = useState(initialBranch ?? freeBranches[0] ?? "");
  const [newName, setNewName] = useState("");
  const branch = mode === "existing" ? existing : newName;
  // The folder follows the branch until the user edits it.
  const [folder, setFolder] = useState<string | null>(null);
  const dest = folder ?? worktreeFolder(repoPath, branch);
  const [openIt, setOpenIt] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function browse() {
    const parent = await open({ directory: true, title: "Create the worktree inside this folder" });
    if (typeof parent !== "string") return;
    const sep = parent.includes("\\") ? "\\" : "/";
    setFolder(`${parent.replace(/[\\/]+$/, "")}${sep}${folderName(worktreeFolder(repoPath, branch))}`);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await addWorktree(repoPath, dest, branch, mode === "new");
      onDone(dest, openIt);
    } catch (err) {
      setError(asCommandError(err).message);
      setBusy(false);
    }
  }

  return (
    <div className="overlay">
      <form className="dialog" onSubmit={submit}>
        <h2>New worktree</h2>
        <p className="muted dialog-hint">
          A worktree is a second folder for this repository with another branch checked out, so you can
          work on two branches at once without stashing.
        </p>
        <label className="checkbox">
          <input
            type="radio"
            checked={mode === "existing"}
            disabled={!freeBranches.length}
            onChange={() => setMode("existing")}
          />
          Existing branch
        </label>
        {mode === "existing" && (
          <select value={existing} onChange={(e) => setExisting(e.target.value)} disabled={busy}>
            {freeBranches.map((b) => (
              <option key={b}>{b}</option>
            ))}
          </select>
        )}
        <label className="checkbox">
          <input type="radio" checked={mode === "new"} onChange={() => setMode("new")} />
          New branch from the current commit
        </label>
        {mode === "new" && (
          <input
            autoFocus
            placeholder="branch-name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            disabled={busy}
            spellCheck={false}
          />
        )}
        <label>
          Folder
          <span className="row">
            <input value={dest} onChange={(e) => setFolder(e.target.value)} disabled={busy} spellCheck={false} />
            <button type="button" onClick={browse} disabled={busy}>
              Browse…
            </button>
          </span>
        </label>
        <label className="checkbox">
          <input type="checkbox" checked={openIt} onChange={(e) => setOpenIt(e.target.checked)} />
          Open it after creating
        </label>
        {error && <p className="error-text">{error}</p>}
        <div className="dialog-actions">
          <button type="button" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={busy || !branch.trim() || !dest.trim()}>
            {busy ? "Creating…" : "Create worktree"}
          </button>
        </div>
      </form>
    </div>
  );
}
