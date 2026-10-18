//! File changes: what a commit changed, what's changed in the working tree, staging
//! (whole files or single hunks), and committing.

use std::cell::Cell;
use std::path::Path;

use git2::{
    ApplyLocation, ApplyOptions, Delta, Diff, DiffFindOptions, DiffOptions, Patch, Repository,
    RepositoryState, Tree,
};
use serde::Serialize;

use crate::{CommitInfo, Result, commit_info, discover, lossy};

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "camelCase")]
pub enum ChangeKind {
    Added,
    Modified,
    Deleted,
    Renamed,
    Copied,
    TypeChanged,
    /// A new file Git isn't tracking yet.
    Untracked,
    Conflicted,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    pub path: String,
    /// The previous path, for renames and copies.
    pub old_path: Option<String>,
    pub kind: ChangeKind,
    pub additions: usize,
    pub deletions: usize,
    pub binary: bool,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum LineKind {
    Context,
    Added,
    Removed,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DiffLine {
    pub kind: LineKind,
    pub old_line: Option<u32>,
    pub new_line: Option<u32>,
    /// The line without its trailing newline.
    pub text: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DiffHunk {
    /// The `@@ -a,b +c,d @@ context` line.
    pub header: String,
    pub lines: Vec<DiffLine>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FileDiff {
    pub change: FileChange,
    pub hunks: Vec<DiffHunk>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CommitDetails {
    pub commit: CommitInfo,
    /// The whole message, summary included.
    pub message: String,
    pub committer_name: String,
    pub committer_time: i64,
    pub files: Vec<FileChange>,
}

/// Uncommitted changes, split the way the staging panel shows them.
#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkingStatus {
    pub staged: Vec<FileChange>,
    /// Changes not staged yet, untracked and conflicted files included.
    pub unstaged: Vec<FileChange>,
    /// True while a merge is waiting to be committed.
    pub merging: bool,
    /// True while a cherry-pick has stopped on conflicts.
    pub cherry_picking: bool,
}

/// What a commit changed relative to its first parent (or everything, for a root commit).
pub fn commit_details(path: impl AsRef<Path>, id: &str) -> Result<CommitDetails> {
    let repo = discover(path.as_ref())?;
    let commit = repo.find_commit(git2::Oid::from_str(id)?)?;
    let diff = commit_diff(&repo, &commit)?;
    let committer = commit.committer();
    Ok(CommitDetails {
        commit: commit_info(&commit),
        message: lossy(commit.message_bytes()).trim_end().to_owned(),
        committer_name: lossy(committer.name_bytes()),
        committer_time: committer.when().seconds(),
        files: file_changes(&diff)?,
    })
}

/// The diff of one file in a commit.
pub fn commit_file_diff(path: impl AsRef<Path>, id: &str, file: &str) -> Result<FileDiff> {
    let repo = discover(path.as_ref())?;
    let commit = repo.find_commit(git2::Oid::from_str(id)?)?;
    file_diff(&commit_diff(&repo, &commit)?, file)
}

fn commit_diff<'r>(repo: &'r Repository, commit: &git2::Commit) -> Result<Diff<'r>> {
    let parent_tree = match commit.parents().next() {
        Some(parent) => Some(parent.tree()?),
        None => None,
    };
    let mut diff = repo.diff_tree_to_tree(parent_tree.as_ref(), Some(&commit.tree()?), None)?;
    find_renames(&mut diff)?;
    Ok(diff)
}

pub fn working_status(path: impl AsRef<Path>) -> Result<WorkingStatus> {
    let repo = discover(path.as_ref())?;
    Ok(WorkingStatus {
        staged: file_changes(&staged_diff(&repo, None)?)?,
        unstaged: file_changes(&unstaged_diff(&repo, None)?)?,
        merging: repo.state() == RepositoryState::Merge,
        cherry_picking: matches!(repo.state(), RepositoryState::CherryPick | RepositoryState::CherryPickSequence),
    })
}

/// The diff of one uncommitted file: staged (HEAD to index) or unstaged (index to disk).
pub fn working_file_diff(path: impl AsRef<Path>, file: &str, staged: bool) -> Result<FileDiff> {
    let repo = discover(path.as_ref())?;
    let diff = if staged {
        staged_diff(&repo, None)?
    } else {
        unstaged_diff(&repo, Some(file))?
    };
    file_diff(&diff, file)
}

fn head_tree(repo: &Repository) -> Result<Option<Tree<'_>>> {
    match repo.head() {
        Ok(head) => Ok(Some(head.peel_to_tree()?)),
        Err(e) if e.code() == git2::ErrorCode::UnbornBranch => Ok(None),
        Err(e) => Err(e.into()),
    }
}

/// HEAD to index. Renames are detected, so this always covers every file.
fn staged_diff<'r>(repo: &'r Repository, opts: Option<&mut DiffOptions>) -> Result<Diff<'r>> {
    let mut diff = repo.diff_tree_to_index(head_tree(repo)?.as_ref(), None, opts)?;
    find_renames(&mut diff)?;
    Ok(diff)
}

