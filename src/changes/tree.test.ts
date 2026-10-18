import { describe, expect, it } from "vitest";
import type { FileChange } from "../api";
import { TreeNode, buildTree } from "./tree";

const file = (path: string): FileChange => ({ path, oldPath: null, kind: "modified", additions: 1, deletions: 0, binary: false });

/** The tree as indented names, folders marked with a trailing slash. */
function outline(nodes: TreeNode[], depth = 0): string[] {
  return nodes.flatMap((n) =>
    n.kind === "file"
      ? ["  ".repeat(depth) + n.name]
      : ["  ".repeat(depth) + n.name + "/", ...outline(n.children, depth + 1)],
  );
}

describe("buildTree", () => {
  it("groups files by folder, folders first", () => {
    const tree = buildTree(["z.txt", "src/b.ts", "src/a.ts", "docs/x.md", "a.txt"].map(file));
    expect(outline(tree)).toEqual(["docs/", "  x.md", "src/", "  a.ts", "  b.ts", "a.txt", "z.txt"]);
  });

  it("collapses folders that only hold one folder", () => {
    const tree = buildTree(["src/ui/panels/a.ts", "src/ui/panels/b.ts", "src/main.ts"].map(file));
    expect(outline(tree)).toEqual(["src/", "  ui/panels/", "    a.ts", "    b.ts", "  main.ts"]);
    const panels = (tree[0] as Extract<TreeNode, { kind: "folder" }>).children[0];
    expect(panels.kind === "folder" && panels.path).toBe("src/ui/panels");
  });

  it("lists every file under a folder for folder actions", () => {
    const [src] = buildTree(["src/a.ts", "src/deep/b.ts", "top.txt"].map(file));
    expect(src.kind === "folder" && src.files.map((f) => f.path)).toEqual(["src/a.ts", "src/deep/b.ts"]);
  });
});
