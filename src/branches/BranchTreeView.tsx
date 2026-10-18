import { useMemo } from "react";
import type { Branches } from "../api";
import { BranchNode, buildBranchTree } from "./branchTree";

interface Props {
  branches: Branches;
  /** The commit shown in the side panel, to highlight its branch. */
  selectedId?: string;
  onSelect: (commitId: string) => void;
  onCheckout: (name: string) => void;
}

/** Branches arranged by where they were started from, rather than by commit history. */
export function BranchTreeView({ branches, selectedId, onSelect, onCheckout }: Props) {
  const tree = useMemo(() => buildBranchTree(branches.local), [branches.local]);
  const remoteTarget = (name: string) => branches.remote.find((r) => r.name === name)?.target;

  const row = (node: BranchNode, parent: string | null) => {
    const b = node.branch;
    const target = b?.target ?? remoteTarget(node.name);
    return (
      <li key={node.name}>
        <div
          className={`branch-node${b?.isHead ? " current" : ""}${!b ? " remote" : ""}${target && target === selectedId ? " selected" : ""}`}
          title={b ? `${node.name}. Click to see its latest commit, double-click to check it out.` : `${node.name} (remote)`}
          onClick={() => target && onSelect(target)}
          onDoubleClick={() => b && !b.isHead && onCheckout(b.name)}
        >
          <span className="branch-node-name">{node.name}</span>
          {b?.isHead && <span className="pill">current</span>}
          {b && parent && (b.parentAhead > 0 || b.parentBehind > 0) && (
            <span className="vs-parent">
              {b.parentAhead > 0 && (
                <span title={`${b.parentAhead} ${b.parentAhead === 1 ? "commit" : "commits"} not in ${parent}`}>
                  {b.parentAhead} ahead
                </span>
              )}
              {b.parentBehind > 0 && (
                <span className="behind" title={`${parent} has ${b.parentBehind} new ${b.parentBehind === 1 ? "commit" : "commits"} this branch doesn't`}>
                  {b.parentBehind} behind
                </span>
              )}
            </span>
          )}
          {b && parent && b.parentAhead === 0 && b.parentBehind === 0 && <span className="vs-parent">same as {parent}</span>}
          {b?.upstream && (b.ahead > 0 || b.behind > 0) && (
            <span className="sync" title={`Compared with ${b.upstream}`}>
              {b.ahead > 0 && `↑${b.ahead}`} {b.behind > 0 && `↓${b.behind}`}
            </span>
          )}
        </div>
        {node.children.length > 0 && <ul>{node.children.map((c) => row(c, node.name))}</ul>}
      </li>
    );
  };

  if (tree.length === 0) return <p className="empty">This repository has no local branches yet.</p>;
  return (
    <div className="branch-tree">
      <p className="muted dialog-hint">
        Each branch sits under the branch it was started from. "Ahead" counts its own commits; "behind" counts new
        commits on its parent that it doesn't have yet.
      </p>
      <ul className="branch-tree-root">{tree.map((n) => row(n, null))}</ul>
    </div>
  );
}