/// Index to working tree, untracked files included with their content.
fn unstaged_diff<'r>(repo: &'r Repository, only: Option<&str>) -> Result<Diff<'r>> {
    let mut opts = DiffOptions::new();
    opts.include_untracked(true)
        .recurse_untracked_dirs(true)
        .show_untracked_content(true);
    if let Some(file) = only {
        // Literal match, so a file named `[draft].md` doesn't act as a pattern.
        opts.pathspec(file).disable_pathspec_match(true);
    }
    Ok(repo.diff_index_to_workdir(None, Some(&mut opts))?)
}

fn find_renames(diff: &mut Diff) -> Result<()> {
    diff.find_similar(Some(DiffFindOptions::new().renames(true)))?;
    Ok(())
}

fn change_of(patch: &Patch) -> Result<FileChange> {
    let delta = patch.delta();
    let kind = match delta.status() {
        Delta::Added => ChangeKind::Added,
        Delta::Deleted => ChangeKind::Deleted,
        Delta::Renamed => ChangeKind::Renamed,
        Delta::Copied => ChangeKind::Copied,
        Delta::Typechange => ChangeKind::TypeChanged,
        Delta::Untracked => ChangeKind::Untracked,
        Delta::Conflicted => ChangeKind::Conflicted,
        _ => ChangeKind::Modified,
    };
    let path_of = |f: git2::DiffFile| f.path_bytes().map(lossy).unwrap_or_default();
    let new_path = path_of(delta.new_file());
    let old_path = path_of(delta.old_file());
    let (_, additions, deletions) = patch.line_stats()?;
    Ok(FileChange {
        old_path: matches!(kind, ChangeKind::Renamed | ChangeKind::Copied).then_some(old_path.clone()),
        path: if kind == ChangeKind::Deleted { old_path } else { new_path },
        kind,
        additions,
        deletions,
        binary: delta.flags().is_binary(),
    })
}

fn file_changes(diff: &Diff) -> Result<Vec<FileChange>> {
    let mut changes = Vec::with_capacity(diff.deltas().len());
    for i in 0..diff.deltas().len() {
        if let Some(patch) = Patch::from_diff(diff, i)? {
            changes.push(change_of(&patch)?);
        }
    }
    Ok(changes)
}

fn file_diff(diff: &Diff, file: &str) -> Result<FileDiff> {
    for i in 0..diff.deltas().len() {
        let Some(patch) = Patch::from_diff(diff, i)? else {
            continue;
        };
        let change = change_of(&patch)?;
        if change.path != file {
            continue;
        }
        let mut hunks = Vec::with_capacity(patch.num_hunks());
        for h in 0..patch.num_hunks() {
            let (hunk, line_count) = patch.hunk(h)?;
            let mut lines = Vec::with_capacity(line_count);
            for l in 0..line_count {
                let line = patch.line_in_hunk(h, l)?;
                let kind = match line.origin() {
                    '+' => LineKind::Added,
                    '-' => LineKind::Removed,
                    ' ' => LineKind::Context,
                    // "\ No newline at end of file" markers.
                    _ => continue,
                };
                lines.push(DiffLine {
                    kind,
                    old_line: line.old_lineno(),
                    new_line: line.new_lineno(),
                    text: lossy(line.content()).trim_end_matches(['\n', '\r']).to_owned(),
                });
            }
            hunks.push(DiffHunk { header: lossy(hunk.header()).trim_end().to_owned(), lines });
        }
        return Ok(FileDiff { change, hunks });
    }
    Err(git2::Error::from_str(&format!("'{file}' has no changes here")).into())
}

/// Stages whole files, including deletions and untracked files.
pub fn stage_files(path: impl AsRef<Path>, files: &[String]) -> Result<()> {
    let repo = discover(path.as_ref())?;
    let workdir = workdir(&repo)?;
    let mut index = repo.index()?;
    for file in files {
        if workdir.join(file).symlink_metadata().is_ok() {
            index.add_path(Path::new(file))?;
        } else {
            index.remove_path(Path::new(file))?;
        }
    }
    index.write()?;
    Ok(())
}

