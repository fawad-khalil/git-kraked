import { confirmDialog, errorDialog } from "../ui/dialogs";
import { useState } from "react";
import {
  WorkingStatus,
  abortMerge,
  abortCherryPick,
  continueCherryPick,
  asCommandError,
  commit,
  commitDetails,
  resolveConflict,
  stageFiles,
  unstageFiles,
} from "../api";
import { Section } from "../ui/Section";
import { FileList } from "./FileList";
import { FileViewToggle } from "./FileViewToggle";

interface Props {
  repoPath: string;
  status: WorkingStatus;
  /** The HEAD commit id, for prefilling the message when amending. */
  headCommit: string | null;
  activeFile?: { path: string; staged: boolean };
  onOpenFile: (file: string, staged: boolean) => void;
  /** Called after anything changes the index or HEAD, so the app can refresh. */
  onChanged: (committed: boolean) => void;
}

/** The right-hand panel for uncommitted work: unstaged and staged files and the commit box. */
export function StagingPanel({ repoPath, status, headCommit, activeFile, onOpenFile, onChanged }: Props) {
  const [summary, setSummary] = useState("");
  const [description, setDescription] = useState("");
  const [amend, setAmend] = useState(false);
  const [busy, setBusy] = useState(false);

  async function run(action: () => Promise<unknown>, committed = false) {
    setBusy(true);
    try {
      await action();
      onChanged(committed);
      return true;
    } catch (e) {
      errorDialog(asCommandError(e).message, "That didn't work");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function toggleAmend(on: boolean) {
    setAmend(on);
    // Start from the last commit's message, as `git commit --amend` does.
    if (on && !summary.trim() && headCommit) {
      try {
        const [first, ...rest] = (await commitDetails(repoPath, headCommit)).message.split("\n");
        setSummary(first);
        setDescription(rest.join("\n").trim());
      } catch {
        // Leave the box empty; the user can still type a message.
      }
    }
  }

  async function confirmAbort() {
    const sure = await confirmDialog({
      title: "Abort the merge?",
      message: "Files go back to how they were before the merge, and any conflict fixes are lost.",
      confirmLabel: "Abort merge",
      cancelLabel: "Keep merging",
      danger: true,
    });
    if (sure) run(() => abortMerge(repoPath), true);
  }

  async function doCommit() {
    const message = description.trim() ? `${summary.trim()}\n\n${description.trim()}` : summary.trim();
    if (await run(() => commit(repoPath, message, amend), true)) {
      setSummary("");
      setDescription("");
      setAmend(false);
    }
  }

  const paths = (files: { path: string }[]) => files.map((f) => f.path);
  const canCommit = !busy && summary.trim() !== "" && (status.staged.length > 0 || amend || status.merging);
  const active = (staged: boolean) => (activeFile?.staged === staged ? activeFile.path : undefined);

  async function confirmAbortPick() {
    const sure = await confirmDialog({
      title: "Abort the cherry-pick?",
      message: "The branch goes back to how it was before the cherry-pick started.",
      confirmLabel: "Abort cherry-pick",
      cancelLabel: "Keep going",
      danger: true,
    });
    if (sure) run(() => abortCherryPick(repoPath), true);
  }

  const conflicted = status.unstaged.some((f) => f.kind === "conflicted");

  return (
    <div className="panel staging">
      {status.cherryPicking && (
        <div className="banner">
          <p>
            A cherry-pick stopped on conflicts. For each conflicted file, take one side or fix it by hand and stage
            it, then continue. The commit keeps its original message.
          </p>
          <span className="banner-actions">
            <button
              className="small primary"
              disabled={busy || conflicted}
              title={conflicted ? "Resolve the conflicted files first" : "Commit the picked change and carry on"}
              onClick={() => run(() => continueCherryPick(repoPath), true)}
            >
              Continue cherry-pick
            </button>
            <button className="small" disabled={busy} onClick={confirmAbortPick}>
              Abort
            </button>
          </span>
        </div>
      )}
      {status.merging && (
        <div className="banner">
          <p>
            A merge is in progress. For each conflicted file, take one side or fix it by hand and stage it,
            then commit.
          </p>
          <button className="small" disabled={busy} onClick={confirmAbort}>
            Abort merge
          </button>
        </div>
      )}

      <div className="panel-toolbar">
        <FileViewToggle />
      </div>

      <Section
        id="unstaged"
        title={`Unstaged (${status.unstaged.length})`}
        actions={
          status.unstaged.length > 0 && (
            <button className="small" disabled={busy} onClick={() => run(() => stageFiles(repoPath, paths(status.unstaged)))}>
              Stage all
            </button>
          )
        }
      >
        <FileList
          files={status.unstaged}
          activePath={active(false)}
          onOpen={(f) => onOpenFile(f.path, false)}
          actions={(f) =>
            f.kind === "conflicted"
              ? [
                  { label: "Ours", title: "Keep the current branch's version", run: () => run(() => resolveConflict(repoPath, f.path, "ours")) },
                  { label: "Theirs", title: "Take the merged branch's version", run: () => run(() => resolveConflict(repoPath, f.path, "theirs")) },
                  { label: "Resolved", title: "Stage the file as you've edited it", run: () => run(() => stageFiles(repoPath, [f.path])) },
                ]
              : [{ label: "Stage", run: () => run(() => stageFiles(repoPath, [f.path])) }]
          }
          folderActions={(files) => {
            // Conflicted files are left out: staging one marks it resolved.
            const ready = files.filter((f) => f.kind !== "conflicted");
            return ready.length
              ? [{ label: "Stage", title: "Stage every file in this folder", run: () => run(() => stageFiles(repoPath, paths(ready))) }]
              : [];
          }}
        />
      </Section>

      <Section
        id="staged"
        title={`Staged (${status.staged.length})`}
        actions={
          status.staged.length > 0 && (
            <button className="small" disabled={busy} onClick={() => run(() => unstageFiles(repoPath, paths(status.staged)))}>
              Unstage all
            </button>
          )
        }
      >
        <FileList
          files={status.staged}
          activePath={active(true)}
          onOpen={(f) => onOpenFile(f.path, true)}
          actions={(f) => [{ label: "Unstage", run: () => run(() => unstageFiles(repoPath, [f.path])) }]}
          folderActions={(files) => [
            { label: "Unstage", title: "Unstage every file in this folder", run: () => run(() => unstageFiles(repoPath, paths(files))) },
          ]}
        />
      </Section>

      {!status.cherryPicking && <section className="commit-box">
        <input
          placeholder="Summary"
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && (e.ctrlKey || e.metaKey) && canCommit && doCommit()}
        />
        <textarea
          placeholder="Description (optional)"
          rows={4}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && (e.ctrlKey || e.metaKey) && canCommit && doCommit()}
        />
        <label className="checkbox">
          <input type="checkbox" checked={amend} disabled={!headCommit} onChange={(e) => toggleAmend(e.target.checked)} />
          Amend the last commit
        </label>
        <button className="primary" disabled={!canCommit} onClick={doCommit}>
          {amend ? "Amend commit" : status.staged.length > 0 ? `Commit ${status.staged.length} ${status.staged.length === 1 ? "file" : "files"}` : "Commit"}
        </button>
      </section>}
    </div>
  );
}
