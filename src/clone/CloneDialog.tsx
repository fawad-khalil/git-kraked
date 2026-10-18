import { FormEvent, useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { CloneProgress, asCommandError, cancelClone, cloneRepo, onCloneProgress } from "../api";
import { repoNameFromUrl } from "../format";

const PARENT_KEY = "gitkraked.cloneParent";

function savedParent(): string {
  try {
    return localStorage.getItem(PARENT_KEY) ?? "";
  } catch {
    return "";
  }
}

interface Props {
  onCloned: (path: string) => void;
  onClose: () => void;
}

export function CloneDialog({ onCloned, onClose }: Props) {
  const [url, setUrl] = useState("");
  const [parent, setParent] = useState(savedParent);
  const [name, setName] = useState("");
  // The name follows the URL until the user types their own.
  const [nameEdited, setNameEdited] = useState(false);
  const [progress, setProgress] = useState<CloneProgress | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!nameEdited) setName(repoNameFromUrl(url));
  }, [url, nameEdited]);

  useEffect(() => {
    const unlisten = onCloneProgress(setProgress);
    return () => {
      unlisten.then((stop) => stop());
    };
  }, []);

  async function browse() {
    const picked = await open({ directory: true, title: "Clone into this folder", defaultPath: parent || undefined });
    if (typeof picked === "string") setParent(picked);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setRunning(true);
    setError(null);
    setProgress(null);
    try {
      const path = await cloneRepo(url, parent, name);
      try {
        localStorage.setItem(PARENT_KEY, parent);
      } catch {
        // Only a convenience.
      }
      onCloned(path);
    } catch (err) {
      setError(asCommandError(err).message);
    } finally {
      setRunning(false);
    }
  }

  const sep = parent.includes("\\") ? "\\" : "/";
  const target = parent && name ? `${parent.replace(/[\\/]+$/, "")}${sep}${name}` : "";

  return (
    <div className="overlay">
      <form className="dialog" onSubmit={submit}>
        <h2>Clone a repository</h2>
        <label>
          URL
          <input
            autoFocus
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://github.com/owner/repo.git"
            disabled={running}
            spellCheck={false}
          />
        </label>
        <label>
          Into folder
          <span className="row">
            <input value={parent} onChange={(e) => setParent(e.target.value)} disabled={running} spellCheck={false} />
            <button type="button" onClick={browse} disabled={running}>
              Browse…
            </button>
          </span>
        </label>
        <label>
          Name
          <input
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setNameEdited(true);
            }}
            disabled={running}
            spellCheck={false}
          />
        </label>
        {target && <p className="muted dialog-hint">Clones into {target}</p>}

        {running && (
          <div className="progress">
            <div className="progress-track">
              <div className="progress-fill" style={{ width: `${progress?.percent ?? 0}%` }} />
            </div>
            <p className="muted dialog-hint">
              {progress ? `${progress.phase}: ${progress.detail}` : "Connecting…"}
            </p>
          </div>
        )}
        {error && <p className="error-text">{error}</p>}

        <div className="dialog-actions">
          {running ? (
            <button type="button" onClick={() => cancelClone()}>
              Cancel
            </button>
          ) : (
            <button type="button" onClick={onClose}>
              Close
            </button>
          )}
          <button type="submit" className="primary" disabled={running || !url.trim() || !parent.trim() || !name.trim()}>
            Clone
          </button>
        </div>
      </form>
    </div>
  );
}
