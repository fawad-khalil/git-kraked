import type { DiffLine } from "../api";

export interface SplitRow {
  /** The old file's line, or null where the new side has a line the old one didn't. */
  left: DiffLine | null;
  right: DiffLine | null;
}

/**
 * Pairs a hunk's lines for a side-by-side view: context lines sit on both sides, and each
 * run of removed lines lines up with the added lines that replace it.
 */
export function splitRows(lines: DiffLine[]): SplitRow[] {
  const rows: SplitRow[] = [];
  let removed: DiffLine[] = [];
  let added: DiffLine[] = [];
  const flush = () => {
    for (let i = 0; i < Math.max(removed.length, added.length); i++) {
      rows.push({ left: removed[i] ?? null, right: added[i] ?? null });
    }
    removed = [];
    added = [];
  };
  for (const line of lines) {
    if (line.kind === "removed") {
      // A removal after additions starts a new change block.
      if (added.length) flush();
      removed.push(line);
    } else if (line.kind === "added") {
      added.push(line);
    } else {
      flush();
      rows.push({ left: line, right: line });
    }
  }
  flush();
  return rows;
}
