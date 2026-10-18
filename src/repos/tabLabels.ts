import { folderName } from "../format";

/**
 * Tab labels for repository folders: the folder name, plus its parent folder when two open
 * repositories share a name (e.g. `app · work` and `app · personal`).
 */
export function tabLabels(paths: string[]): string[] {
  const names = paths.map(folderName);
  return paths.map((path, i) => {
    if (names.indexOf(names[i]) === names.lastIndexOf(names[i])) return names[i];
    const parent = folderName(path.replace(/[\\/]+$/, "").replace(/[\\/][^\\/]+$/, ""));
    return `${names[i]} · ${parent}`;
  });
}