/// Returns files to their HEAD state in the index, leaving the working tree alone.
pub fn unstage_files(path: impl AsRef<Path>, files: &[String]) -> Result<()> {
    let repo = discover(path.as_ref())?;
    match repo.head() {
        Ok(head) => repo.reset_default(Some(head.peel_to_commit()?.as_object()), files)?,
        // No commits yet: unstaging means removing from the index.
        Err(e) if e.code() == git2::ErrorCode::UnbornBranch => {
            let mut index = repo.index()?;
            for file in files {
                index.remove_path(Path::new(file))?;
            }
            index.write()?;
        }
        Err(e) => return Err(e.into()),
    }
    Ok(())
}

/// Stages one hunk of a file's unstaged changes. `hunk` indexes the hunks of
/// `working_file_diff(file, staged = false)`.
pub fn stage_hunk(path: impl AsRef<Path>, file: &str, hunk: usize) -> Result<()> {
    let repo = discover(path.as_ref())?;
    let diff = unstaged_diff(&repo, Some(file))?;
    // libgit2 can't apply an untracked file's diff to the index, but a new file is a
    // single hunk anyway, so staging that hunk is staging the file.
    if hunk == 0 && diff.deltas().any(|d| d.status() == Delta::Untracked) {
        return stage_files(path, &[file.to_owned()]);
    }
    apply_one_hunk(&repo, &diff, hunk)
}

/// Unstages one hunk of a file's staged changes. `hunk` indexes the hunks of
/// `working_file_diff(file, staged = true)`.
pub fn unstage_hunk(path: impl AsRef<Path>, file: &str, hunk: usize) -> Result<()> {
    let repo = discover(path.as_ref())?;
    // The staged diff reversed (index back to HEAD) has the same hunks in the same order.
    let mut opts = DiffOptions::new();
    opts.reverse(true).pathspec(file).disable_pathspec_match(true);
    let diff = repo.diff_tree_to_index(head_tree(&repo)?.as_ref(), None, Some(&mut opts))?;
    apply_one_hunk(&repo, &diff, hunk)
}

fn apply_one_hunk(repo: &Repository, diff: &Diff, wanted: usize) -> Result<()> {
    let seen = Cell::new(0);
    let mut opts = ApplyOptions::new();
    opts.hunk_callback(|_| {
        let index = seen.get();
        seen.set(index + 1);
        index == wanted
    });
    repo.apply(diff, ApplyLocation::Index, Some(&mut opts))?;
    if seen.get() <= wanted {
        return Err(git2::Error::from_str("that change is no longer there; refresh and try again").into());
    }
    Ok(())
}

/// Commits the index. With `amend`, replaces the HEAD commit instead (keeping its
/// author). Completes a pending merge with the merged commits as extra parents.
/// Returns the new commit's id. Git hooks are not run.
pub fn commit(path: impl AsRef<Path>, message: &str, amend: bool) -> Result<String> {
    let mut repo = discover(path.as_ref())?;
    if matches!(repo.state(), RepositoryState::CherryPick | RepositoryState::CherryPickSequence) {
        return Err(git2::Error::from_str(
            "a cherry-pick is in progress; stage the resolved files and press Continue cherry-pick",
        )
        .into());
    }
    let merging = repo.state() == RepositoryState::Merge;
    let mut merged = Vec::new();
    if merging {
        repo.mergehead_foreach(|oid| {
            merged.push(*oid);
            true
        })?;
    }

    let message = message.trim();
    if message.is_empty() {
        return Err(git2::Error::from_str("write a commit message first").into());
    }
    let signature = repo.signature().map_err(|_| {
        git2::Error::from_str(
            "Git doesn't know your name and email yet. Run: git config --global user.name \"Your Name\" \
             and git config --global user.email you@example.com",
        )
    })?;
    if !amend && !merging && staged_diff(&repo, None)?.deltas().len() == 0 {
        return Err(git2::Error::from_str("nothing is staged to commit").into());
    }

    let mut index = repo.index()?;
    if index.has_conflicts() {
        return Err(git2::Error::from_str("resolve the conflicted files before committing").into());
    }
    let tree = repo.find_tree(index.write_tree()?)?;
    let head = match repo.head() {
        Ok(head) => Some(head.peel_to_commit()?),
        Err(e) if e.code() == git2::ErrorCode::UnbornBranch => None,
        Err(e) => return Err(e.into()),
    };

    let id = if amend {
        let head = head.ok_or_else(|| git2::Error::from_str("there is no commit to amend yet"))?;
        head.amend(Some("HEAD"), None, Some(&signature), None, Some(message), Some(&tree))?
    } else {
        let mut parents: Vec<git2::Commit> = head.into_iter().collect();
        for oid in merged {
            parents.push(repo.find_commit(oid)?);
        }
        let parents = parents.iter().collect::<Vec<_>>();
        repo.commit(Some("HEAD"), &signature, &signature, message, &tree, &parents)?
    };

    if merging {
        repo.cleanup_state()?;
    }
    Ok(id.to_string())
}

