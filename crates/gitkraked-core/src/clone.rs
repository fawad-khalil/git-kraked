//! Cloning, with progress. Runs `git clone` so it signs in the same way as the user's
//! own `git` (see [`crate::sync`]).

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::time::Duration;

use serde::Serialize;

use crate::Result;
use crate::sync::{explain, git_command, spawn_error};

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CloneProgress {
    /// What git is doing, e.g. "Receiving objects".
    pub phase: String,
    /// The whole clone's progress, 0 to 100.
    pub percent: u8,
    /// Git's own figures for this phase, e.g. "450/1000, 1.20 MiB | 2.00 MiB/s".
    pub detail: String,
}

/// The phases git reports, with the share of the progress bar each one covers. Receiving
/// the objects is by far the slowest part of a clone.
const PHASES: [(&str, u8, u8); 5] = [
    ("Counting objects", 0, 2),
    ("Compressing objects", 2, 5),
    ("Receiving objects", 5, 85),
    ("Resolving deltas", 85, 95),
    ("Updating files", 95, 100),
];

/// Reads one progress line such as `remote: Counting objects:  50% (5/10)`.
fn parse_progress(line: &str) -> Option<CloneProgress> {
    let line = line.trim().trim_start_matches("remote:").trim();
    let (phase, rest) = line.split_once(':')?;
    let &(_, start, end) = PHASES.iter().find(|(name, ..)| *name == phase)?;
    let rest = rest.trim();
    let (number, detail) = rest.split_once('%')?;
    let phase_percent: u32 = number.trim().parse().ok()?;
    let detail = detail.trim().trim_end_matches(", done.").trim_start_matches('(');
    let detail = detail.replacen(')', "", 1);
    let percent = start as u32 + (end - start) as u32 * phase_percent.min(100) / 100;
    Some(CloneProgress { phase: phase.to_owned(), percent: percent as u8, detail })
}

/// Clones `url` into a new folder `name` inside `parent` and returns its path.
/// `on_progress` is called as git reports progress; setting `cancel` stops the clone
/// and removes the half-cloned folder.
pub fn clone_repo(
    url: &str,
    parent: impl AsRef<Path>,
    name: &str,
    cancel: &AtomicBool,
    mut on_progress: impl FnMut(CloneProgress),
) -> Result<PathBuf> {
    let url = url.trim();
    let name = name.trim();
    if url.is_empty() {
        return Err(git2::Error::from_str("enter the URL of the repository to clone").into());
    }
    if name.is_empty() || name.contains(['/', '\\']) || name == "." || name == ".." {
        return Err(git2::Error::from_str("enter a folder name without slashes").into());
    }
    let parent = parent.as_ref();
    if !parent.is_dir() {
        return Err(git2::Error::from_str(&format!("the folder '{}' doesn't exist", parent.display())).into());
    }
    let dest = parent.join(name);
    if dest.exists() {
        return Err(git2::Error::from_str(&format!(
            "'{}' already exists; choose another folder name",
            dest.display()
        ))
        .into());
    }

    let mut child = git_command(parent, &["clone", "--progress", "--", url, name])
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(spawn_error)?;

    // git rewrites progress lines in place with '\r', so split on both line endings.
    let mut stderr = child.stderr.take().expect("stderr is piped");
    let (lines_tx, lines) = mpsc::channel::<String>();
    let reader = std::thread::spawn(move || {
        let mut buffer = [0u8; 4096];
        let mut line = Vec::new();
        while let Ok(n) = stderr.read(&mut buffer) {
            if n == 0 {
                break;
            }
            for &byte in &buffer[..n] {
                if byte == b'\r' || byte == b'\n' {
                    if !line.is_empty() {
                        let _ = lines_tx.send(String::from_utf8_lossy(&line).into_owned());
                        line.clear();
                    }
                } else {
                    line.push(byte);
                }
            }
        }
        if !line.is_empty() {
            let _ = lines_tx.send(String::from_utf8_lossy(&line).into_owned());
        }
    });

    let mut messages = Vec::new();
    let mut cancelled = false;
    loop {
        match lines.recv_timeout(Duration::from_millis(100)) {
            Ok(line) => match parse_progress(&line) {
                Some(progress) => on_progress(progress),
                None => messages.push(line),
            },
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
        if !cancelled && cancel.load(Ordering::Relaxed) {
            cancelled = true;
            let _ = child.kill();
        }
    }
    let _ = reader.join();
    let status = child.wait().map_err(spawn_error)?;

    if cancelled || !status.success() {
        // git removes the folder itself when a clone fails, but not when it's killed.
        let _ = std::fs::remove_dir_all(&dest);
        let message = if cancelled {
            "the clone was cancelled".to_owned()
        } else {
            explain(&messages.join("\n"))
        };
        return Err(git2::Error::from_str(&message).into());
    }
    Ok(dest)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;
    use tempfile::TempDir;

    #[test]
    fn parses_progress_lines() {
        let p = parse_progress("Receiving objects:  50% (500/1000), 1.20 MiB | 2.00 MiB/s").unwrap();
        assert_eq!(p.phase, "Receiving objects");
        assert_eq!(p.percent, 45);
        assert_eq!(p.detail, "500/1000, 1.20 MiB | 2.00 MiB/s");

        let p = parse_progress("remote: Counting objects: 100% (10/10), done.").unwrap();
        assert_eq!((p.percent, p.detail.as_str()), (2, "10/10"));
        assert_eq!(parse_progress("Updating files: 100% (3/3), done.").unwrap().percent, 100);

        assert!(parse_progress("Cloning into 'x'...").is_none());
        assert!(parse_progress("remote: Enumerating objects: 12, done.").is_none());
    }

    fn source_repo(root: &Path) -> PathBuf {
        let source = root.join("source");
        std::fs::create_dir(&source).unwrap();
        for args in [
            &["init", "-q", "-b", "main"][..],
            &["-c", "user.name=Ada", "-c", "user.email=a@example.com", "commit", "-q", "--allow-empty", "-m", "first"],
        ] {
            assert!(Command::new("git").args(args).current_dir(&source).status().unwrap().success());
        }
        source
    }

    #[test]
    fn clones_into_a_new_folder() {
        let root = TempDir::new().unwrap();
        let source = source_repo(root.path());
        let cancel = AtomicBool::new(false);
        let path = clone_repo(source.to_str().unwrap(), root.path(), "copy", &cancel, |_| {}).unwrap();
        assert_eq!(path, root.path().join("copy"));
        assert_eq!(crate::open_repo(&path).unwrap().head_branch.as_deref(), Some("main"));

        let err = clone_repo(source.to_str().unwrap(), root.path(), "copy", &cancel, |_| {});
        assert!(err.unwrap_err().to_string().contains("already exists"));
    }

    #[test]
    fn a_failed_clone_leaves_nothing_behind() {
        let root = TempDir::new().unwrap();
        let cancel = AtomicBool::new(false);
        let missing = root.path().join("nope");
        assert!(clone_repo(missing.to_str().unwrap(), root.path(), "copy", &cancel, |_| {}).is_err());
        assert!(!root.path().join("copy").exists());
    }

    #[test]
    fn a_cancelled_clone_leaves_nothing_behind() {
        let root = TempDir::new().unwrap();
        let source = source_repo(root.path());
        let cancel = AtomicBool::new(true);
        let err = clone_repo(source.to_str().unwrap(), root.path(), "copy", &cancel, |_| {}).unwrap_err();
        // A tiny local clone can finish before the cancel lands; either way no half clone.
        if err.to_string().contains("cancelled") {
            assert!(!root.path().join("copy").exists());
        }
    }
}
