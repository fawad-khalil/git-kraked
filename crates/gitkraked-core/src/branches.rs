//! Branches: listing, creating, checking out, renaming, deleting and merging.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use git2::{BranchType, MergeAnalysis, Oid, Repository, build::CheckoutBuilder};
use serde::Serialize;

use crate::ancestry::Ancestry;
use crate::{Result, discover, lossy};

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LocalBranch {
    pub name: String,
    pub is_head: bool,
    pub target: String,
    /// The remote branch it tracks, e.g. `origin/main`.
    pub upstream: Option<String>,
    /// Commits this branch has that its upstream doesn't.
    pub ahead: usize,
    /// Commits its upstream has that this branch doesn't.
    pub behind: usize,
    /// The branch this one was started from, which "Pull from parent" brings in. See
    /// [`parent_branch`].
    pub parent: Option<String>,
    /// Commits this branch has that its parent doesn't.
    pub parent_ahead: usize,
    /// Commits its parent has that this branch doesn't yet: what "Pull from parent" brings in.
    pub parent_behind: usize,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteBranch {
    /// Full short name, e.g. `origin/feature/x`.
    pub name: String,
    pub remote: String,
    /// The name without the remote, e.g. `feature/x`.
    pub branch: String,
    pub target: String,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Branches {
    pub local: Vec<LocalBranch>,
    pub remote: Vec<RemoteBranch>,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum MergeResult {
    /// Nothing to merge.
    UpToDate,
    /// The current branch was moved forward; no merge commit needed.
    FastForward,
    /// A merge commit was created.
    Merged,
    /// The merge stopped on conflicts; resolve them, stage, and commit to finish.
    Conflicts,
}

pub fn list_branches(path: impl AsRef<Path>) -> Result<Branches> {
    let repo = discover(path.as_ref())?;
    let mut branches = Branches::default();
    let lineage = Lineage::read(&repo)?;
    let head = repo.head().ok().filter(|h| h.is_branch()).map(|h| lossy(h.shorthand_bytes()));

    for (name, tip, upstream) in &lineage.local {
        let (ahead, behind) = upstream
            .as_deref()
            .and_then(|u| lineage.ancestry.ahead_behind(name, u))
            .unwrap_or((0, 0));
        let parent = lineage.parent(&repo, name);
        let (parent_ahead, parent_behind) = parent
            .as_deref()
            .and_then(|p| lineage.ancestry.ahead_behind(name, p))
            .unwrap_or((0, 0));
        branches.local.push(LocalBranch {
            parent,
            parent_ahead,
            parent_behind,
            name: name.clone(),
            is_head: head.as_deref() == Some(name.as_str()),
            target: tip.to_string(),
            upstream: upstream.clone(),
            ahead,
            behind,
        });
    }

    for item in repo.branches(Some(BranchType::Remote))? {
        let (branch, _) = item?;
        // origin/HEAD is a symbolic pointer, not a branch of its own.
        let Some(target) = branch.get().target() else {
            continue;
        };
        let name = lossy(branch.name_bytes()?);
        let remote = remote_of(&repo, &lossy(branch.get().name_bytes()));
        let short = name.strip_prefix(&format!("{remote}/")).unwrap_or(&name).to_owned();
        branches.remote.push(RemoteBranch { name, remote, branch: short, target: target.to_string() });
    }

    branches.local.sort_by(|a, b| a.name.cmp(&b.name));
    branches.remote.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(branches)
}

/// Creates a branch at `from` (a commit id; HEAD when `None`) and optionally checks it out.
pub fn create_branch(path: impl AsRef<Path>, name: &str, from: Option<&str>, checkout: bool) -> Result<()> {
    let repo = discover(path.as_ref())?;
    let commit = match from {
        Some(id) => repo.find_commit(Oid::from_str(id)?)?,
        None => repo.head()?.peel_to_commit()?,
    };
    repo.branch(name, &commit, false)?;
    if from.is_none() {
        // Started from the current branch: remember it as the parent, preferring the remote
        // branch it tracks so "Pull from parent" brings in other people's work too.
        let head = repo.head()?;
        if head.is_branch() {
            let current = lossy(head.shorthand_bytes());
            let parent = repo
                .find_branch(&current, BranchType::Local)?
                .upstream()
                .ok()
                .and_then(|u| u.name_bytes().ok().map(lossy))
                .unwrap_or(current);
            set_parent(&repo, name, &parent)?;
        }
    }
    if checkout {
        checkout_local(&repo, name)?;
    }
    Ok(())
}

/// Checks out a local branch. Refuses, like `git checkout`, if uncommitted changes would
/// be overwritten.
/// The folder of another worktree that has `refname` checked out, if any.
fn worktree_with_branch(repo: &Repository, refname: &str) -> Result<Option<String>> {
    for name in repo.worktrees()?.iter().filter_map(|n| n.ok().flatten()) {
        let Ok(worktree) = repo.find_worktree(name) else { continue };
        let Ok(other) = Repository::open_from_worktree(&worktree) else { continue };
        let head = other.find_reference("HEAD")?;
        if head.symbolic_target_bytes() == Some(refname.as_bytes()) && other.path() != repo.path() {
            return Ok(Some(worktree.path().display().to_string()));
        }
    }
    // A linked worktree also can't take the branch of the main working folder.
    if repo.is_worktree() {
        let common = repo.commondir();
        if let Ok(main) = Repository::open(common) {
            let head = main.find_reference("HEAD")?;
            if head.symbolic_target_bytes() == Some(refname.as_bytes()) {
                let folder = main.workdir().unwrap_or(common).display().to_string();
                return Ok(Some(folder));
            }
        }
    }
    Ok(None)
}

fn parent_key(branch: &str) -> String {
    format!("branch.{branch}.gitkrakedParent")
}

fn set_parent(repo: &Repository, branch: &str, parent: &str) -> Result<()> {
    repo.config()?.set_str(&parent_key(branch), parent)?;
    Ok(())
}

/// Records `parent` (a local or remote branch name) as the parent of `branch`.
pub fn set_parent_branch(path: impl AsRef<Path>, branch: &str, parent: &str) -> Result<()> {
    let repo = discover(path.as_ref())?;
    if !branch_exists(&repo, parent) {
        return Err(git2::Error::from_str(&format!("there's no branch called {parent}")).into());
    }
    set_parent(&repo, branch, parent)
}

/// The remote a remote-tracking ref such as `refs/remotes/origin/x` belongs to. Falls back
/// to the first path segment when no configured remote claims it (e.g. the remote was
/// removed but its branches are still there), so one stale ref can't break the branch list.
pub(crate) fn remote_of(repo: &Repository, refname: &str) -> String {
    repo.branch_remote_name(refname).map(|r| lossy(&r)).unwrap_or_else(|_| {
        let rest = refname.strip_prefix("refs/remotes/").unwrap_or(refname);
        rest.split('/').next().unwrap_or(rest).to_owned()
    })
}

fn branch_target(repo: &Repository, name: &str) -> Option<Oid> {
    repo.find_branch(name, BranchType::Local)
        .or_else(|_| repo.find_branch(name, BranchType::Remote))
        .ok()?
        .get()
        .target()
}

fn branch_exists(repo: &Repository, name: &str) -> bool {
    repo.find_branch(name, BranchType::Local).is_ok() || repo.find_branch(name, BranchType::Remote).is_ok()
}

/// Long-lived branches that other branches start from.
const TRUNKS: [&str; 5] = ["main", "master", "develop", "development", "trunk"];

/// Whether `name` (local, or remote like `origin/main`) is a long-lived trunk branch.
fn is_trunk(name: &str) -> bool {
    let short = name.rsplit_once('/').map_or(name, |(_, b)| b);
    TRUNKS.contains(&short)
}

/// The branch `branch` was started from. Git doesn't record this, so it's, in order:
/// 1. the parent saved when GitKraked created the branch, or that the user picked;
/// 2. what Git's reflog says the branch was created from, while it still has that entry;
/// 3. for a topic branch, the nearest branch it grew out of: the one whose history it
///    shares most of, so the fewest of its commits are its own;
/// 4. the remote's default branch (`origin/HEAD`), otherwise main or master.
///
/// A branch is never its own parent, and its own upstream isn't one either: that's what
/// plain Pull is for.
pub fn parent_branch(repo: &Repository, branch: &str) -> Option<String> {
    let lineage = Lineage::read(repo).ok()?;
    lineage.parent(repo, branch)
}

/// Everything parent detection and ahead/behind counts need, read once per branch list.
struct Lineage {
    /// Local branches: name, tip and upstream.
    local: Vec<(String, Oid, Option<String>)>,
    /// Parents known without guessing (saved or from the reflog), by branch.
    explicit: HashMap<String, String>,
    default: Option<String>,
    remote_trunks: Vec<String>,
    ancestry: Arc<Ancestry>,
}

/// The last ancestry computed for each repository, reused while no branch has moved, so
/// refreshing after a checkout doesn't walk history again.
type CachedAncestry = (PathBuf, Vec<(String, Oid)>, Arc<Ancestry>);
static ANCESTRY_CACHE: Mutex<Vec<CachedAncestry>> = Mutex::new(Vec::new());

impl Lineage {
    fn read(repo: &Repository) -> Result<Lineage> {
        let mut local = Vec::new();
        for item in repo.branches(Some(BranchType::Local))? {
            let (branch, _) = item?;
            let Some(tip) = branch.get().target() else { continue };
            let upstream = branch.upstream().ok().and_then(|u| u.name_bytes().ok().map(lossy));
            local.push((lossy(branch.name_bytes()?), tip, upstream));
        }
        let default = remote_default(repo);
        let mut remote_trunks = Vec::new();
        for item in repo.branches(Some(BranchType::Remote))? {
            let (branch, _) = item?;
            if branch.get().target().is_none() {
                continue;
            }
            let name = lossy(branch.name_bytes()?);
            if is_trunk(&name) || Some(&name) == default.as_ref() {
                remote_trunks.push(name);
            }
        }

        let head_moves = head_checkouts(repo);
        let mut explicit = HashMap::new();
        for (name, _, upstream) in &local {
            let usable = |p: &str| p != name && Some(p) != upstream.as_deref() && branch_exists(repo, p);
            let saved = repo.config().and_then(|c| c.get_string(&parent_key(name))).ok();
            if let Some(parent) = saved.filter(|p| usable(p)).or_else(|| {
                reflog_parent(repo, name, &head_moves).filter(|p| usable(p))
            }) {
                explicit.insert(name.clone(), parent);
            }
        }

        // Tips to compare: every local branch, the branches they track, remote trunks and
        // explicit parents (which may be remote branches).
        let mut names: Vec<String> = local.iter().map(|(n, ..)| n.clone()).collect();
        names.extend(local.iter().filter_map(|(_, _, u)| u.clone()));
        names.extend(remote_trunks.iter().cloned());
        names.extend(explicit.values().cloned());
        names.extend(["main", "master"].map(String::from));
        names.sort();
        names.dedup();
        let tips: Vec<(String, Oid)> =
            names.into_iter().filter_map(|n| branch_target(repo, &n).map(|oid| (n, oid))).collect();

        let key = repo.path().to_path_buf();
        let cached = ANCESTRY_CACHE
            .lock()
            .unwrap()
            .iter()
            .find(|(path, t, _)| *path == key && *t == tips)
            .map(|(.., a)| a.clone());
        let ancestry = match cached {
            Some(a) => a,
            None => {
                let a = Arc::new(Ancestry::compute(repo, &tips)?);
                let mut cache = ANCESTRY_CACHE.lock().unwrap();
                cache.retain(|(path, ..)| *path != key);
                cache.push((key, tips, a.clone()));
                // Keep a handful of repositories at most.
                if cache.len() > 8 {
                    cache.remove(0);
                }
                a
            }
        };

        Ok(Lineage { local, explicit, default, remote_trunks, ancestry })
    }

    fn parent(&self, repo: &Repository, branch: &str) -> Option<String> {
        if let Some(parent) = self.explicit.get(branch) {
            return Some(parent.clone());
        }
        let upstream = self.local.iter().find(|(n, ..)| n == branch).and_then(|(_, _, u)| u.as_deref());
        let usable = |name: &str| name != branch && Some(name) != upstream && branch_exists(repo, name);
        if !is_trunk(branch)
            && let Some(nearest) = self.nearest(branch, upstream)
        {
            return Some(nearest);
        }
        let mut fallbacks = Vec::new();
        fallbacks.extend(self.default.clone());
        fallbacks.extend(["origin/main", "origin/master", "main", "master"].map(String::from));
        fallbacks.into_iter().find(|c| usable(c))
    }

    /// The branch `branch` most likely grew out of. Candidates are the other local
    /// branches and the remote trunks. The winner leaves the fewest commits that are only
    /// on `branch`; ties go to trunks, then local branches, then the one `branch` is least
    /// behind. A topic branch that already contains all of `branch` is a child of it, not
    /// a parent.
    fn nearest(&self, branch: &str, upstream: Option<&str>) -> Option<String> {
        let candidates = self
            .local
            .iter()
            .map(|(n, ..)| (n.as_str(), false))
            .chain(self.remote_trunks.iter().map(|n| (n.as_str(), true)));
        let mut best: Option<((usize, u8, usize), String)> = None;
        for (name, remote) in candidates {
            if name == branch || Some(name) == upstream {
                continue;
            }
            let trunk = is_trunk(name) || Some(name) == self.default.as_deref();
            let Some((ahead, behind)) = self.ancestry.ahead_behind(branch, name) else { continue };
            if ahead == 0 && !trunk {
                continue;
            }
            let rank = match (trunk, remote) {
                (true, _) => 0,
                (false, false) => 1,
                (false, true) => 2,
            };
            let score = (ahead, rank, behind);
            if best.as_ref().is_none_or(|(b, _)| score < *b) {
                best = Some((score, name.to_owned()));
            }
        }
        best.map(|(_, name)| name)
    }
}

/// HEAD's reflog checkouts as `(from, to)`, oldest first. Read once and shared, since a
/// long-lived repository's HEAD log can hold many thousands of entries.
fn head_checkouts(repo: &Repository) -> Vec<(String, String)> {
    let Ok(head) = repo.reflog("HEAD") else { return Vec::new() };
    let mut moves: Vec<(String, String)> = head
        .iter()
        .filter_map(|entry| {
            let message = entry.message_bytes().map(lossy)?;
            let (from, to) = message.strip_prefix("checkout: moving from ")?.split_once(" to ")?;
            Some((from.to_owned(), to.to_owned()))
        })
        .collect();
    moves.reverse();
    moves
}

/// The branch `branch` was created from according to the reflogs: its own first entry
/// (`branch: Created from main`), or, when that only says HEAD, the checkout that created
/// it (`checkout: moving from main to topic`).
fn reflog_parent(repo: &Repository, branch: &str, head_moves: &[(String, String)]) -> Option<String> {
    let is_commit_id = |name: &str| name.len() >= 7 && name.chars().all(|c| c.is_ascii_hexdigit());
    let clean = |name: &str| {
        let name = name.trim();
        let name = name.strip_prefix("refs/heads/").or_else(|| name.strip_prefix("refs/remotes/")).unwrap_or(name);
        (!name.is_empty() && name != "HEAD" && !is_commit_id(name)).then(|| name.to_owned())
    };

    let own = repo.reflog(&format!("refs/heads/{branch}")).ok()?;
    let first = own.iter().next_back()?;
    let message = first.message_bytes().map(lossy).unwrap_or_default();
    // Without this entry the branch wasn't made by `git branch` (e.g. a clone or a
    // rename made it), and the reflog can't tell.
    let from = message.strip_prefix("branch: Created from ")?;
    if let Some(name) = clean(from) {
        return Some(name);
    }
    let (from, _) = head_moves.iter().find(|(_, to)| to == branch)?;
    clean(from)
}

/// `origin/HEAD`'s target, e.g. `origin/main`.
fn remote_default(repo: &Repository) -> Option<String> {
    let remote_head = repo.find_reference("refs/remotes/origin/HEAD").ok()?;
    let target = remote_head.symbolic_target_bytes()?;
    Some(lossy(target).trim_start_matches("refs/remotes/").to_owned())
}

pub fn checkout_branch(path: impl AsRef<Path>, name: &str) -> Result<()> {
    checkout_local(&discover(path.as_ref())?, name)
}

fn checkout_local(repo: &Repository, name: &str) -> Result<()> {
    let branch = repo.find_branch(name, BranchType::Local)?;
    let refname = lossy(branch.get().name_bytes());
    // Checked before touching any files: libgit2 only refuses at the very end, after the
    // working folder already holds the other branch's files.
    if let Some(elsewhere) = worktree_with_branch(repo, &refname)? {
        return Err(git2::Error::from_str(&format!(
            "{name} is already checked out in the worktree at {elsewhere}; open that worktree instead"
        ))
        .into());
    }
    let tree = branch.get().peel_to_tree()?;
    checkout_safely(repo, tree.as_object(), name)?;
    repo.set_head(&refname)?;
    Ok(())
}

/// Writes `object`'s files into the working folder, refusing like `git checkout` when
/// uncommitted changes would be overwritten. `name` is what the error calls the target.
pub(crate) fn checkout_safely(repo: &Repository, object: &git2::Object, name: &str) -> Result<()> {
    repo.checkout_tree(object, Some(CheckoutBuilder::new().safe())).map_err(|e| {
        if e.code() == git2::ErrorCode::Conflict {
            git2::Error::from_str(&format!(
                "can't switch to {name}: you have uncommitted changes that it would overwrite. \
                 Commit or stash them first."
            ))
        } else {
            e
        }
    })?;
    Ok(())
}

/// Checks out a remote branch such as `origin/feature` as a local `feature` that tracks
/// it, reusing the local branch if one with that name already exists.
pub fn checkout_remote_branch(path: impl AsRef<Path>, remote_name: &str) -> Result<String> {
    let repo = discover(path.as_ref())?;
    let remote = repo.find_branch(remote_name, BranchType::Remote)?;
    let remote_ref = lossy(remote.get().name_bytes());
    let remote_prefix = remote_of(&repo, &remote_ref);
    let local_name = remote_name
        .strip_prefix(&format!("{remote_prefix}/"))
        .unwrap_or(remote_name)
        .to_owned();

    if repo.find_branch(&local_name, BranchType::Local).is_err() {
        let commit = remote.get().peel_to_commit()?;
        let mut local = repo.branch(&local_name, &commit, false)?;
        local.set_upstream(Some(remote_name))?;
    }
    checkout_local(&repo, &local_name)?;
    Ok(local_name)
}

pub fn rename_branch(path: impl AsRef<Path>, name: &str, new_name: &str) -> Result<()> {
    let repo = discover(path.as_ref())?;
    repo.find_branch(name, BranchType::Local)?.rename(new_name, false)?;
    Ok(())
}

/// Deletes a local branch. Without `force`, refuses when the branch has commits that
/// aren't on the current branch or its upstream, so work can't be lost by accident.
pub fn delete_branch(path: impl AsRef<Path>, name: &str, force: bool) -> Result<()> {
    let repo = discover(path.as_ref())?;
    let mut branch = repo.find_branch(name, BranchType::Local)?;
    if branch.is_head() {
        return Err(git2::Error::from_str("can't delete the branch you're on; check out another first").into());
    }
    if !force {
        let tip = branch.get().target().ok_or_else(|| git2::Error::from_str("branch has no target"))?;
        let mut safe_tips = Vec::new();
        if let Ok(head) = repo.head()
            && let Some(id) = head.target()
        {
            safe_tips.push(id);
        }
        if let Some(id) = branch.upstream().ok().and_then(|u| u.get().target()) {
            safe_tips.push(id);
        }
        let merged = safe_tips
            .iter()
            .any(|&safe| safe == tip || repo.graph_descendant_of(safe, tip).unwrap_or(false));
        if !merged {
            return Err(git2::Error::from_str(&format!(
                "{name} has commits that aren't merged anywhere else; deleting it would lose them"
            ))
            .into());
        }
    }
    branch.delete()?;
    Ok(())
}

/// Merges a branch (local or remote, e.g. `feature` or `origin/main`) into the current one.
pub fn merge_branch(path: impl AsRef<Path>, name: &str) -> Result<MergeResult> {
    let repo = discover(path.as_ref())?;
    let reference = repo
        .find_branch(name, BranchType::Local)
        .or_else(|_| repo.find_branch(name, BranchType::Remote))?
        .into_reference();
    let theirs = repo.reference_to_annotated_commit(&reference)?;

    let mut head = repo.head()?;
    if !head.is_branch() {
        return Err(git2::Error::from_str("check out a branch before merging into it").into());
    }
    let (analysis, _) = repo.merge_analysis(&[&theirs])?;

    if analysis.contains(MergeAnalysis::ANALYSIS_UP_TO_DATE) {
        return Ok(MergeResult::UpToDate);
    }

    let has_staged = {
        let head_tree = head.peel_to_tree()?;
        repo.diff_tree_to_index(Some(&head_tree), None, None)?.deltas().len() > 0
    };
    if has_staged {
        return Err(git2::Error::from_str("commit or unstage your staged changes before merging").into());
    }

    if analysis.contains(MergeAnalysis::ANALYSIS_FASTFORWARD) {
        let target = repo.find_commit(theirs.id())?;
        repo.checkout_tree(target.as_object(), Some(CheckoutBuilder::new().safe()))?;
        head.set_target(theirs.id(), &format!("merge {name}: fast-forward"))?;
        return Ok(MergeResult::FastForward);
    }

    repo.merge(&[&theirs], None, Some(CheckoutBuilder::new().safe().allow_conflicts(true)))?;
    let mut index = repo.index()?;
    if index.has_conflicts() {
        return Ok(MergeResult::Conflicts);
    }

    let signature = repo.signature()?;
    let tree = repo.find_tree(index.write_tree()?)?;
    let ours = head.peel_to_commit()?;
    let theirs_commit = repo.find_commit(theirs.id())?;
    let current = lossy(head.shorthand_bytes());
    let message = format!("Merge branch '{name}' into {current}");
    repo.commit(Some("HEAD"), &signature, &signature, &message, &tree, &[&ours, &theirs_commit])?;
    repo.cleanup_state()?;
    Ok(MergeResult::Merged)
}

/// Abandons an in-progress merge, putting files back as they were at HEAD. Changes
/// made while resolving conflicts are lost.
pub fn abort_merge(path: impl AsRef<Path>) -> Result<()> {
    let repo = discover(path.as_ref())?;
    let head = repo.head()?.peel_to_commit()?;
    repo.reset(head.as_object(), git2::ResetType::Hard, None)?;
    repo.cleanup_state()?;
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Side {
    /// The current branch's version.
    Ours,
    /// The merged branch's version.
    Theirs,
}

/// Resolves a conflicted file by taking one side's version whole, and stages it.
pub fn resolve_conflict(path: impl AsRef<Path>, file: &str, side: Side) -> Result<()> {
    let repo = discover(path.as_ref())?;
    let workdir = repo
        .workdir()
        .ok_or_else(|| git2::Error::from_str("bare repository"))?
        .to_path_buf();
    let mut index = repo.index()?;
    let conflict = index
        .conflicts()?
        .filter_map(|c| c.ok())
        .find(|c| {
            [&c.our, &c.their, &c.ancestor]
                .into_iter()
                .flatten()
                .any(|e| e.path == file.as_bytes())
        })
        .ok_or_else(|| git2::Error::from_str(&format!("{file} isn't conflicted")))?;
    let entry = match side {
        Side::Ours => conflict.our,
        Side::Theirs => conflict.their,
    };
    let target = workdir.join(file);
    match entry {
        Some(entry) => {
            let blob = repo.find_blob(entry.id)?;
            std::fs::write(&target, blob.content())
                .map_err(|e| git2::Error::from_str(&format!("couldn't write {file}: {e}")))?;
            index.add_path(Path::new(file))?;
        }
        // That side deleted the file.
        None => {
            if target.exists() {
                std::fs::remove_file(&target)
                    .map_err(|e| git2::Error::from_str(&format!("couldn't delete {file}: {e}")))?;
            }
            index.remove_path(Path::new(file))?;
        }
    }
    index.write()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::changes::{self, ChangeKind};
    use std::fs;
    use tempfile::TempDir;

    fn setup() -> (TempDir, Repository) {
        let dir = TempDir::new().unwrap();
        let repo = Repository::init_opts(
            dir.path(),
            git2::RepositoryInitOptions::new().initial_head("main"),
        )
        .unwrap();
        let mut config = repo.config().unwrap();
        config.set_str("user.name", "Ada").unwrap();
        config.set_str("user.email", "ada@example.com").unwrap();
        write_commit(dir.path(), "a.txt", "base\n", "base");
        (dir, repo)
    }

    fn write_commit(dir: &Path, file: &str, content: &str, message: &str) -> String {
        fs::write(dir.join(file), content).unwrap();
        changes::stage_files(dir, &[file.to_owned()]).unwrap();
        changes::commit(dir, message, false).unwrap()
    }

    fn head_name(repo: &Repository) -> String {
        repo.head().unwrap().shorthand().unwrap().to_owned()
    }

    #[test]
    fn new_branches_remember_their_parent() {
        let (dir, repo) = setup();
        // A repo without remotes falls back to main.
        create_branch(dir.path(), "topic", None, true).unwrap();
        assert_eq!(parent_branch(&repo, "topic").as_deref(), Some("main"));
        create_branch(dir.path(), "sub", None, true).unwrap();
        assert_eq!(parent_branch(&repo, "sub").as_deref(), Some("topic"));
        // main has no parent of its own.
        assert_eq!(parent_branch(&repo, "main"), None);

        set_parent_branch(dir.path(), "sub", "main").unwrap();
        assert_eq!(parent_branch(&repo, "sub").as_deref(), Some("main"));
        assert!(set_parent_branch(dir.path(), "sub", "missing").is_err());
        let listed = list_branches(dir.path()).unwrap();
        assert_eq!(listed.local.iter().find(|b| b.name == "sub").unwrap().parent.as_deref(), Some("main"));
    }

    #[test]
    fn finds_the_nearest_parent_of_branches_made_elsewhere() {
        // main ── m1 ── m2
        //    \
        //     feature ── f1 ── f2
        //                        \
        //                         sub ── s1
        // Made with git2 directly, which saves no parent and leaves no useful reflog.
        let (dir, repo) = setup();
        let main_tip = repo.head().unwrap().peel_to_commit().unwrap();
        repo.branch("feature", &main_tip, false).unwrap();
        write_commit(dir.path(), "m.txt", "m1\n", "m1");
        write_commit(dir.path(), "m.txt", "m2\n", "m2");
        checkout_branch(dir.path(), "feature").unwrap();
        write_commit(dir.path(), "f.txt", "f1\n", "f1");
        write_commit(dir.path(), "f.txt", "f2\n", "f2");
        let f2 = repo.head().unwrap().peel_to_commit().unwrap();
        repo.branch("sub", &f2, false).unwrap();
        checkout_branch(dir.path(), "sub").unwrap();
        write_commit(dir.path(), "s.txt", "s1\n", "s1");

        assert_eq!(parent_branch(&repo, "sub").as_deref(), Some("feature"));
        assert_eq!(parent_branch(&repo, "feature").as_deref(), Some("main"));
        assert_eq!(parent_branch(&repo, "main"), None);

        let listed = list_branches(dir.path()).unwrap();
        let sub = listed.local.iter().find(|b| b.name == "sub").unwrap();
        assert_eq!((sub.parent_ahead, sub.parent_behind), (1, 0));
        let feature = listed.local.iter().find(|b| b.name == "feature").unwrap();
        // feature has f1 and f2; main has m1 and m2 that feature lacks.
        assert_eq!((feature.parent_ahead, feature.parent_behind), (2, 2));
    }

    #[test]
    fn reads_the_parent_from_gits_reflog() {
        let (dir, repo) = setup();
        let git = |args: &[&str]| {
            let out = std::process::Command::new("git").args(args).current_dir(dir.path()).output().unwrap();
            assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        };
        git(&["branch", "release"]);
        // `git branch x from` records the start point...
        git(&["branch", "hotfix", "release"]);
        assert_eq!(reflog_parent(&repo, "hotfix", &head_checkouts(&repo)).as_deref(), Some("release"));
        // ...`checkout -b` records HEAD, so the checkout entry names the branch left behind.
        git(&["checkout", "-q", "release"]);
        git(&["checkout", "-q", "-b", "fix"]);
        assert_eq!(reflog_parent(&repo, "fix", &head_checkouts(&repo)).as_deref(), Some("release"));
        assert_eq!(parent_branch(&repo, "fix").as_deref(), Some("release"));
    }

    #[test]
    fn creates_checks_out_renames_and_deletes() {
        let (dir, repo) = setup();
        create_branch(dir.path(), "topic", None, true).unwrap();
        assert_eq!(head_name(&repo), "topic");
        write_commit(dir.path(), "b.txt", "b\n", "on topic");

        checkout_branch(dir.path(), "main").unwrap();
        assert!(!dir.path().join("b.txt").exists());

        // Unmerged work is protected unless forced.
        assert!(delete_branch(dir.path(), "topic", false).is_err());
        rename_branch(dir.path(), "topic", "renamed").unwrap();
        let names = list_branches(dir.path())
            .unwrap()
            .local
            .into_iter()
            .map(|b| (b.name, b.is_head))
            .collect::<Vec<_>>();
        assert_eq!(names, [("main".to_owned(), true), ("renamed".to_owned(), false)]);
        delete_branch(dir.path(), "renamed", true).unwrap();
        assert!(delete_branch(dir.path(), "main", true).is_err(), "can't delete the current branch");
    }

    #[test]
    fn checkout_refuses_to_overwrite_local_changes() {
        let (dir, _repo) = setup();
        create_branch(dir.path(), "topic", None, true).unwrap();
        write_commit(dir.path(), "a.txt", "topic\n", "change a");
        checkout_branch(dir.path(), "main").unwrap();
        fs::write(dir.path().join("a.txt"), "local edit\n").unwrap();
        let err = checkout_branch(dir.path(), "topic").unwrap_err().to_string();
        assert!(err.contains("uncommitted changes"), "{err}");
        assert_eq!(fs::read_to_string(dir.path().join("a.txt")).unwrap(), "local edit\n");
    }

    #[test]
    fn fast_forwards_and_merges() {
        let (dir, repo) = setup();
        create_branch(dir.path(), "ff", None, false).unwrap();
        checkout_branch(dir.path(), "ff").unwrap();
        let tip = write_commit(dir.path(), "b.txt", "b\n", "on ff");
        checkout_branch(dir.path(), "main").unwrap();

        assert_eq!(merge_branch(dir.path(), "ff").unwrap(), MergeResult::FastForward);
        assert_eq!(repo.head().unwrap().target().unwrap().to_string(), tip);
        assert!(dir.path().join("b.txt").exists());
        assert_eq!(merge_branch(dir.path(), "ff").unwrap(), MergeResult::UpToDate);
        delete_branch(dir.path(), "ff", false).unwrap();

        create_branch(dir.path(), "side", None, true).unwrap();
        write_commit(dir.path(), "c.txt", "c\n", "on side");
        checkout_branch(dir.path(), "main").unwrap();
        write_commit(dir.path(), "d.txt", "d\n", "on main");
        assert_eq!(merge_branch(dir.path(), "side").unwrap(), MergeResult::Merged);
        let head = repo.head().unwrap().peel_to_commit().unwrap();
        assert_eq!(head.parent_count(), 2);
        assert_eq!(head.summary().unwrap(), Some("Merge branch 'side' into main"));
        assert!(dir.path().join("c.txt").exists());
    }

    #[test]
    fn conflicts_resolve_by_side_and_commit_finishes_the_merge() {
        let (dir, repo) = setup();
        create_branch(dir.path(), "side", None, true).unwrap();
        write_commit(dir.path(), "a.txt", "theirs\n", "side edit");
        checkout_branch(dir.path(), "main").unwrap();
        write_commit(dir.path(), "a.txt", "ours\n", "main edit");

        assert_eq!(merge_branch(dir.path(), "side").unwrap(), MergeResult::Conflicts);
        let status = changes::working_status(dir.path()).unwrap();
        assert!(status.merging);
        assert!(status.unstaged.iter().any(|f| f.path == "a.txt" && f.kind == ChangeKind::Conflicted));
        assert!(changes::commit(dir.path(), "too early", false).is_err());

        resolve_conflict(dir.path(), "a.txt", Side::Theirs).unwrap();
        assert_eq!(fs::read_to_string(dir.path().join("a.txt")).unwrap(), "theirs\n");
        changes::commit(dir.path(), "Merge side", false).unwrap();
        assert_eq!(repo.head().unwrap().peel_to_commit().unwrap().parent_count(), 2);
        assert!(!changes::working_status(dir.path()).unwrap().merging);
    }

    #[test]
    fn abort_merge_restores_head() {
        let (dir, _repo) = setup();
        create_branch(dir.path(), "side", None, true).unwrap();
        write_commit(dir.path(), "a.txt", "theirs\n", "side edit");
        checkout_branch(dir.path(), "main").unwrap();
        write_commit(dir.path(), "a.txt", "ours\n", "main edit");
        merge_branch(dir.path(), "side").unwrap();

        abort_merge(dir.path()).unwrap();
        let status = changes::working_status(dir.path()).unwrap();
        assert!(!status.merging);
        assert!(status.unstaged.is_empty() && status.staged.is_empty());
        assert_eq!(fs::read_to_string(dir.path().join("a.txt")).unwrap(), "ours\n");
    }

    #[test]
    fn tracks_remote_branches_with_ahead_behind() {
        let (dir, repo) = setup();
        let base = repo.head().unwrap().target().unwrap();
        let remote_tip = write_commit(dir.path(), "r.txt", "r\n", "remote work");
        // Pretend origin has the newer commit and main is one behind it.
        repo.reference("refs/remotes/origin/main", Oid::from_str(&remote_tip).unwrap(), true, "")
            .unwrap();
        repo.reference("refs/remotes/origin/feature", Oid::from_str(&remote_tip).unwrap(), true, "")
            .unwrap();
        repo.remote("origin", "https://example.com/repo.git").unwrap();
        repo.head().unwrap().set_target(base, "rewind").unwrap();
        repo.checkout_head(Some(CheckoutBuilder::new().force())).unwrap();
        repo.find_branch("main", BranchType::Local)
            .unwrap()
            .set_upstream(Some("origin/main"))
            .unwrap();

        let branches = list_branches(dir.path()).unwrap();
        let main = &branches.local[0];
        assert_eq!((main.upstream.as_deref(), main.ahead, main.behind), (Some("origin/main"), 0, 1));
        assert_eq!(
            branches.remote.iter().map(|r| (r.remote.as_str(), r.branch.as_str())).collect::<Vec<_>>(),
            [("origin", "feature"), ("origin", "main")]
        );

        assert_eq!(checkout_remote_branch(dir.path(), "origin/feature").unwrap(), "feature");
        assert_eq!(head_name(&repo), "feature");
        let feature = list_branches(dir.path())
            .unwrap()
            .local
            .into_iter()
            .find(|b| b.name == "feature")
            .unwrap();
        assert_eq!(feature.upstream.as_deref(), Some("origin/feature"));
    }
}
