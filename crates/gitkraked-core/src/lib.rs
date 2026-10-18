//! Git operations for GitKraked.
//!
//! This crate knows nothing about Tauri or the UI, so every operation can be
//! unit-tested against a throwaway repository.

mod ancestry;
pub mod branches;
pub mod changes;
pub mod cherry;
pub mod clone;
pub mod graph;
pub mod identity;
pub mod remotes;
pub mod stash;
pub mod sync;
pub mod tags;
pub mod worktrees;

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use git2::{BranchType, Repository, Sort};
use serde::Serialize;

use graph::GraphRow;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// Git's `safe.directory` protection: the repo belongs to another user. This is what
    /// happens when opening a repo inside WSL from Windows. [`trust_repo`] resolves it.
    #[error("Git won't open '{path}' because it belongs to another user (common for WSL repos)")]
    NotOwned { path: String },
    /// Git doesn't know the user's name and email, so it can't record who made a commit.
    /// [`identity::set_identity`] resolves it.
    #[error("Git doesn't know your name and email yet, and it records them in every commit")]
    NoIdentity,
    /// Fetch, pull or push in a repository with no remote. [`remotes::add_remote`] resolves it.
    #[error("this repository has no remote yet, so there's nothing to fetch from or push to")]
    NoRemote,
    /// Git couldn't sign in to the remote; `detail` is git's own message.
    #[error("Git couldn't sign in to the remote.\n\n{detail}")]
    SignIn { detail: String },
    #[error("{0}")]
    Git(#[from] git2::Error),
}

pub type Result<T> = std::result::Result<T, Error>;

/// What the app shows right after opening a repository.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RepoSummary {
    /// The working directory (or the git dir for a bare repo).
    pub path: PathBuf,
    /// Short name of the checked-out branch; `None` when HEAD is detached or unborn.
    pub head_branch: Option<String>,
    /// Full id of the commit HEAD points to; `None` in a repo with no commits.
    pub head_commit: Option<String>,
    pub local_branches: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CommitInfo {
    pub id: String,
    pub short_id: String,
    pub summary: String,
    pub author_name: String,
    pub author_email: String,
    /// Author time in seconds since the Unix epoch.
    pub time: i64,
    pub parent_ids: Vec<String>,
}

/// Opens the repository containing `path`, searching parent directories like `git` does.
pub fn open_repo(path: impl AsRef<Path>) -> Result<RepoSummary> {
    let repo = discover(path.as_ref())?;
    summarize(&repo)
}

/// Creates an empty repository in `path` (made if missing), like `git init`, and opens it.
/// A folder that already is a repository is opened as it is, not re-initialised. The first
/// branch is named by Git's `init.defaultBranch` setting.
pub fn init_repo(path: impl AsRef<Path>) -> Result<RepoSummary> {
    let path = path.as_ref();
    if let Ok(repo) = Repository::open(path) {
        return summarize(&repo);
    }
    std::fs::create_dir_all(path).map_err(|e| git2::Error::from_str(&format!("can't create {}: {e}", path.display())))?;
    summarize(&Repository::init(path)?)
}

pub(crate) fn discover(path: &Path) -> Result<Repository> {
    Repository::discover(path).map_err(|e| match e.code() {
        git2::ErrorCode::Owner => Error::NotOwned {
            path: safe_directory_value(path).unwrap_or_else(|_| path.display().to_string()),
        },
        _ => e.into(),
    })
}

/// Marks the repository containing `path` as safe by adding it to `safe.directory` in the
/// user's global Git config, the same fix `git` itself suggests. Returns the value added.
pub fn trust_repo(path: impl AsRef<Path>) -> Result<String> {
    let config_path = global_config_path()?;
    let value = safe_directory_value(path.as_ref())?;
    add_safe_directory(&config_path, &value)?;
    Ok(value)
}

/// The user's global Git config file, `~/.gitconfig` when there isn't one yet.
pub(crate) fn global_config_path() -> Result<PathBuf> {
    match git2::Config::find_global() {
        Ok(p) => Ok(p),
        // No ~/.gitconfig yet; create it where git would look for it.
        Err(_) => Ok(home_dir()
            .ok_or_else(|| git2::Error::from_str("could not find your home folder"))?
            .join(".gitconfig")),
    }
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
}

