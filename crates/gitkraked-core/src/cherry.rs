//! Cherry-picking: copying commits from another branch onto the current one. Runs
//! `git cherry-pick`, which owns the sequence of picks and the in-progress state.

use std::path::Path;

use git2::{Oid, RepositoryState};
use serde::Serialize;

use crate::sync::git;
use crate::{CommitInfo, Result, commit_info, discover, lossy};

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PickCandidate {
    pub commit: CommitInfo,
    /// The current branch already has an equivalent change (e.g. it was picked before).
    pub already_applied: bool,
}

/// Commits on `branch` that the current branch doesn't have, newest first, at most `limit`.
/// Uses `git cherry`, which also spots commits whose change was already copied over.
pub fn pick_candidates(path: impl AsRef<Path>, branch: &str, limit: usize) -> Result<Vec<PickCandidate>> {
    let repo = discover(path.as_ref())?;
    let output = git(&repo, &["cherry", "HEAD", branch])?;
    // `git cherry` lists oldest first: "+ <id>" for new changes, "- <id>" for applied ones.
    let mut candidates = output
        .lines()
        .rev()
        .filter_map(|line| {
            let (mark, id) = line.split_once(' ')?;
            let commit = repo.find_commit(Oid::from_str(id.trim()).ok()?).ok()?;
            Some(PickCandidate { commit: commit_info(&commit), already_applied: mark == "-" })
        })
        .collect::<Vec<_>>();
    candidates.truncate(limit);
    Ok(candidates)
}

/// Copies `ids` onto the current branch, oldest first whatever order they're given in.
/// When a pick conflicts, the cherry-pick stays in progress so the user can resolve it and
/// continue, or abort.
pub fn cherry_pick(path: impl AsRef<Path>, ids: &[String]) -> Result<String> {
    let repo = discover(path.as_ref())?;
    if ids.is_empty() {
        return Err(git2::Error::from_str("choose at least one commit to cherry-pick").into());
    }
    if repo.state() != RepositoryState::Clean {
        return Err(git2::Error::from_str("finish or abort the merge or cherry-pick in progress first").into());
    }
    let mut commits = ids
        .iter()
        .map(|id| Ok(repo.find_commit(Oid::from_str(id)?)?))
        .collect::<Result<Vec<_>>>()?;
    commits.sort_by_key(|c| (c.committer().when().seconds(), c.time().seconds()));
    let args = ["cherry-pick".to_owned()]
        .into_iter()
        .chain(commits.iter().map(|c| c.id().to_string()))
        .collect::<Vec<_>>();
    let args = args.iter().map(String::as_str).collect::<Vec<_>>();
    match git(&repo, &args) {
        Ok(_) => Ok(format!(
            "Cherry-picked {} {}.",
            commits.len(),
            if commits.len() == 1 { "commit" } else { "commits" }
        )),
        Err(e) => Err(stopped(&repo, e)),
    }
}

/// Explains why a cherry-pick stopped, undoing it when there's nothing the user could fix.
fn stopped(repo: &git2::Repository, error: crate::Error) -> crate::Error {
    if repo.state() != RepositoryState::CherryPick && repo.state() != RepositoryState::CherryPickSequence {
        return error;
    }
    let conflicts = repo.index().map(|i| i.has_conflicts()).unwrap_or(false);
    if conflicts {
        let pick = repo
            .find_reference("CHERRY_PICK_HEAD")
            .ok()
            .and_then(|r| r.peel_to_commit().ok())
            .map(|c| format!(" at \"{}\"", lossy(c.summary_bytes().unwrap_or_default())))
            .unwrap_or_default();
        return git2::Error::from_str(&format!(
            "The cherry-pick hit conflicts{pick}. Resolve them under Working changes, then press \
             Continue cherry-pick, or abort it."
        ))
        .into();
    }
    // Stopped without conflicts: usually a pick whose change the branch already has.
    let _ = git(repo, &["cherry-pick", "--abort"]);
    git2::Error::from_str(&format!("The cherry-pick stopped, so nothing was changed.\n\n{error}")).into()
}

