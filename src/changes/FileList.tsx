import { ReactElement, useMemo, useState } from "react";
import type { ChangeKind, FileChange } from "../api";
import { useFileView } from "./FileViewToggle";
import { TreeNode, buildTree } from "./tree";

const KIND_LETTER: Record<ChangeKind, string> = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
  copied: "C",
  typeChanged: "T",
  untracked: "U",
  conflicted: "!",
};

const KIND_LABEL: Record<ChangeKind, string> = {
  added: "Added",
  modified: "Modified",
  deleted: "Deleted",
  renamed: "Renamed",
  copied: "Copied",
  typeChanged: "Type changed",
  untracked: "New, untracked",
  conflicted: "Conflicted",
};

export interface FileAction {
  label: string;
  title?: string;
  run: () => void;
}

interface Props {
  files: FileChange[];
  /** The file whose diff is open, highlighted in the list. */
  activePath?: string;
  onOpen: (file: FileChange) => void;
  /** Per-file buttons, e.g. Stage or Unstage. Return none to show no buttons for a file. */
  actions?: (file: FileChange) => FileAction[];
  /** Buttons for a folder in tree view, given every file under it. */
  folderActions?: (files: FileChange[]) => FileAction[];
}

/** Changed files as a flat list or a folder tree, following the List/Tree toggle. */
export function FileList({ files, activePath, onOpen, actions, folderActions }: Props) {
  const [view] = useFileView();
  const tree = useMemo(() => (view === "tree" ? buildTree(files) : null), [view, files]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  function toggle(path: string) {
    setCollapsed((current) => {
      const next = new Set(current);
      if (!next.delete(path)) next.add(path);
      return next;
    });
  }

  const buttons = (list: FileAction[] | undefined) =>
    list?.map((a) => (
      <button
        key={a.label}
        className="small"
        title={a.title}
        onClick={(e) => {
          e.stopPropagation();
          a.run();
        }}
      >
        {a.label}
      </button>
    ));

  const fileRow = (f: FileChange, name: string, depth: number) => (
    <li
      key={f.path}
      className={f.path === activePath ? "active" : undefined}
      style={depth ? { paddingLeft: 4 + depth * 14 } : undefined}
      onClick={() => onOpen(f)}
      title={f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}
    >
      <span className={`kind kind-${f.kind}`} title={KIND_LABEL[f.kind]}>
        {KIND_LETTER[f.kind]}
      </span>
      <span className="file-path">{name}</span>
      {!f.binary && (f.additions > 0 || f.deletions > 0) && (
        <span className="counts">
          {f.additions > 0 && <span className="plus">+{f.additions}</span>}
          {f.deletions > 0 && <span className="minus">−{f.deletions}</span>}
        </span>
      )}
      {buttons(actions?.(f))}
    </li>
  );

  const treeRows = (nodes: TreeNode[], depth: number): ReactElement[] =>
    nodes.flatMap((node) => {
      if (node.kind === "file") return [fileRow(node.file, node.name, depth)];
      const open = !collapsed.has(node.path);
      return [
        <li
          key={`dir:${node.path}`}
          className="folder"
          style={{ paddingLeft: 4 + depth * 14 }}
          title={node.path}
          onClick={() => toggle(node.path)}
        >
          <span className={`chevron${open ? "" : " closed"}`} aria-hidden>
            ▾
          </span>
          <span className="file-path">{node.name}</span>
          <span className="counts muted">{node.files.length}</span>
          {buttons(folderActions?.(node.files))}
        </li>,
        ...(open ? treeRows(node.children, depth + 1) : []),
      ];
    });

  return <ul className="file-list">{tree ? treeRows(tree, 0) : files.map((f) => fileRow(f, f.path, 0))}</ul>;
}
