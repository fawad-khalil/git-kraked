import { useEffect, useState } from "react";
import { DiffLine, FileDiff, asCommandError, commitFileDiff, stageHunk, unstageHunk, workingFileDiff } from "../api";
import { usePref } from "../prefs";
import { splitRows } from "./split";

/** Which diff the centre pane shows. */
export type DiffTarget =
  | { source: "commit"; id: string; file: string }
  | { source: "working"; file: string; staged: boolean };

interface Props {
  repoPath: string;
  target: DiffTarget;
  /** Bumped by the app after anything changes, so the diff reloads. */
  refreshKey: number;
  onClose: () => void;
  onChanged: () => void;
}

/** Past this many lines a diff renders on request, so one huge file can't freeze the window. */
const LARGE_DIFF_LINES = 5000;

export function DiffView({ repoPath, target, refreshKey, onClose, onChanged }: Props) {
  const [diff, setDiff] = useState<FileDiff | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showLarge, setShowLarge] = useState(false);
  const [layout, setLayout] = usePref<"inline" | "split">("diffLayout", "inline");

  useEffect(() => {
    let current = true;
    setError(null);
    const load =
      target.source === "commit"
        ? commitFileDiff(repoPath, target.id, target.file)
        : workingFileDiff(repoPath, target.file, target.staged);
    load
      .then((d) => current && setDiff(d))
      .catch((e) => {
        if (!current) return;
        // A working file whose last change was just staged or unstaged has nothing left here.
        if (target.source === "working") onClose();
        else setError(asCommandError(e).message);
      });
    return () => {
      current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoPath, JSON.stringify(target), refreshKey]);

  async function hunkAction(index: number) {
    if (target.source !== "working") return;
    try {
      await (target.staged ? unstageHunk : stageHunk)(repoPath, target.file, index);
      onChanged();
    } catch (e) {
      setError(asCommandError(e).message);
    }
  }

  const lineCount = diff?.hunks.reduce((n, h) => n + h.lines.length, 0) ?? 0;
  const where =
    target.source === "commit" ? `in ${target.id.slice(0, 7)}` : target.staged ? "staged" : "unstaged";

  return (
    <div className="diff">
      <header className="diff-header">
        <span className="file-path" title={target.file}>
          {diff?.change.oldPath && <span className="muted">{diff.change.oldPath} → </span>}
          {target.file}
        </span>
        <span className="muted">{where}</span>
        <span className="segmented" role="group" aria-label="Diff layout">
          {(["inline", "split"] as const).map((v) => (
            <button
              key={v}
              className={`small${layout === v ? " on" : ""}`}
              aria-pressed={layout === v}
              title={v === "inline" ? "Old and new lines in one column" : "Old file on the left, new on the right"}
              onClick={() => setLayout(v)}
            >
              {v === "inline" ? "Inline" : "Side by side"}
            </button>
          ))}
        </span>
        <button className="small" onClick={onClose} title="Back to the graph">
          Close
        </button>
      </header>
      <div className="diff-body">
        {error && <p className="error-text">{error}</p>}
        {!diff && !error && <p className="muted pad">Loading…</p>}
        {diff?.change.binary && <p className="muted pad">Binary file; no text diff to show.</p>}
        {diff && !diff.change.binary && diff.hunks.length === 0 && (
          <p className="muted pad">No content changes (only the file mode or name changed).</p>
        )}
        {diff && lineCount > LARGE_DIFF_LINES && !showLarge ? (
          <p className="muted pad">
            This diff has {lineCount.toLocaleString()} lines.{" "}
            <button className="small" onClick={() => setShowLarge(true)}>
              Show it anyway
            </button>
          </p>
        ) : (
          diff?.hunks.map((hunk, i) => (
            <table className={`hunk${layout === "split" ? " split-view" : ""}`} key={i}>
              {layout === "split" && (
                <colgroup>
                  <col className="ln-col" />
                  <col />
                  <col className="ln-col" />
                  <col />
                </colgroup>
              )}
              <thead>
                <tr>
                  <th colSpan={layout === "split" ? 4 : 3}>
                    <span className="mono">{hunk.header}</span>
                    {target.source === "working" && (
                      <button className="small" onClick={() => hunkAction(i)}>
                        {target.staged ? "Unstage hunk" : "Stage hunk"}
                      </button>
                    )}
                  </th>
                </tr>
              </thead>
              <tbody>
                {layout === "split"
                  ? splitRows(hunk.lines).map((row, j) => (
                      <tr key={j}>
                        <SplitCell line={row.left} side="old" />
                        <SplitCell line={row.right} side="new" />
                      </tr>
                    ))
                  : hunk.lines.map((line, j) => (
                      <tr key={j} className={`line-${line.kind}`}>
                        <td className="ln">{line.oldLine ?? ""}</td>
                        <td className="ln">{line.newLine ?? ""}</td>
                        <td className="code">
                          <span className="sign">{line.kind === "added" ? "+" : line.kind === "removed" ? "−" : " "}</span>
                          {line.text}
                        </td>
                      </tr>
                    ))}
              </tbody>
            </table>
          ))
        )}
      </div>
    </div>
  );
}

/** One side of a side-by-side row: a line number and the text, or an empty filler. */
function SplitCell({ line, side }: { line: DiffLine | null; side: "old" | "new" }) {
  if (!line) {
    return (
      <>
        <td className="ln filler" />
        <td className="code filler" />
      </>
    );
  }
  const kind = line.kind === "context" ? "" : ` line-${line.kind}`;
  return (
    <>
      <td className={`ln${kind}`}>{side === "old" ? line.oldLine : line.newLine}</td>
      <td className={`code${kind}${side === "old" ? " split-left" : ""}`}>{line.text}</td>
    </>
  );
}
