import type { LocalBranch } from "../api";

interface Props {
  /** The checked-out branch, or null on a detached commit. */
  name: string | null;
  branch?: LocalBranch;
  onShowTree: () => void;
}

/** The current branch and, joined to it, the branch it came from with how far apart they are. */
export function BranchCapsule({ name, branch, onShowTree }: Props) {
  if (!name) return <span className="capsule"><span className="capsule-branch">detached HEAD</span></span>;
  const parent = branch?.parent;
  const ahead = branch?.parentAhead ?? 0;
  const behind = branch?.parentBehind ?? 0;

  const explain = parent
    ? [
        `${name} was started from ${parent}.`,
        ahead > 0 ? `It has ${ahead} ${ahead === 1 ? "commit" : "commits"} of its own.` : `It has no commits of its own yet.`,
        behind > 0
          ? `${parent} has ${behind} new ${behind === 1 ? "commit" : "commits"} it doesn't have yet; "Pull from ${parent}" brings them in.`
          : `It's up to date with ${parent}.`,
        "Click to see the branch tree.",
      ].join(" ")
    : "";

  return (
    <span className="capsule">
      <span className="capsule-branch" title={`Current branch: ${name}`}>
        {name}
      </span>
      {parent && (
        <button className="capsule-parent" title={explain} onClick={onShowTree}>
          <span className="capsule-from">from</span>
          {parent}
          {ahead > 0 && <span className="capsule-count">↑{ahead}</span>}
          {behind > 0 && <span className="capsule-count behind">↓{behind}</span>}
        </button>
      )}
    </span>
  );
}
