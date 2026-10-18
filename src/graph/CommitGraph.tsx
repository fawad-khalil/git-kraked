import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { HistoryMeta, HistoryRow, RefLabel, filterHistory, historyPage, historyRows } from "../api";
import { relativeTime } from "../format";
import { usePref } from "../prefs";
import { DOT_RADIUS, ROW_HEIGHT, edgeSegment, graphWidth, laneColor, laneX, rowY } from "./geometry";

/** Rows fetched per request. */
const PAGE_SIZE = 200;
/** Rows rendered above and below the viewport so fast scrolling doesn't flash blanks. */
const OVERSCAN = 20;
/** Very wide histories are clipped here; the lanes nearest the left matter most. */
const MAX_GRAPH_WIDTH = 320;

/** Narrowest a column can be dragged. */
const MIN_COLUMN = 40;

/** "Saturday, 18 October 2026 at 19:08:51 CEST": the When column's hover text. */
const exactTime = (unixSeconds: number) =>
  new Date(unixSeconds * 1000).toLocaleString(undefined, { dateStyle: "full", timeStyle: "long" });

/**
 * The commit list with its graph. Only the rows in view are rendered, and rows are
 * fetched from the backend a page at a time, so a 100k-commit history scrolls as
 * smoothly as a small one. Remount it (via `key`) when a new history is loaded; bump
 * `refreshKey` when only the labels changed, which refetches rows but keeps the scroll.
 */
interface Props {
  meta: HistoryMeta;
  selectedId?: string;
  onSelect: (id: string) => void;
  /** Right-click on a commit, e.g. to cherry-pick it. */
  onCommitMenu?: (row: HistoryRow, x: number, y: number) => void;
  /** Uncommitted changes, shown as the first row. Omit to hide that row. */
  wip?: WipSummary;
  wipSelected?: boolean;
  onSelectWip?: () => void;
  /** The commit HEAD points at, which the uncommitted-changes row joins. */
  headId?: string | null;
  refreshKey?: number;
}

export interface WipSummary {
  staged: number;
  unstaged: number;
  /** Shown instead of the counts, e.g. while merging. */
  note?: string;
}

/** "3 files changed · 1 staged". */
function wipText({ staged, unstaged, note }: WipSummary) {
  if (note) return note;
  const files = staged + unstaged;
  if (files === 0) return "No uncommitted changes";
  const changed = `${files} ${files === 1 ? "file" : "files"} changed`;
  return staged > 0 ? `${changed} · ${staged} staged` : changed;
}

