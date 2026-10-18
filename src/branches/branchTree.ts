import type { LocalBranch } from "../api";

export interface BranchNode {
  name: string;
  /** null for a remote branch that's only shown because local branches grew from it. */
  branch: LocalBranch | null;
  children: BranchNode[];
}

const TRUNKS = ["main", "master", "develop", "development", "trunk"];
const isTrunk = (name: string) => TRUNKS.includes(name.split("/").pop() ?? name);

/**
 * Arranges branches by parent: each branch sits under the branch it was started from.
 * A remote parent such as `origin/main` is shown as the local branch tracking it when
 * there is one, otherwise as a remote node of its own.
 */
export function buildBranchTree(local: LocalBranch[]): BranchNode[] {
  const nodes = new Map<string, BranchNode>(local.map((b) => [b.name, { name: b.name, branch: b, children: [] }]));
  const tracking = new Map(local.filter((b) => b.upstream).map((b) => [b.upstream as string, b.name]));
  const roots: BranchNode[] = [];

  /** The node a branch hangs under, or null for a root. */
  const parentOf = (b: LocalBranch): string | null => {
    if (!b.parent) return null;
    if (nodes.has(b.parent)) return b.parent;
    const viaUpstream = tracking.get(b.parent);
    return viaUpstream && viaUpstream !== b.name ? viaUpstream : b.parent;
  };

  // A saved parent chain can loop (a's parent is b, b's is a). Such branches become roots.
  const loops = (b: LocalBranch) => {
    const seen = new Set([b.name]);
    for (let p = parentOf(b); p; ) {
      if (seen.has(p)) return true;
      seen.add(p);
      const next = nodes.get(p)?.branch;
      p = next ? parentOf(next) : null;
    }
    return false;
  };

  for (const b of local) {
    const node = nodes.get(b.name)!;
    const parent = loops(b) ? null : parentOf(b);
    if (!parent) {
      roots.push(node);
      continue;
    }
    let holder = nodes.get(parent);
    if (!holder) {
      holder = { name: parent, branch: null, children: [] };
      nodes.set(parent, holder);
      roots.push(holder);
    }
    holder.children.push(node);
  }

  const order = (a: BranchNode, b: BranchNode) =>
    Number(isTrunk(b.name)) - Number(isTrunk(a.name)) || a.name.localeCompare(b.name);
  const sort = (list: BranchNode[]): BranchNode[] => {
    list.sort(order);
    list.forEach((n) => sort(n.children));
    return list;
  };
  return sort(roots);
}
