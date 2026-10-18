import type { FileChange } from "../api";

export interface TreeFolder {
  kind: "folder";
  /** One or more path segments: a folder holding only one folder is shown as `a/b`. */
  name: string;
  /** Full path of the folder, used to remember which folders are collapsed. */
  path: string;
  children: TreeNode[];
  /** Every file under this folder, for folder-wide actions such as Stage. */
  files: FileChange[];
}

export interface TreeFile {
  kind: "file";
  name: string;
  file: FileChange;
}

export type TreeNode = TreeFolder | TreeFile;

/** Turns changed files into a folder tree: folders first, then files, each sorted by name. */
export function buildTree(files: FileChange[]): TreeNode[] {
  const root: TreeFolder = { kind: "folder", name: "", path: "", children: [], files: [] };
  for (const file of files) {
    const parts = file.path.split("/");
    let folder = root;
    folder.files.push(file);
    for (const part of parts.slice(0, -1)) {
      const path = folder.path ? `${folder.path}/${part}` : part;
      let next = folder.children.find((c): c is TreeFolder => c.kind === "folder" && c.path === path);
      if (!next) {
        next = { kind: "folder", name: part, path, children: [], files: [] };
        folder.children.push(next);
      }
      next.files.push(file);
      folder = next;
    }
    folder.children.push({ kind: "file", name: parts[parts.length - 1], file });
  }
  return tidy(root.children);
}

function tidy(nodes: TreeNode[]): TreeNode[] {
  return nodes
    .map((node) => {
      if (node.kind === "file") return node;
      let folder = node;
      while (folder.children.length === 1 && folder.children[0].kind === "folder") {
        const only: TreeFolder = folder.children[0];
        folder = { ...only, name: `${folder.name}/${only.name}` };
      }
      return { ...folder, children: tidy(folder.children) };
    })
    .sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "folder" ? -1 : 1));
}