/// The `safe.directory` entry for the repo containing `path`: its working directory with
/// forward slashes and no trailing slash, which is the form libgit2 compares against.
/// UNC paths such as `//wsl.localhost/...` get git's `%(prefix)/` escape, which both
/// libgit2 and Git for Windows accept.
fn safe_directory_value(path: &Path) -> Result<String> {
    let git_dir = Repository::discover_path(path, std::iter::empty::<&std::ffi::OsStr>())?;
    let git_dir = git_dir.to_string_lossy().replace('\\', "/");
    let git_dir = git_dir.trim_end_matches('/');
    // A normal checkout's git dir is `<workdir>/.git`; a bare repo is its own key.
    let key = git_dir.strip_suffix("/.git").unwrap_or(git_dir);
    Ok(if key.starts_with("//") {
        format!("%(prefix)/{key}")
    } else {
        key.to_owned()
    })
}

fn add_safe_directory(config_path: &Path, value: &str) -> Result<()> {
    let mut config = git2::Config::open(config_path)?;
    // set_multivar replaces entries matching the regex, so matching the value itself
    // adds it once and leaves every other safe.directory entry alone.
    config.set_multivar("safe.directory", &format!("^{}$", regex_escape(value)), value)?;
    Ok(())
}

fn regex_escape(s: &str) -> String {
    s.chars()
        .flat_map(|c| {
            let special = "\\.^$|?*+()[]{}".contains(c);
            special.then_some('\\').into_iter().chain([c])
        })
        .collect()
}

