import { usePref } from "../prefs";

export type FileView = "list" | "tree";

/** Whether changed files show as a flat list or a folder tree. One setting for every file list. */
export function useFileView() {
  return usePref<FileView>("fileView", "list");
}

export function FileViewToggle() {
  const [view, setView] = useFileView();
  return (
    <span className="segmented" role="group" aria-label="Show files as">
      {(["list", "tree"] as const).map((v) => (
        <button
          key={v}
          className={`small${view === v ? " on" : ""}`}
          aria-pressed={view === v}
          title={v === "list" ? "Show files as a list of paths" : "Show files in their folders"}
          onClick={() => setView(v)}
        >
          {v === "list" ? "List" : "Tree"}
        </button>
      ))}
    </span>
  );
}