export function CommitGraph({ meta, selectedId, onSelect, onCommitMenu, wip, wipSelected, onSelectWip, headId, refreshKey }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pages = useRef(new Map<number, HistoryRow[] | "loading">());
  const [, setPagesLoaded] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);

  // Filtering: the matching row indexes, or null when showing everything.
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<number[] | null>(null);
  const filtered = useRef(false);
  useEffect(() => {
    // Nothing to undo: keep the rows already fetched (clearing them here, with nothing
    // else changing, would leave the list showing placeholders).
    if (!query.trim() && !filtered.current) return;
    let current = true;
    const timer = setTimeout(() => {
      const apply = (next: number[] | null) => {
        if (!current) return;
        filtered.current = next !== null;
        pages.current = new Map();
        setMatches(next);
        scrollRef.current?.scrollTo({ top: 0 });
      };
      if (!query.trim()) apply(null);
      else filterHistory(query).then(apply, () => apply([]));
    }, 200);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [query]);
  const total = matches ? matches.length : meta.total;
  /** Display rows before the first commit: the uncommitted-changes row. */
  const offset = wip ? 1 : 0;

  // Labels moved (e.g. after a checkout): drop the cached rows so they're fetched again.
  const firstRefresh = useRef(refreshKey);
  useEffect(() => {
    if (refreshKey === firstRefresh.current) return;
    firstRefresh.current = refreshKey;
    pages.current = new Map();
    setPagesLoaded((n) => n + 1);
  }, [refreshKey]);

  // Column widths, remembered across restarts. 0 for the graph means "fit the lanes".
  const [graphCol, setGraphCol] = usePref<number>("col.graph", 0);
  const [authorCol, setAuthorCol] = usePref<number>("col.author", 160);
  const [whenCol, setWhenCol] = usePref<number>("col.when", 110);
  const [shaCol, setShaCol] = usePref<number>("col.sha", 80);

  // At least wide enough for the column header.
  const width = graphCol || Math.max(60, Math.min(graphWidth(meta.columns), MAX_GRAPH_WIDTH));
  // Display rows in view; display row d shows commit d - offset.
  const firstShown = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const lastShown = Math.min(total + offset, Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT) + OVERSCAN);
  // The same range as commit indexes.
  const first = Math.max(0, firstShown - offset);
  const last = Math.max(first, lastShown - offset);

  /** Drag a column edge. `direction` is 1 when dragging right widens it, -1 when left does. */
  function startResize(e: React.PointerEvent, start: number, direction: 1 | -1, set: (w: number) => void) {
    e.preventDefault();
    e.stopPropagation();
    const x0 = e.clientX;
    const move = (m: PointerEvent) => set(Math.max(MIN_COLUMN, Math.round(start + direction * (m.clientX - x0))));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.classList.remove("resizing");
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    document.body.classList.add("resizing");
  }

  const rowAt = (i: number): HistoryRow | undefined => {
    const page = pages.current.get(Math.floor(i / PAGE_SIZE));
    return Array.isArray(page) ? page[i % PAGE_SIZE] : undefined;
  };

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setViewportHeight(el.clientHeight));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Fetch any page the visible range touches. The row above `first` is included because
  // its edges run down into the first visible row.
  useEffect(() => {
    if (last <= first) return;
    const firstPage = Math.floor(Math.max(0, first - 1) / PAGE_SIZE);
    const lastPage = Math.floor((last - 1) / PAGE_SIZE);
    for (let p = firstPage; p <= lastPage; p++) {
      if (pages.current.has(p)) continue;
      const cache = pages.current;
      cache.set(p, "loading");
      const load = matches
        ? historyRows(matches.slice(p * PAGE_SIZE, (p + 1) * PAGE_SIZE))
        : historyPage(p * PAGE_SIZE, PAGE_SIZE);
      load
        .then((rows) => {
          cache.set(p, rows);
          setPagesLoaded((n) => n + 1);
        })
        .catch(() => cache.delete(p));
    }
    // refreshKey: refetch after the cache was cleared.
  }, [first, last, matches, refreshKey]);

  // Redraw after every render: renders happen on scroll, resize and page arrival.
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ratio = window.devicePixelRatio || 1;
    const height = (lastShown - firstShown) * ROW_HEIGHT;
    canvas.width = width * ratio;
    canvas.height = height * ratio;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    // Commit i is drawn at display row i + offset; the canvas starts at display row firstShown.
    ctx.setTransform(ratio, 0, 0, ratio, 0, (offset - firstShown) * ROW_HEIGHT * ratio);
    ctx.lineWidth = 2;
    const background = getComputedStyle(canvas).getPropertyValue("--graph-bg").trim() || "#fff";

    // The uncommitted-changes row: a dashed line down to the commit HEAD points at.
    if (wip && firstShown === 0) {
      let headRow = -1;
      for (let i = 0; i < Math.min(last, PAGE_SIZE) && headRow < 0; i++) {
        if (headId && rowAt(i)?.commit.id === headId) headRow = i;
      }
      const lane = headRow >= 0 && !matches ? rowAt(headRow)!.graph.column : 0;
      const color = laneColor(lane);
      if (headRow >= 0 && !matches) {
        ctx.save();
        ctx.setLineDash([3, 3]);
        ctx.strokeStyle = color;
        ctx.beginPath();
        ctx.moveTo(laneX(lane), rowY(-1));
        ctx.lineTo(laneX(lane), rowY(headRow));
        ctx.stroke();
        ctx.restore();
      }
      ctx.save();
      ctx.setLineDash([2, 2]);
      ctx.beginPath();
      ctx.arc(laneX(lane), rowY(-1), DOT_RADIUS, 0, Math.PI * 2);
      ctx.fillStyle = background;
      ctx.fill();
      ctx.strokeStyle = color;
      ctx.stroke();
      ctx.restore();
    }

    // A filtered list skips commits, so its lines would join the wrong rows: dots only.
    for (let i = Math.max(0, first - 1); i < last && !matches; i++) {
      for (const edge of rowAt(i)?.graph.edges ?? []) {
        const s = edgeSegment(edge, i);
        ctx.strokeStyle = s.color;
        ctx.beginPath();
        ctx.moveTo(s.x1, s.y1);
        if (s.curve) {
          const { cx1, cy1, cx2, cy2 } = s.curve;
          ctx.bezierCurveTo(cx1, cy1, cx2, cy2, s.x2, s.y2);
        } else {
          ctx.lineTo(s.x2, s.y2);
        }
        ctx.stroke();
      }
    }

    for (let i = first; i < last; i++) {
      const row = rowAt(i);
      if (!row) continue;
      const color = laneColor(row.graph.column);
      const isMerge = row.commit.parentIds.length > 1;
      ctx.beginPath();
      ctx.arc(laneX(row.graph.column), rowY(i), DOT_RADIUS, 0, Math.PI * 2);
      // Merge commits are hollow, like most graph views.
      ctx.fillStyle = isMerge ? background : color;
      ctx.fill();
      ctx.strokeStyle = color;
      ctx.stroke();
    }
  });

  const rows = [];
  if (wip && firstShown === 0) {
    const files = wip.staged + wip.unstaged;
    rows.push(
      <div
        key="wip"
        className={`graph-row wip-row${wipSelected ? " selected" : ""}${files === 0 && !wip.note ? " is-clean" : ""}`}
        style={{ top: 0, height: ROW_HEIGHT }}
        onClick={onSelectWip}
        title="Stage and commit your uncommitted changes"
      >
        <span />
        <span className="message">
          <span className="ref ref-wip">// WIP</span>
          <span className="summary">{wipText(wip)}</span>
        </span>
        <span />
        <span />
        <span />
      </div>,
    );
  }
  for (let i = first; i < last; i++) {
    const row = rowAt(i);
    rows.push(
      <div
        key={i}
        className={`graph-row${row && row.commit.id === selectedId ? " selected" : ""}`}
        style={{ top: (i + offset) * ROW_HEIGHT, height: ROW_HEIGHT }}
        onClick={() => row && onSelect(row.commit.id)}
        onContextMenu={(e) => {
          if (!row || !onCommitMenu) return;
          e.preventDefault();
          onSelect(row.commit.id);
          onCommitMenu(row, e.clientX, e.clientY);
        }}
      >
        {/* The graph column stays empty; the canvas behind it draws the lanes. */}
        <span />
        <span className="message">
          {row?.refs.map((r) => <RefBadge key={`${r.kind}:${r.name}`} label={r} lane={row.graph.column} />)}
          <span className="summary">{row?.commit.summary ?? "…"}</span>
        </span>
        <span className="author" title={row ? `${row.commit.authorName} <${row.commit.authorEmail}>` : undefined}>
          {row?.commit.authorName}
        </span>
        <span className="when" title={row ? exactTime(row.commit.time) : undefined}>
          {row && relativeTime(row.commit.time)}
        </span>
        <span className="sha mono">{row?.commit.shortId}</span>
      </div>,
    );
  }

  const columns = `${width}px minmax(0, 1fr) ${authorCol}px ${whenCol}px ${shaCol}px`;
  return (
    <div className="graph" style={{ "--graph-columns": columns } as React.CSSProperties}>
      <div className="graph-filter">
        <input
          type="search"
          placeholder="Filter commits by message, author or id"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Escape" && setQuery("")}
          spellCheck={false}
        />
        {matches && (
          <span className="muted">
            {matches.length.toLocaleString()} of {meta.total.toLocaleString()}
          </span>
        )}
      </div>
      <div className="graph-header">
        <span>
          Graph
          <span
            className="col-resizer right"
            title="Drag to resize; double-click to fit the lanes"
            onPointerDown={(e) => startResize(e, width, 1, setGraphCol)}
            onDoubleClick={() => setGraphCol(0)}
          />
        </span>
        <span>Message</span>
        <span>
          <span className="col-resizer left" title="Drag to resize" onPointerDown={(e) => startResize(e, authorCol, -1, setAuthorCol)} />
          Author
        </span>
        <span>
          <span className="col-resizer left" title="Drag to resize" onPointerDown={(e) => startResize(e, whenCol, -1, setWhenCol)} />
          When
        </span>
        <span>
          <span className="col-resizer left" title="Drag to resize" onPointerDown={(e) => startResize(e, shaCol, -1, setShaCol)} />
          Commit
        </span>
      </div>
      <div className="graph-scroll" ref={scrollRef} onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}>
        <div className="graph-spacer" style={{ height: (total + offset) * ROW_HEIGHT }}>
          <canvas ref={canvasRef} className="graph-canvas" style={{ top: firstShown * ROW_HEIGHT }} />
          {rows}
        </div>
        {matches?.length === 0 && <p className="empty">No commits match “{query.trim()}”.</p>}
      </div>
    </div>
  );
}

function RefBadge({ label, lane }: { label: RefLabel; lane: number }) {
  const color = laneColor(lane);
  const style =
    label.kind === "localBranch" || label.kind === "detachedHead"
      ? { background: color, borderColor: color }
      : label.kind === "remoteBranch"
        ? { borderColor: color, color }
        : undefined;
  return (
    <span className={`ref ref-${label.kind}${label.isHead ? " ref-head" : ""}`} style={style} title={label.name}>
      {label.name}
    </span>
  );
}