fn workdir(repo: &Repository) -> Result<&Path> {
    repo.workdir()
        .ok_or_else(|| git2::Error::from_str("this is a bare repository with no working files").into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    /// A repo with one commit containing `a.txt` (five lines) and `gone.txt`.
    fn setup() -> (TempDir, Repository) {
        let dir = TempDir::new().unwrap();
        let repo = Repository::init(dir.path()).unwrap();
        let mut config = repo.config().unwrap();
        config.set_str("user.name", "Ada").unwrap();
        config.set_str("user.email", "ada@example.com").unwrap();
        fs::write(dir.path().join("a.txt"), "1\n2\n3\n4\n5\n").unwrap();
        fs::write(dir.path().join("gone.txt"), "bye\n").unwrap();
        stage_files(dir.path(), &["a.txt".into(), "gone.txt".into()]).unwrap();
        commit(dir.path(), "first", false).unwrap();
        (dir, repo)
    }

    fn summary(changes: &[FileChange]) -> Vec<(&str, ChangeKind)> {
        changes.iter().map(|c| (c.path.as_str(), c.kind)).collect()
    }

    #[test]
    fn reports_working_changes_and_stages_them() {
        let (dir, _repo) = setup();
        fs::write(dir.path().join("a.txt"), "1\n2\nthree\n4\n5\n").unwrap();
        fs::remove_file(dir.path().join("gone.txt")).unwrap();
        fs::create_dir(dir.path().join("new")).unwrap();
        fs::write(dir.path().join("new/b.txt"), "hello\n").unwrap();

        let status = working_status(dir.path()).unwrap();
        assert!(status.staged.is_empty());
        assert_eq!(
            summary(&status.unstaged),
            [
                ("a.txt", ChangeKind::Modified),
                ("gone.txt", ChangeKind::Deleted),
                ("new/b.txt", ChangeKind::Untracked),
            ]
        );
        assert_eq!((status.unstaged[0].additions, status.unstaged[0].deletions), (1, 1));

        stage_files(dir.path(), &["gone.txt".into(), "new/b.txt".into()]).unwrap();
        let status = working_status(dir.path()).unwrap();
        assert_eq!(
            summary(&status.staged),
            [("gone.txt", ChangeKind::Deleted), ("new/b.txt", ChangeKind::Added)]
        );
        assert_eq!(summary(&status.unstaged), [("a.txt", ChangeKind::Modified)]);

        unstage_files(dir.path(), &["gone.txt".into()]).unwrap();
        let status = working_status(dir.path()).unwrap();
        assert_eq!(summary(&status.staged), [("new/b.txt", ChangeKind::Added)]);
    }

    #[test]
    fn diffs_have_line_numbers() {
        let (dir, _repo) = setup();
        fs::write(dir.path().join("a.txt"), "1\n2\nthree\n4\n5\n").unwrap();
        let diff = working_file_diff(dir.path(), "a.txt", false).unwrap();
        assert_eq!(diff.hunks.len(), 1);
        let changed = diff.hunks[0]
            .lines
            .iter()
            .filter(|l| l.kind != LineKind::Context)
            .map(|l| (l.kind, l.old_line, l.new_line, l.text.as_str()))
            .collect::<Vec<_>>();
        assert_eq!(
            changed,
            [
                (LineKind::Removed, Some(3), None, "3"),
                (LineKind::Added, None, Some(3), "three"),
            ]
        );
        assert!(diff.hunks[0].header.starts_with("@@ -1,5 +1,5 @@"));
    }

    /// a.txt with two far-apart edits, which git splits into two hunks.
    fn two_hunks(dir: &Path) {
        let before = (1..=20).map(|n| format!("{n}\n")).collect::<String>();
        fs::write(dir.join("a.txt"), &before).unwrap();
        stage_files(dir, &["a.txt".into()]).unwrap();
        commit(dir, "twenty lines", false).unwrap();
        let after = (1..=20)
            .map(|n| match n {
                2 => "two\n".to_owned(),
                19 => "nineteen\n".to_owned(),
                n => format!("{n}\n"),
            })
            .collect::<String>();
        fs::write(dir.join("a.txt"), after).unwrap();
    }

    #[test]
    fn stages_and_unstages_single_hunks() {
        let (dir, _repo) = setup();
        two_hunks(dir.path());
        assert_eq!(working_file_diff(dir.path(), "a.txt", false).unwrap().hunks.len(), 2);

        stage_hunk(dir.path(), "a.txt", 1).unwrap();
        let staged = working_file_diff(dir.path(), "a.txt", true).unwrap();
        let unstaged = working_file_diff(dir.path(), "a.txt", false).unwrap();
        let added = |d: &FileDiff| {
            d.hunks
                .iter()
                .flat_map(|h| &h.lines)
                .filter(|l| l.kind == LineKind::Added)
                .map(|l| l.text.clone())
                .collect::<Vec<_>>()
        };
        assert_eq!(added(&staged), ["nineteen"]);
        assert_eq!(added(&unstaged), ["two"]);

        stage_hunk(dir.path(), "a.txt", 0).unwrap();
        assert_eq!(working_file_diff(dir.path(), "a.txt", true).unwrap().hunks.len(), 2);

        unstage_hunk(dir.path(), "a.txt", 0).unwrap();
        assert_eq!(added(&working_file_diff(dir.path(), "a.txt", true).unwrap()), ["nineteen"]);
        assert_eq!(added(&working_file_diff(dir.path(), "a.txt", false).unwrap()), ["two"]);
    }

    #[test]
    fn stages_an_untracked_file_by_hunk() {
        let (dir, _repo) = setup();
        fs::write(dir.path().join("new.txt"), "hello\n").unwrap();
        stage_hunk(dir.path(), "new.txt", 0).unwrap();
        let status = working_status(dir.path()).unwrap();
        assert_eq!(summary(&status.staged), [("new.txt", ChangeKind::Added)]);
        assert!(status.unstaged.is_empty());
    }

    #[test]
    fn stale_hunk_index_is_an_error() {
        let (dir, _repo) = setup();
        fs::write(dir.path().join("a.txt"), "1\n2\nthree\n4\n5\n").unwrap();
        assert!(stage_hunk(dir.path(), "a.txt", 3).is_err());
    }

    #[test]
    fn commits_amends_and_describes_commits() {
        let (dir, repo) = setup();
        fs::write(dir.path().join("a.txt"), "1\n2\nthree\n4\n5\n").unwrap();
        fs::rename(dir.path().join("gone.txt"), dir.path().join("moved.txt")).unwrap();
        assert!(commit(dir.path(), "nothing staged", false).is_err());

        stage_files(dir.path(), &["a.txt".into(), "gone.txt".into(), "moved.txt".into()]).unwrap();
        let id = commit(dir.path(), "second\n\nwith a body", false).unwrap();
        assert_eq!(repo.head().unwrap().peel_to_commit().unwrap().id().to_string(), id);

        let details = commit_details(dir.path(), &id).unwrap();
        assert_eq!(details.message, "second\n\nwith a body");
        assert_eq!(details.commit.summary, "second");
        let mut files = summary(&details.files);
        files.sort();
        assert_eq!(files, [("a.txt", ChangeKind::Modified), ("moved.txt", ChangeKind::Renamed)]);
        let renamed = details.files.iter().find(|f| f.path == "moved.txt").unwrap();
        assert_eq!(renamed.old_path.as_deref(), Some("gone.txt"));

        let diff = commit_file_diff(dir.path(), &id, "a.txt").unwrap();
        assert_eq!(diff.change.additions, 1);

        let amended = commit(dir.path(), "second, reworded", true).unwrap();
        let head = repo.head().unwrap().peel_to_commit().unwrap();
        assert_eq!(head.id().to_string(), amended);
        assert_eq!(head.summary().unwrap(), Some("second, reworded"));
        assert_eq!(head.parent_count(), 1);
    }

    #[test]
    fn root_commit_lists_every_file() {
        let (dir, repo) = setup();
        let root = repo.head().unwrap().peel_to_commit().unwrap().id().to_string();
        let details = commit_details(dir.path(), &root).unwrap();
        assert_eq!(
            summary(&details.files),
            [("a.txt", ChangeKind::Added), ("gone.txt", ChangeKind::Added)]
        );
    }

    #[test]
    fn rejects_empty_messages() {
        let (dir, _repo) = setup();
        fs::write(dir.path().join("a.txt"), "x\n").unwrap();
        stage_files(dir.path(), &["a.txt".into()]).unwrap();
        assert!(commit(dir.path(), "  \n", false).is_err());
    }
}
