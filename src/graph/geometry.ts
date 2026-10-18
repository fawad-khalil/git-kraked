import type { GraphEdge } from "../api";

export const ROW_HEIGHT = 28;
export const LANE_WIDTH = 16;
export const DOT_RADIUS = 5;
/** Space left of the first lane. */
const GRAPH_PADDING = 10;

/** Lane colours; lane n uses LANE_COLORS[n % length]. */
export const LANE_COLORS = [
  "#2f80ed",
  "#eb5757",
  "#27ae60",
  "#f2994a",
  "#9b51e0",
  "#00a3a3",
  "#d4a017",
  "#e0569b",
];

export const laneColor = (lane: number) => LANE_COLORS[lane % LANE_COLORS.length];

export const laneX = (column: number) => GRAPH_PADDING + column * LANE_WIDTH + LANE_WIDTH / 2;

export const rowY = (row: number) => row * ROW_HEIGHT + ROW_HEIGHT / 2;

/** Pixel width of a graph `columns` lanes wide. */
export const graphWidth = (columns: number) => GRAPH_PADDING * 2 + Math.max(columns, 1) * LANE_WIDTH;

export interface Segment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /** Bezier control points for a bend; absent for a straight line. */
  curve?: { cx1: number; cy1: number; cx2: number; cy2: number };
  color: string;
}

/**
 * The line for `edge` leaving row `row`. A lane change bends within the lower half of
 * the gap so the line leaves a dot vertically and arrives vertically, like a rail switch.
 */
export function edgeSegment([from, to, lane]: GraphEdge, row: number): Segment {
  const x1 = laneX(from);
  const x2 = laneX(to);
  const y1 = rowY(row);
  const y2 = rowY(row + 1);
  const color = laneColor(lane);
  if (from === to) return { x1, y1, x2, y2, color };
  const mid = (y1 + y2) / 2;
  return { x1, y1, x2, y2, color, curve: { cx1: x1, cy1: mid, cx2: x2, cy2: mid } };
}