/// Git stores names and messages as bytes; show invalid UTF-8 rather than failing.
pub(crate) fn lossy(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

fn summarize(repo: &Repository) -> Result<RepoSummary> {
    let path = repo.workdir().unwrap_or_else(|| repo.path()).to_path_buf();

    let (head_branch, head_commit) = match repo.head() {
        Ok(head) => {
            let branch = if head.is_branch() {
                Some(lossy(head.shorthand_bytes()))
            } else {
                None
            };
            let commit = head.peel_to_commit().ok().map(|c| c.id().to_string());
            (branch, commit)
        }
        // An unborn branch (fresh `git init`) has no HEAD commit yet.
        Err(e) if e.code() == git2::ErrorCode::UnbornBranch => (None, None),
        Err(e) => return Err(e.into()),
    };

    let mut local_branches = repo
        .branches(Some(BranchType::Local))?
        .filter_map(|b| b.ok())
        .filter_map(|(b, _)| b.name_bytes().ok().map(lossy))
        .collect::<Vec<_>>();
    local_branches.sort();

    Ok(RepoSummary {
        path,
        head_branch,
        head_commit,
        local_branches,
    })
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum RefKind {
    LocalBranch,
    RemoteBranch,
    Tag,
    /// HEAD when it isn't on a branch.
    DetachedHead,
    /// A stash, labelled on the commit it was made on top of.
    Stash,
}

/// A branch or tag label drawn next to a commit in the graph.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RefLabel {
    /// Short name, e.g. `main`, `origin/main`, `v1.0`.
    pub name: String,
    pub kind: RefKind,
    /// True for the checked-out branch.
    pub is_head: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HistoryRow {
    pub commit: CommitInfo,
    pub graph: GraphRow,
    pub refs: Vec<RefLabel>,
}

#[derive(Debug, Clone, Default)]
pub struct History {
    pub rows: Vec<HistoryRow>,
    /// Width of the graph in columns, so the UI can size it once.
    pub columns: usize,
}

impl History {
    /// Updates the labels after refs moved without new commits, e.g. after a checkout,
    /// which is far quicker than walking history again. Returns false, changing nothing,
    /// when a label points at a commit that isn't loaded; then reload with [`load_history`].
    pub fn relabel(&mut self, path: impl AsRef<Path>) -> Result<bool> {
        let repo = discover(path.as_ref())?;
        let mut labels = all_labels(&repo, path.as_ref())?;
        let rows: HashMap<&str, usize> =
            self.rows.iter().enumerate().map(|(i, r)| (r.commit.id.as_str(), i)).collect();
        if !labels.keys().all(|id| rows.contains_key(id.as_str())) {
            return Ok(false);
        }
        for row in &mut self.rows {
            row.refs = labels.remove(&row.commit.id).unwrap_or_default();
        }
        Ok(true)
    }

    /// Indexes of the rows whose message summary, author or commit id contains `query`,
    /// ignoring case. Every word in `query` has to match somewhere.
    pub fn filter(&self, query: &str) -> Vec<usize> {
        let words: Vec<String> = query.split_whitespace().map(str::to_lowercase).collect();
        if words.is_empty() {
            return (0..self.rows.len()).collect();
        }
        self.rows
            .iter()
            .enumerate()
            .filter(|(_, row)| {
                let c = &row.commit;
                let haystack = format!("{}\n{}\n{}", c.summary, c.author_name, c.author_email).to_lowercase();
                words.iter().all(|w| haystack.contains(w.as_str()) || c.id.starts_with(w.as_str()))
            })
            .map(|(i, _)| i)
            .collect()
    }
}

pub(crate) fn commit_info(commit: &git2::Commit) -> CommitInfo {
    let author = commit.author();
    let id = commit.id().to_string();
    CommitInfo {
        // A fixed-length prefix; asking libgit2 for a unique one costs a lookup per commit.
        short_id: id[..7].to_owned(),
        id,
        summary: commit.summary_bytes().map(lossy).unwrap_or_default(),
        author_name: lossy(author.name_bytes()),
        author_email: lossy(author.email_bytes()),
        time: author.when().seconds(),
        parent_ids: commit.parent_ids().map(|p| p.to_string()).collect(),
    }
}

/// Loads up to `limit` commits reachable from HEAD, local branches and remote branches,
/// newest first in topological order, with their graph layout and ref labels.
pub fn load_history(path: impl AsRef<Path>, limit: usize) -> Result<History> {
    let repo = discover(path.as_ref())?;
    let mut walk = repo.revwalk()?;
    // Newest first by date, never a parent before its child: what people expect to see.
    walk.set_sorting(Sort::TOPOLOGICAL | Sort::TIME)?;

    if repo.head().is_ok() {
        walk.push_head()?;
    }
    walk.push_glob("refs/heads/*")?;
    walk.push_glob("refs/remotes/*")?;
    // Tags of trees or blobs are skipped by libgit2's glob push.
    walk.push_glob("refs/tags/*")?;

    let commits = walk
        .take(limit)
        .map(|oid| Ok(commit_info(&repo.find_commit(oid?)?)))
        .collect::<Result<Vec<_>>>()?;

    let graph = graph::layout(
        &commits
            .iter()
            .map(|c| (c.id.as_str(), c.parent_ids.iter().map(String::as_str).collect()))
            .collect::<Vec<_>>(),
    );
    let columns = graph
        .iter()
        .flat_map(|g| g.edges.iter().map(|e| e.from.max(e.to)).chain([g.column]))
        .max()
        .map_or(0, |c| c + 1);

    let mut labels = all_labels(&repo, path.as_ref())?;
    let rows = commits
        .into_iter()
        .zip(graph)
        .map(|(commit, graph)| HistoryRow {
            refs: labels.remove(&commit.id).unwrap_or_default(),
            commit,
            graph,
        })
        .collect();

    Ok(History { rows, columns })
}

/// Branch and tag labels keyed by the commit id they point at.
/// Branch, tag, HEAD and stash labels by commit id.
fn all_labels(repo: &Repository, path: &Path) -> Result<HashMap<String, Vec<RefLabel>>> {
    let mut labels = ref_labels(repo)?;
    for entry in stash::list_stashes(path)? {
        labels.entry(entry.base.clone()).or_default().push(RefLabel {
            name: stash::stash_label(&entry),
            kind: RefKind::Stash,
            is_head: false,
        });
    }
    Ok(labels)
}

fn ref_labels(repo: &Repository) -> Result<HashMap<String, Vec<RefLabel>>> {
    let head = repo.head().ok();
    let head_name = head.as_ref().filter(|h| h.is_branch()).map(|h| h.name_bytes().to_vec());
    let mut labels: HashMap<String, Vec<RefLabel>> = HashMap::new();

    if let Some(head) = head.as_ref().filter(|h| !h.is_branch())
        && let Ok(commit) = head.peel_to_commit()
    {
        labels.entry(commit.id().to_string()).or_default().push(RefLabel {
            name: "HEAD".to_owned(),
            kind: RefKind::DetachedHead,
            is_head: true,
        });
    }

    for reference in repo.references()? {
        let reference = reference?;
        // Skip symbolic refs such as origin/HEAD; their target has its own label.
        if reference.kind() != Some(git2::ReferenceType::Direct) {
            continue;
        }
        let kind = if reference.is_branch() {
            RefKind::LocalBranch
        } else if reference.is_remote() {
            RefKind::RemoteBranch
        } else if reference.is_tag() {
            RefKind::Tag
        } else {
            continue;
        };
        let Ok(commit) = reference.peel_to_commit() else {
            continue;
        };
        labels.entry(commit.id().to_string()).or_default().push(RefLabel {
            name: lossy(reference.shorthand_bytes()),
            kind,
            is_head: head_name.as_deref() == Some(reference.name_bytes()),
        });
    }

    for refs in labels.values_mut() {
        // Checked-out branch first, then local, remote, tags.
        refs.sort_by_key(|r| (!r.is_head, r.kind as u8, r.name.clone()));
    }
    Ok(labels)
}

#[cfg(test)]
mod tests {
    use super::*;
    use git2::{Oid, Signature, Time};
    use tempfile::TempDir;

    fn commit(repo: &Repository, message: &str, at: i64, parents: &[Oid]) -> Oid {
        let sig = Signature::new("Ada", "ada@example.com", &Time::new(at, 0)).unwrap();
        let tree_id = repo.index().unwrap().write_tree().unwrap();
        let tree = repo.find_tree(tree_id).unwrap();
        let parents = parents
            .iter()
            .map(|id| repo.find_commit(*id).unwrap())
            .collect::<Vec<_>>();
        let parents = parents.iter().collect::<Vec<_>>();
        repo.commit(None, &sig, &sig, message, &tree, &parents).unwrap()
    }

    fn init() -> (TempDir, Repository) {
        let dir = TempDir::new().unwrap();
        let repo = Repository::init(dir.path()).unwrap();
        (dir, repo)
    }

    #[test]
    fn relabels_after_a_checkout_and_asks_for_a_reload_after_a_commit() {
        let (dir, repo) = init();
        let root = commit(&repo, "root", 1_000, &[]);
        let tip = commit(&repo, "tip", 2_000, &[root]);
        repo.branch("main", &repo.find_commit(tip).unwrap(), true).unwrap();
        repo.branch("old", &repo.find_commit(root).unwrap(), true).unwrap();
        repo.set_head("refs/heads/main").unwrap();
        let mut history = load_history(dir.path(), 10).unwrap();
        assert!(history.rows[0].refs[0].is_head);

        repo.set_head("refs/heads/old").unwrap();
        assert!(history.relabel(dir.path()).unwrap());
        assert!(!history.rows[0].refs[0].is_head);
        assert!(history.rows[1].refs[0].is_head);

        let newer = commit(&repo, "newer", 3_000, &[tip]);
        repo.branch("main", &repo.find_commit(newer).unwrap(), true).unwrap();
        assert!(!history.relabel(dir.path()).unwrap());
    }

    #[test]
    fn filters_history_by_message_author_and_id() {
        let (dir, repo) = init();
        let root = commit(&repo, "Add login page", 1_000, &[]);
        let fix = commit(&repo, "Fix logout bug", 2_000, &[root]);
        repo.branch("main", &repo.find_commit(fix).unwrap(), true).unwrap();
        repo.set_head("refs/heads/main").unwrap();
        let history = load_history(dir.path(), 10).unwrap();

        assert_eq!(history.filter("LOG"), [0, 1]);
        assert_eq!(history.filter("fix log"), [0]);
        assert_eq!(history.filter("ada"), [0, 1]);
        assert_eq!(history.filter(&root.to_string()[..8]), [1]);
        assert_eq!(history.filter("  "), [0, 1]);
        assert!(history.filter("nothing").is_empty());
    }

    #[test]
    fn opens_an_empty_repo() {
        let (dir, _repo) = init();
        let summary = open_repo(dir.path()).unwrap();
        assert_eq!(summary.head_branch, None);
        assert_eq!(summary.head_commit, None);
        assert!(summary.local_branches.is_empty());
        assert!(load_history(dir.path(), 10).unwrap().rows.is_empty());
    }

    #[test]
    fn finds_the_repo_from_a_subdirectory() {
        let (dir, repo) = init();
        let first = commit(&repo, "first", 1_000, &[]);
        repo.branch("main", &repo.find_commit(first).unwrap(), true).unwrap();
        repo.set_head("refs/heads/main").unwrap();

        let nested = dir.path().join("a/b");
        std::fs::create_dir_all(&nested).unwrap();
        let summary = open_repo(&nested).unwrap();
        assert_eq!(summary.head_branch.as_deref(), Some("main"));
        assert_eq!(summary.head_commit, Some(first.to_string()));
    }

    #[test]
    fn lists_commits_from_every_branch_newest_first() {
        let (dir, repo) = init();
        let root = commit(&repo, "root", 1_000, &[]);
        let on_main = commit(&repo, "on main", 2_000, &[root]);
        let on_feature = commit(&repo, "on feature", 3_000, &[root]);
        let merge = commit(&repo, "merge feature", 4_000, &[on_main, on_feature]);
        repo.branch("main", &repo.find_commit(merge).unwrap(), true).unwrap();
        repo.branch("feature", &repo.find_commit(on_feature).unwrap(), true)
            .unwrap();
        repo.set_head("refs/heads/main").unwrap();

        let summary = open_repo(dir.path()).unwrap();
        assert_eq!(summary.local_branches, vec!["feature", "main"]);

        let history = load_history(dir.path(), 10).unwrap();
        assert_eq!(history.columns, 2);
        let commits = history.rows.iter().map(|r| &r.commit).collect::<Vec<_>>();
        let summaries = commits.iter().map(|c| c.summary.as_str()).collect::<Vec<_>>();
        assert_eq!(summaries, vec!["merge feature", "on feature", "on main", "root"]);
        assert_eq!(commits[0].parent_ids.len(), 2);
        assert_eq!(commits[0].author_name, "Ada");
        assert_eq!(commits[0].time, 4_000);
        assert!(commits[0].id.starts_with(&commits[0].short_id));

        assert_eq!(load_history(dir.path(), 2).unwrap().rows.len(), 2);
    }

    #[test]
    fn labels_branches_tags_and_head() {
        let (dir, repo) = init();
        let root = commit(&repo, "root", 1_000, &[]);
        let tip = commit(&repo, "tip", 2_000, &[root]);
        let tip_commit = repo.find_commit(tip).unwrap();
        repo.branch("main", &tip_commit, true).unwrap();
        repo.branch("zeta", &tip_commit, true).unwrap();
        repo.reference("refs/remotes/origin/main", tip, true, "").unwrap();
        repo.tag_lightweight("v1", repo.find_commit(root).unwrap().as_object(), false)
            .unwrap();
        repo.set_head("refs/heads/zeta").unwrap();

        let history = load_history(dir.path(), 10).unwrap();
        let names = |i: usize| {
            history.rows[i]
                .refs
                .iter()
                .map(|r| (r.name.as_str(), r.kind, r.is_head))
                .collect::<Vec<_>>()
        };
        assert_eq!(
            names(0),
            [
                ("zeta", RefKind::LocalBranch, true),
                ("main", RefKind::LocalBranch, false),
                ("origin/main", RefKind::RemoteBranch, false),
            ]
        );
        assert_eq!(names(1), [("v1", RefKind::Tag, false)]);

        repo.set_head_detached(root).unwrap();
        let history = load_history(dir.path(), 10).unwrap();
        assert_eq!(history.rows[1].refs[0].kind, RefKind::DetachedHead);
    }

    #[test]
    fn safe_directory_value_is_the_workdir() {
        let (dir, repo) = init();
        let nested = dir.path().join("src");
        std::fs::create_dir_all(&nested).unwrap();
        // libgit2 compares safe.directory against its own spelling of the workdir.
        let workdir = repo.workdir().unwrap().to_string_lossy().replace('\\', "/");
        let expected = workdir.trim_end_matches('/');
        assert_eq!(safe_directory_value(&nested).unwrap(), expected);
    }

    #[test]
    fn adds_a_safe_directory_once_and_keeps_others() {
        let dir = TempDir::new().unwrap();
        let config_path = dir.path().join(".gitconfig");
        std::fs::write(&config_path, "[safe]\n\tdirectory = /other/repo\n").unwrap();

        let value = "%(prefix)///wsl.localhost/Ubuntu/home/ada/repo (1)";
        add_safe_directory(&config_path, value).unwrap();
        add_safe_directory(&config_path, value).unwrap();

        let config = git2::Config::open(&config_path).unwrap();
        let mut entries = Vec::new();
        config
            .multivar("safe.directory", None)
            .unwrap()
            .for_each(|e| entries.push(e.value().unwrap().to_owned()))
            .unwrap();
        assert_eq!(entries, vec!["/other/repo", value]);
    }

    #[test]
    fn init_creates_an_empty_repo_and_reopens_an_existing_one() {
        let dir = TempDir::new().unwrap();
        let target = dir.path().join("new-project");
        let summary = init_repo(&target).unwrap();
        assert!(target.join(".git").is_dir());
        assert_eq!(summary.head_commit, None);

        std::fs::write(target.join("keep.txt"), "x").unwrap();
        init_repo(&target).unwrap();
        assert!(target.join("keep.txt").exists());
    }

    #[test]
    fn errors_outside_a_repo() {
        let dir = TempDir::new().unwrap();
        assert!(open_repo(dir.path()).is_err());
    }
}
