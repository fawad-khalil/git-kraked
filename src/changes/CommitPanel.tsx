import { useEffect, useState } from "react";
import { CommitDetails, asCommandError, commitDetails, createBranch } from "../api";
import { Section } from "../ui/Section";
import { FileList } from "./FileList";
import { FileViewToggle } from "./FileViewToggle";

interface Props {
  repoPath: string;
  id: string;
  activeFile?: string;
  onOpenFile: (file: string) => void;
  /** Called after a branch is created here. */
  onChanged: () => void;
}

/** The right-hand panel for a selected commit: message, author and changed files. */
export function CommitPanel({ repoPath, id, activeFile, onOpenFile, onChanged }: Props) {
  const [branchName, setBranchName] = useState<string | null>(null);
  const [branchError, setBranchError] = useState<string | null>(null);

  async function createHere() {
    const name = branchName?.trim();
    setBranchName(null);
    if (!name) return;
    try {
      await createBranch(repoPath, name, id, true);
      setBranchError(null);
      onChanged();
    } catch (e) {
      setBranchError(asCommandError(e).message);
    }
  }

  const [details, setDetails] = useState<CommitDetails | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    setDetails(null);
    setError(null);
    commitDetails(repoPath, id)
      .then((d) => current && setDetails(d))
      .catch((e) => current && setError(asCommandError(e).message));
    return () => {
      current = false;
    };
  }, [repoPath, id]);

  if (error) return <div className="panel"><p className="error-text">{error}</p></div>;
  if (!details) return <div className="panel"><p className="muted">Loading…</p></div>;

  const { commit } = details;
  const [summary, ...body] = details.message.split("\n");
  return (
    <div className="panel">
      <h2 className="commit-summary">{summary}</h2>
      {body.join("\n").trim() && <pre className="commit-body">{body.join("\n").trim()}</pre>}
      <dl className="commit-meta">
        <dt>Author</dt>
        <dd>
          {commit.authorName} &lt;{commit.authorEmail}&gt;
        </dd>
        <dt>Date</dt>
        <dd>{new Date(commit.time * 1000).toLocaleString()}</dd>
        {details.committerName !== commit.authorName && (
          <>
            <dt>Committer</dt>
            <dd>{details.committerName}</dd>
          </>
        )}
        <dt>Commit</dt>
        <dd className="mono selectable">{commit.id}</dd>
        {commit.parentIds.length > 0 && (
          <>
            <dt>{commit.parentIds.length > 1 ? "Parents" : "Parent"}</dt>
            <dd className="mono">{commit.parentIds.map((p) => p.slice(0, 7)).join(", ")}</dd>
          </>
        )}
      </dl>
      <div className="commit-actions">
        {branchName === null ? (
          <button className="small" onClick={() => setBranchName("")}>
            New branch here
          </button>
        ) : (
          <input
            className="branch-input"
            autoFocus
            placeholder="branch-name, then Enter"
            value={branchName}
            onChange={(e) => setBranchName(e.target.value)}
            onBlur={createHere}
            onKeyDown={(e) => {
              if (e.key === "Enter") createHere();
              if (e.key === "Escape") setBranchName(null);
            }}
          />
        )}
        {branchError && <p className="error-text">{branchError}</p>}
      </div>
      <Section
        id="commitFiles"
        title={
          <>
            {details.files.length} {details.files.length === 1 ? "file" : "files"} changed
            {commit.parentIds.length > 1 && <span className="muted"> (compared with the first parent)</span>}
          </>
        }
        actions={<FileViewToggle />}
      >
        <FileList files={details.files} activePath={activeFile} onOpen={(f) => onOpenFile(f.path)} />
      </Section>
    </div>
  );
}
