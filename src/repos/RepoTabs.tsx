import { PlusIcon } from "../ui/icons";
import { tabLabels } from "./tabLabels";

interface Props {
  /** Repository folders, in tab order. */
  repos: string[];
  /** The open one, if any. */
  active: string | null;
  onSelect: (path: string) => void;
  onClose: (path: string) => void;
  onAdd: () => void;
}

/** One tab per open repository; click to switch, × or middle-click to close. */
export function RepoTabs({ repos, active, onSelect, onClose, onAdd }: Props) {
  const labels = tabLabels(repos);
  return (
    <nav className="repo-tabs" aria-label="Open repositories">
      <div className="repo-tabs-scroll" role="tablist">
        {repos.map((path, i) => (
          <div
            key={path}
            role="tab"
            aria-selected={path === active}
            tabIndex={0}
            className={`repo-tab${path === active ? " active" : ""}`}
            title={path}
            onClick={() => path !== active && onSelect(path)}
            onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && path !== active && onSelect(path)}
            onAuxClick={(e) => e.button === 1 && onClose(path)}
          >
            <span className="repo-tab-name">{labels[i]}</span>
            <button
              className="repo-tab-close"
              aria-label={`Close ${labels[i]}`}
              title="Close this tab (the folder stays as it is)"
              onClick={(e) => {
                e.stopPropagation();
                onClose(path);
              }}
            >
              ×
            </button>
          </div>
        ))}
      </div>
      <button className="icon-button repo-tab-add" aria-label="Add a repository" data-tip="Open another repository in a new tab" onClick={onAdd}>
        <PlusIcon />
      </button>
    </nav>
  );
}