/// Commits the resolved pick and carries on with any remaining ones.
pub fn continue_cherry_pick(path: impl AsRef<Path>) -> Result<String> {
    let repo = discover(path.as_ref())?;
    if repo.index()?.has_conflicts() {
        return Err(git2::Error::from_str("some files still have conflicts; resolve and stage them first").into());
    }
    match git(&repo, &["cherry-pick", "--continue"]) {
        Ok(_) => Ok("Finished the cherry-pick.".to_owned()),
        Err(e) => Err(stopped(&repo, e)),
    }
}

/// Puts the branch and files back to how they were before the cherry-pick started.
pub fn abort_cherry_pick(path: impl AsRef<Path>) -> Result<()> {
    git(&discover(path.as_ref())?, &["cherry-pick", "--abort"])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{branches, changes};
    use std::fs;
    use tempfile::TempDir;

    fn setup() -> TempDir {
        let dir = TempDir::new().unwrap();
        let repo = git2::Repository::init_opts(dir.path(), git2::RepositoryInitOptions::new().initial_head("main")).unwrap();
        let mut config = repo.config().unwrap();
        config.set_str("user.name", "Ada").unwrap();
        config.set_str("user.email", "ada@example.com").unwrap();
        // Keep checkouts byte-for-byte: Git for Windows turns on autocrlf system-wide.
        config.set_bool("core.autocrlf", false).unwrap();
        write(dir.path(), "a.txt", "base\n", "base");
        dir
    }

    fn write(dir: &Path, file: &str, content: &str, message: &str) -> String {
        fs::write(dir.join(file), content).unwrap();
        changes::stage_files(dir, &[file.to_owned()]).unwrap();
        changes::commit(dir, message, false).unwrap()
    }

    fn summaries(dir: &Path, branch: &str) -> Vec<(String, bool)> {
        pick_candidates(dir, branch, 50)
            .unwrap()
            .into_iter()
            .map(|c| (c.commit.summary, c.already_applied))
            .collect()
    }

    #[test]
    fn picks_commits_from_another_branch_in_order() {
        let dir = setup();
        branches::create_branch(dir.path(), "feature", None, true).unwrap();
        let one = write(dir.path(), "b.txt", "b\n", "add b");
        let two = write(dir.path(), "c.txt", "c\n", "add c");
        write(dir.path(), "d.txt", "d\n", "add d");
        branches::checkout_branch(dir.path(), "main").unwrap();

        assert_eq!(
            summaries(dir.path(), "feature"),
            [("add d".into(), false), ("add c".into(), false), ("add b".into(), false)]
        );
        // Given newest first, still applied oldest first.
        cherry_pick(dir.path(), &[two, one]).unwrap();
        assert!(dir.path().join("b.txt").exists() && dir.path().join("c.txt").exists());
        assert!(!dir.path().join("d.txt").exists());
        // The picked ones now show as already applied.
        assert_eq!(
            summaries(dir.path(), "feature"),
            [("add d".into(), false), ("add c".into(), true), ("add b".into(), true)]
        );
    }

    #[test]
    fn a_conflict_can_be_resolved_and_continued_or_aborted() {
        let dir = setup();
        branches::create_branch(dir.path(), "feature", None, true).unwrap();
        let theirs = write(dir.path(), "a.txt", "theirs\n", "change a");
        branches::checkout_branch(dir.path(), "main").unwrap();
        let before = write(dir.path(), "a.txt", "ours\n", "ours");

        let err = cherry_pick(dir.path(), std::slice::from_ref(&theirs)).unwrap_err().to_string();
        assert!(err.contains("conflicts at \"change a\""), "{err}");
        assert!(changes::working_status(dir.path()).unwrap().cherry_picking);

        abort_cherry_pick(dir.path()).unwrap();
        let repo = git2::Repository::open(dir.path()).unwrap();
        assert_eq!(repo.head().unwrap().target().unwrap().to_string(), before);
        assert_eq!(fs::read_to_string(dir.path().join("a.txt")).unwrap(), "ours\n");

        assert!(cherry_pick(dir.path(), std::slice::from_ref(&theirs)).is_err());
        branches::resolve_conflict(dir.path(), "a.txt", branches::Side::Theirs).unwrap();
        continue_cherry_pick(dir.path()).unwrap();
        assert_eq!(fs::read_to_string(dir.path().join("a.txt")).unwrap(), "theirs\n");
        let head = repo.head().unwrap().peel_to_commit().unwrap();
        assert_eq!(head.summary().unwrap(), Some("change a"));
        assert_eq!(repo.state(), RepositoryState::Clean);
    }
}
