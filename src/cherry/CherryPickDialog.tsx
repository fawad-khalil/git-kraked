import { useEffect, useMemo, useState } from "react";
import { PickCandidate, asCommandError, cherryPick, pickCandidates } from "../api";
import { relativeTime } from "../format";

interface Props {
  repoPath: string;
  /** The checked-out branch the commits are copied onto. */
  current: string;
  /** Branches to pick from, local and remote. */
  branches: string[];
  initialBranch?: string;
  /** Called with git's summary once the commits are picked, or with an error to show. */
  onDone: (message: string, isError?: boolean) => void;
  onClose: () => void;
}

/** Choose a branch, filter its commits, tick the ones to copy onto the current branch. */
export function CherryPickDialog({ repoPath, current, branches, initialBranch, onDone, onClose }: Props) {
  const [branch, setBranch] = useState(initialBranch ?? branches[0] ?? "");
  const [candidates, setCandidates] = useState<PickCandidate[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!branch) return;
    let live = true;
    setCandidates(null);
    setPicked(new Set());
    setError(null);
    pickCandidates(repoPath, branch).then(
      (c) => live && setCandidates(c),
      (e) => live && setError(asCommandError(e).message),
    );
    return () => {
      live = false;
    };
  }, [repoPath, branch]);

  const shown = useMemo(() => {
    const words = filter.toLowerCase().split(/\s+/).filter(Boolean);
    return (candidates ?? []).filter(({ commit: c }) => {
      const text = `${c.summary}\n${c.authorName}\n${c.authorEmail}`.toLowerCase();
      return words.every((w) => text.includes(w) || c.id.startsWith(w));
    });
  }, [candidates, filter]);

  function toggle(id: string) {
    setPicked((now) => {
      const next = new Set(now);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }

  async function pick() {
    setBusy(true);
    try {
      onDone(await cherryPick(repoPath, [...picked]));
    } catch (e) {
      onDone(asCommandError(e).message, true);
    }
  }

  const newOnes = shown.filter((c) => !c.alreadyApplied);
  return (
    <div className="overlay">
      <div className="dialog wide">
        <h2>Cherry-pick onto {current}</h2>
        <label>
          From branch
          <select value={branch} onChange={(e) => setBranch(e.target.value)} disabled={busy}>
            {branches.map((b) => (
              <option key={b}>{b}</option>
            ))}
          </select>
        </label>
        <input
          type="search"
          placeholder="Filter these commits by message, author or id"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          spellCheck={false}
        />
        <div className="pick-list">
          {error && <p className="error-text pad">{error}</p>}
          {!candidates && !error && <p className="muted pad">Loading…</p>}
          {candidates?.length === 0 && <p className="muted pad">{current} already has every commit on {branch}.</p>}
          {candidates && candidates.length > 0 && shown.length === 0 && (
            <p className="muted pad">No commits match the filter.</p>
          )}
          {shown.map(({ commit: c, alreadyApplied }) => (
            <label key={c.id} className={`pick-row${alreadyApplied ? " applied" : ""}`}>
              <input type="checkbox" checked={picked.has(c.id)} onChange={() => toggle(c.id)} disabled={busy} />
              <span className="summary" title={c.summary}>
                {c.summary}
              </span>
              <span>
                {alreadyApplied && (
                  <span className="tag" title={`${current} already has an equivalent change`}>
                    already in {current}
                  </span>
                )}
              </span>
              <span className="muted">{c.authorName}</span>
              <span className="muted" title={new Date(c.time * 1000).toLocaleString()}>
                {relativeTime(c.time)}
              </span>
              <span className="mono muted">{c.shortId}</span>
            </label>
          ))}
        </div>
        <div className="dialog-actions">
          <span className="muted dialog-hint grow">
            {newOnes.length > 0 && (
              <button className="small" onClick={() => setPicked(new Set(newOnes.map((c) => c.commit.id)))} disabled={busy}>
                Select all new ({newOnes.length})
              </button>
            )}{" "}
            {picked.size > 0 && (
              <button className="small" onClick={() => setPicked(new Set())} disabled={busy}>
                Clear
              </button>
            )}
          </span>
          <button onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="primary" disabled={busy || picked.size === 0} onClick={pick}>
            {busy ? "Picking…" : `Cherry-pick ${picked.size || ""} ${picked.size === 1 ? "commit" : "commits"}`.replace("  ", " ")}
          </button>
        </div>
        <p className="muted dialog-hint">Picked commits are applied oldest first, keeping their messages and authors.</p>
      </div>
    </div>
  );
}
