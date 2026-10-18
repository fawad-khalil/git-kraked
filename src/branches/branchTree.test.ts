import { describe, expect, it } from "vitest";
import type { LocalBranch } from "../api";
import { BranchNode, buildBranchTree } from "./branchTree";

const branch = (name: string, parent: string | null, upstream: string | null = null): LocalBranch => ({
  name,
  parent,
  upstream,
  isHead: false,
  target: "0",
  ahead: 0,
  behind: 0,
  parentAhead: 0,
  parentBehind: 0,
});

const outline = (nodes: BranchNode[], depth = 0): string[] =>
  nodes.flatMap((n) => ["  ".repeat(depth) + n.name + (n.branch ? "" : " (remote)"), ...outline(n.children, depth + 1)]);

describe("buildBranchTree", () => {
  it("nests branches under their parents, trunks first", () => {
    const tree = buildBranchTree([
      branch("feature", "origin/main"),
      branch("sub", "feature"),
      branch("main", null, "origin/main"),
      branch("alpha", "main"),
      branch("develop", "main"),
    ]);
    expect(outline(tree)).toEqual(["main", "  develop", "  alpha", "  feature", "    sub"]);
  });

  it("shows a remote parent with no local twin as its own node", () => {
    const tree = buildBranchTree([branch("fix", "upstream/release")]);
    expect(outline(tree)).toEqual(["upstream/release (remote)", "  fix"]);
  });

  it("breaks parent loops", () => {
    const tree = buildBranchTree([branch("a", "b"), branch("b", "a")]);
    expect(outline(tree)).toEqual(["a", "b"]);
  });
});
