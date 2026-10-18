//! Worktrees: extra working folders that share one repository, each with its own branch
//! checked out. Runs `git worktree`, which owns the bookkeeping under `.git/worktrees`.

use std::path::Path;

use serde::Serialize;

use crate::sync::git;
use crate::{Result, discover};

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Worktree {
    pub path: String,
    /// The checked-out branch, or `None` when the worktree is on a detached commit.
    pub branch: Option<String>,
    pub head: Option<String>,
    /// The repository's original working folder, which can't be removed.
    pub is_main: bool,
    /// The worktree this repository was opened from.
    pub is_current: bool,
    /// Why it's locked against removal and pruning, if it is ("" when no reason was given).
    pub locked: Option<String>,
    /// Its folder is gone; pruning tidies it away.
    pub missing: bool,
}

/// Reads `git worktree list --porcelain`: blocks of `key value` lines, one per worktree.
fn parse(output: &str, current: &Path) -> Vec<Worktree> {
    let current = std::fs::canonicalize(current).ok();
    output
        .split("\n\n")
        .filter_map(|block| {
            let mut worktree = Worktree {
                path: String::new(),
                branch: None,
                head: None,
                is_main: false,
                is_current: false,
                locked: None,
                missing: false,
            };
            for line in block.lines() {
                let (key, value) = line.split_once(' ').unwrap_or((line, ""));
                match key {
                    "worktree" => worktree.path = value.to_owned(),
                    "HEAD" => worktree.head = Some(value.to_owned()),
                    "branch" => worktree.branch = Some(value.trim_start_matches("refs/heads/").to_owned()),
                    "locked" => worktree.locked = Some(value.to_owned()),
                    "prunable" => worktree.missing = true,
                    _ => {}
                }
            }
            if worktree.path.is_empty() {
                return None;
            }
            let canonical = std::fs::canonicalize(&worktree.path).ok();
            worktree.missing |= canonical.is_none();
            worktree.is_current = canonical.is_some() && canonical == current;
            Some(worktree)
        })
        .enumerate()
        .map(|(i, worktree)| Worktree { is_main: i == 0, ..worktree })
        .collect()
}

pub fn list_worktrees(path: impl AsRef<Path>) -> Result<Vec<Worktree>> {
    let repo = discover(path.as_ref())?;
    let current = repo.workdir().unwrap_or_else(|| repo.path()).to_owned();
    Ok(parse(&git(&repo, &["worktree", "list", "--porcelain"])?, &current))
}

/// Adds a worktree at `dest` with `branch` checked out. With `new_branch`, `branch` is
/// created first from the current commit.
pub fn add_worktree(path: impl AsRef<Path>, dest: &str, branch: &str, new_branch: bool) -> Result<()> {
    let repo = discover(path.as_ref())?;
    let (dest, branch) = (dest.trim(), branch.trim());
    if dest.is_empty() || branch.is_empty() {
        return Err(git2::Error::from_str("choose a folder and a branch for the worktree").into());
    }
    if new_branch {
        git(&repo, &["worktree", "add", "-b", branch, "--", dest])?;
    } else {
        git(&repo, &["worktree", "add", "--", dest, branch])?;
    }
    Ok(())
}

/// Removes a worktree's folder and its bookkeeping. Without `force`, git refuses when it
/// has uncommitted changes.
pub fn remove_worktree(path: impl AsRef<Path>, worktree: &str, force: bool) -> Result<()> {
    let repo = discover(path.as_ref())?;
    let mut args = vec!["worktree", "remove"];
    if force {
        args.push("--force");
    }
    args.extend(["--", worktree]);
    git(&repo, &args)?;
    Ok(())
}

/// Forgets worktrees whose folders were deleted by hand.
pub fn prune_worktrees(path: impl AsRef<Path>) -> Result<()> {
    git(&discover(path.as_ref())?, &["worktree", "prune"])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{branches, changes};
    use std::fs;
    use tempfile::TempDir;

    fn setup() -> (TempDir, std::path::PathBuf) {
        let root = TempDir::new().unwrap();
        let main = root.path().join("main");
        fs::create_dir(&main).unwrap();
        let repo = git2::Repository::init_opts(&main, git2::RepositoryInitOptions::new().initial_head("main")).unwrap();
        let mut config = repo.config().unwrap();
        config.set_str("user.name", "Ada").unwrap();
        config.set_str("user.email", "ada@example.com").unwrap();
        fs::write(main.join("a.txt"), "a\n").unwrap();
        changes::stage_files(&main, &["a.txt".into()]).unwrap();
        changes::commit(&main, "first", false).unwrap();
        (root, main)
    }

    #[test]
    fn adds_lists_and_removes_worktrees() {
        let (root, main) = setup();
        let extra = root.path().join("feature-wt");
        add_worktree(&main, extra.to_str().unwrap(), "feature", true).unwrap();
        branches::create_branch(&main, "other", None, false).unwrap();
        let other = root.path().join("other-wt");
        add_worktree(&main, other.to_str().unwrap(), "other", false).unwrap();

        let list = list_worktrees(&main).unwrap();
        assert_eq!(list.len(), 3);
        assert!(list[0].is_main && list[0].is_current);
        assert_eq!(list[0].branch.as_deref(), Some("main"));
        assert_eq!(list[1].branch.as_deref(), Some("feature"));
        assert!(!list[1].is_current && !list[1].missing);
        assert!(extra.join("a.txt").exists());

        // Seen from the extra worktree, that one is current.
        let from_extra = list_worktrees(&extra).unwrap();
        assert!(from_extra.iter().find(|w| w.branch.as_deref() == Some("feature")).unwrap().is_current);

        // A dirty worktree needs force.
        fs::write(extra.join("a.txt"), "edited\n").unwrap();
        assert!(remove_worktree(&main, extra.to_str().unwrap(), false).is_err());
        remove_worktree(&main, extra.to_str().unwrap(), true).unwrap();
        assert!(!extra.exists());
        assert_eq!(list_worktrees(&main).unwrap().len(), 2);
    }

    #[test]
    fn a_deleted_folder_shows_as_missing_until_pruned() {
        let (root, main) = setup();
        let extra = root.path().join("gone");
        add_worktree(&main, extra.to_str().unwrap(), "gone", true).unwrap();
        fs::remove_dir_all(&extra).unwrap();
        assert!(list_worktrees(&main).unwrap()[1].missing);
        prune_worktrees(&main).unwrap();
        assert_eq!(list_worktrees(&main).unwrap().len(), 1);
    }

    #[test]
    fn a_branch_checked_out_elsewhere_cant_get_a_second_worktree() {
        let (root, main) = setup();
        let err = add_worktree(&main, root.path().join("dup").to_str().unwrap(), "main", false).unwrap_err();
        assert!(err.to_string().contains("main"), "{err}");

        add_worktree(&main, root.path().join("t").to_str().unwrap(), "topic", true).unwrap();
        fs::write(root.path().join("t/new.txt"), "x\n").unwrap();
        changes::stage_files(root.path().join("t"), &["new.txt".into()]).unwrap();
        changes::commit(root.path().join("t"), "on topic", false).unwrap();
        let err = branches::checkout_branch(&main, "topic").unwrap_err();
        assert!(err.to_string().contains("already checked out"), "{err}");
        assert!(!main.join("new.txt").exists(), "files were left untouched");
        // And the other way round, from the linked worktree.
        let err = branches::checkout_branch(root.path().join("t"), "main").unwrap_err();
        assert!(err.to_string().contains("already checked out"), "{err}");
    }
}
