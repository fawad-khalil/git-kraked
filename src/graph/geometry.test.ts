import { describe, expect, it } from "vitest";
import { ROW_HEIGHT, edgeSegment, graphWidth, laneColor, laneX, rowY } from "./geometry";

describe("edgeSegment", () => {
  it("draws a pass-through lane as a straight line between row centres", () => {
    const s = edgeSegment([2, 2, 2], 5);
    expect(s).toEqual({ x1: laneX(2), y1: rowY(5), x2: laneX(2), y2: rowY(6), color: laneColor(2) });
    expect(s.y2 - s.y1).toBe(ROW_HEIGHT);
  });

  it("bends a lane change with vertical tangents at both ends", () => {
    const s = edgeSegment([0, 3, 1], 0);
    expect(s.curve).toEqual({ cx1: laneX(0), cy1: ROW_HEIGHT, cx2: laneX(3), cy2: ROW_HEIGHT });
    // Coloured by the lane it belongs to, not the column it starts in.
    expect(s.color).toBe(laneColor(1));
  });
});

describe("lanes", () => {
  it("cycles colours", () => {
    expect(laneColor(8)).toBe(laneColor(0));
  });

  it("sizes the graph for at least one lane", () => {
    expect(graphWidth(0)).toBe(graphWidth(1));
    expect(graphWidth(3) - graphWidth(2)).toBe(laneX(1) - laneX(0));
  });
});
