//! Fetch, pull and push.
//!
//! These run the `git` command instead of libgit2, so they use the same credential
//! helpers (Git Credential Manager on Windows, the macOS keychain), SSH config and
//! proxy settings as the user's own `git`.

use std::path::Path;
use std::process::{Command, Stdio};

use git2::{BranchType, Repository};
use serde::{Deserialize, Serialize};

use crate::{Result, discover, lossy};

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum PullMode {
    /// `git pull --no-rebase`: a merge commit when histories diverge.
    Merge,
    /// `git pull --rebase`: replay local commits on top.
    Rebase,
}

/// Runs `git` in the repository's working directory and returns its output, or its
/// error message when it fails.
pub(crate) fn git(repo: &Repository, args: &[&str]) -> Result<String> {
    let dir = repo.workdir().unwrap_or_else(|| repo.path());
    let output = git_command(dir, args).output().map_err(spawn_error)?;
    let stdout = lossy(&output.stdout);
    let stderr = lossy(&output.stderr);
    if output.status.success() {
        Ok(format!("{stdout}{stderr}").trim().to_owned())
    } else {
        Err(git2::Error::from_str(&explain(&stderr)).into())
    }
}

/// A `git` command for `dir` that can't hang on a prompt or flash a console window.
pub(crate) fn git_command(dir: &Path, args: &[&str]) -> Command {
    let mut command = Command::new("git");
    command
        .args(args)
        .current_dir(dir)
        .stdin(Stdio::null())
        // Fail instead of waiting for a terminal prompt nobody can see. Graphical
        // credential helpers such as Git Credential Manager still prompt.
        .env("GIT_TERMINAL_PROMPT", "0")
        // Never open an editor: merges, rebases and cherry-picks keep their messages.
        .env("GIT_EDITOR", "true");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // Don't flash a console window for every fetch.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}

pub(crate) fn spawn_error(e: std::io::Error) -> crate::Error {
    git2::Error::from_str(&if e.kind() == std::io::ErrorKind::NotFound {
        "the git command isn't installed or isn't on PATH; install Git from https://git-scm.com".to_owned()
    } else {
        format!("couldn't run git: {e}")
    })
    .into()
}

/// Turns git's most common network failures into advice; anything else is passed on.
pub(crate) fn explain(stderr: &str) -> String {
    let lower = stderr.to_lowercase();
    let detail = stderr.trim();
    if lower.contains("non-fast-forward") || lower.contains("fetch first") || lower.contains("rejected") {
        format!("The remote has commits you don't have yet. Pull first, then push.\n\n{detail}")
    } else if lower.contains("authentication failed")
        || lower.contains("could not read username")
        || lower.contains("permission denied")
    {
        format!(
            "Git couldn't sign in to the remote. Check that `git push` works in a terminal \
             (it sets up your credentials), then try again.\n\n{detail}"
        )
    } else if lower.contains("could not resolve host") || lower.contains("unable to access") {
        format!("Couldn't reach the remote. Check your connection.\n\n{detail}")
    } else {
        detail.to_owned()
    }
}

/// Fetches every remote and prunes branches deleted there.
pub fn fetch(path: impl AsRef<Path>) -> Result<()> {
    let repo = discover(path.as_ref())?;
    if repo.remotes()?.is_empty() {
        return Err(git2::Error::from_str("this repository has no remotes to fetch from").into());
    }
    git(&repo, &["fetch", "--all", "--prune"])?;
    Ok(())
}

/// Pulls the current branch's upstream. A merge that conflicts is left in progress for
/// the user to resolve; a rebase that conflicts is undone, leaving nothing changed.
pub fn pull(path: impl AsRef<Path>, mode: PullMode) -> Result<String> {
    let repo = discover(path.as_ref())?;
    let (branch, _) = current_branch(&repo)?;
    if repo.find_branch(&branch, BranchType::Local)?.upstream().is_err() {
        return Err(git2::Error::from_str(&format!(
            "{branch} doesn't track a remote branch yet; push it first to set one up"
        ))
        .into());
    }
    let flag = match mode {
        PullMode::Merge => "--no-rebase",
        PullMode::Rebase => "--rebase",
    };
    // --autostash lets a rebase run with uncommitted changes, as a merge pull can. Not for
    // merges: a conflicted merge keeps the stash until `git merge --abort` or `git commit`,
    // and this app finishes merges with libgit2, which would never restore it.
    let mut args = vec!["pull", flag];
    if mode == PullMode::Rebase {
        args.push("--autostash");
    }
    match git(&repo, &args) {
        Ok(output) => Ok(output),
        Err(e) if mode == PullMode::Rebase && repo.state() != git2::RepositoryState::Clean => {
            // Conflicts mid-rebase: put everything back rather than leave a half-done rebase.
            let _ = git(&repo, &["rebase", "--abort"]);
            Err(git2::Error::from_str(&format!(
                "Pulling with rebase hit conflicts, so nothing was changed. Pull with merge \
                 instead to resolve them.\n\n{e}"
            ))
            .into())
        }
        Err(e) => Err(e),
    }
}

/// Brings the latest commits from `parent` (a local or remote branch) into the current
/// branch, fetching it first when it's a remote branch. Conflicts are handled as in [`pull`].
pub fn pull_from(path: impl AsRef<Path>, parent: &str, mode: PullMode) -> Result<String> {
    let repo = discover(path.as_ref())?;
    let (branch, _) = current_branch(&repo)?;
    if parent == branch {
        return Err(git2::Error::from_str("a branch can't pull from itself").into());
    }
    if let Ok(remote_branch) = repo.find_branch(parent, BranchType::Remote) {
        let remote = crate::branches::remote_of(&repo, &lossy(remote_branch.get().name_bytes()));
        let short = parent.strip_prefix(&format!("{remote}/")).unwrap_or(parent);
        git(&repo, &["fetch", &remote, short])?;
    } else if repo.find_branch(parent, BranchType::Local).is_err() {
        return Err(git2::Error::from_str(&format!("there's no branch called {parent}")).into());
    }
    let result = match mode {
        PullMode::Merge => git(&repo, &["merge", "--no-edit", parent]),
        PullMode::Rebase => git(&repo, &["rebase", "--autostash", parent]),
    };
    match result {
        Ok(output) => Ok(output),
        Err(_) if repo.state() == git2::RepositoryState::Merge => Err(git2::Error::from_str(&format!(
            "Pulling {parent} into {branch} hit conflicts. Resolve them under Working changes, \
             then commit to finish."
        ))
        .into()),
        Err(e) if mode == PullMode::Rebase && repo.state() != git2::RepositoryState::Clean => {
            let _ = git(&repo, &["rebase", "--abort"]);
            Err(git2::Error::from_str(&format!(
                "Rebasing onto {parent} hit conflicts, so nothing was changed. Use merge \
                 instead to resolve them.\n\n{e}"
            ))
            .into())
        }
        Err(e) => Err(e),
    }
}

/// Pushes the current branch. A branch with no upstream is pushed to its remote (or
/// `origin`) and set to track it.
pub fn push(path: impl AsRef<Path>) -> Result<String> {
    let repo = discover(path.as_ref())?;
    let (branch, has_upstream) = current_branch(&repo)?;
    if has_upstream {
        return git(&repo, &["push"]);
    }
    let remotes = repo.remotes()?;
    let names = remotes.iter().filter_map(|r| r.ok().flatten()).collect::<Vec<&str>>();
    let remote = if names.contains(&"origin") {
        "origin"
    } else {
        names
            .first()
            .copied()
            .ok_or_else(|| git2::Error::from_str("this repository has no remote to push to"))?
    };
    git(&repo, &["push", "--set-upstream", remote, &branch])
}

fn current_branch(repo: &Repository) -> Result<(String, bool)> {
    let head = repo.head()?;
    if !head.is_branch() {
        return Err(git2::Error::from_str("check out a branch first").into());
    }
    let name = lossy(head.shorthand_bytes());
    let has_upstream = repo.find_branch(&name, BranchType::Local)?.upstream().is_ok();
    Ok((name, has_upstream))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{branches, changes};
    use std::fs;
    use tempfile::TempDir;

    fn run(dir: &Path, args: &[&str]) {
        let status = Command::new("git").args(args).current_dir(dir).output().unwrap();
        assert!(status.status.success(), "git {args:?}: {}", lossy(&status.stderr));
    }

    /// A bare "remote" with one commit on main, and two clones of it.
    fn setup() -> (TempDir, std::path::PathBuf, std::path::PathBuf) {
        let root = TempDir::new().unwrap();
        let remote = root.path().join("remote.git");
        run(root.path(), &["init", "-q", "--bare", "-b", "main", remote.to_str().unwrap()]);
        let seed = root.path().join("seed");
        run(root.path(), &["clone", "-q", remote.to_str().unwrap(), seed.to_str().unwrap()]);
        configure(&seed);
        commit_file(&seed, "a.txt", "a\n");
        run(&seed, &["push", "-q", "origin", "HEAD:main"]);
        let mine = root.path().join("mine");
        run(root.path(), &["clone", "-q", remote.to_str().unwrap(), mine.to_str().unwrap()]);
        configure(&mine);
        (root, seed, mine)
    }

    fn configure(dir: &Path) {
        run(dir, &["config", "user.name", "Ada"]);
        run(dir, &["config", "user.email", "ada@example.com"]);
    }

    fn commit_file(dir: &Path, file: &str, content: &str) {
        fs::write(dir.join(file), content).unwrap();
        changes::stage_files(dir, &[file.to_owned()]).unwrap();
        changes::commit(dir, &format!("write {file}"), false).unwrap();
    }

    fn head(dir: &Path) -> String {
        Repository::open(dir).unwrap().head().unwrap().target().unwrap().to_string()
    }

    #[test]
    fn fetch_and_pull_bring_in_remote_commits() {
        let (_root, seed, mine) = setup();
        commit_file(&seed, "b.txt", "b\n");
        run(&seed, &["push", "-q"]);

        fetch(&mine).unwrap();
        let main = branches::list_branches(&mine).unwrap().local.remove(0);
        assert_eq!((main.ahead, main.behind), (0, 1));

        pull(&mine, PullMode::Merge).unwrap();
        assert_eq!(head(&mine), head(&seed));
    }

    #[test]
    fn push_rejected_until_pulled() {
        let (_root, seed, mine) = setup();
        commit_file(&seed, "b.txt", "b\n");
        run(&seed, &["push", "-q"]);
        commit_file(&mine, "c.txt", "c\n");

        let err = push(&mine).unwrap_err().to_string();
        assert!(err.contains("Pull first"), "{err}");

        pull(&mine, PullMode::Rebase).unwrap();
        push(&mine).unwrap();
        run(&seed, &["pull", "-q", "--no-rebase"]);
        assert_eq!(head(&seed), head(&mine));
    }

    #[test]
    fn first_push_sets_the_upstream() {
        let (_root, _seed, mine) = setup();
        branches::create_branch(&mine, "topic", None, true).unwrap();
        commit_file(&mine, "t.txt", "t\n");
        assert!(pull(&mine, PullMode::Merge).is_err(), "no upstream to pull from yet");

        push(&mine).unwrap();
        let topic = branches::list_branches(&mine)
            .unwrap()
            .local
            .into_iter()
            .find(|b| b.name == "topic")
            .unwrap();
        assert_eq!(topic.upstream.as_deref(), Some("origin/topic"));
    }

    #[test]
    fn pull_from_parent_brings_in_its_latest_commits() {
        let (_root, seed, mine) = setup();
        branches::create_branch(&mine, "topic", None, true).unwrap();
        commit_file(&mine, "t.txt", "t\n");
        let repo = Repository::open(&mine).unwrap();
        assert_eq!(branches::parent_branch(&repo, "topic").as_deref(), Some("origin/main"));

        // Someone else pushes to main; topic picks it up without checking main out.
        commit_file(&seed, "b.txt", "b\n");
        run(&seed, &["push", "-q"]);
        pull_from(&mine, "origin/main", PullMode::Rebase).unwrap();
        assert!(mine.join("b.txt").exists() && mine.join("t.txt").exists());
        let head = repo.head().unwrap().peel_to_commit().unwrap();
        assert_eq!(head.parent_id(0).unwrap().to_string(), self::head(&seed));

        commit_file(&seed, "c.txt", "c\n");
        run(&seed, &["push", "-q"]);
        pull_from(&mine, "origin/main", PullMode::Merge).unwrap();
        assert!(mine.join("c.txt").exists());
        assert!(pull_from(&mine, "topic", PullMode::Merge).is_err());
    }

    #[test]
    fn conflicting_rebase_pull_changes_nothing() {
        let (_root, seed, mine) = setup();
        commit_file(&seed, "a.txt", "theirs\n");
        run(&seed, &["push", "-q"]);
        commit_file(&mine, "a.txt", "mine\n");
        let before = head(&mine);

        let err = pull(&mine, PullMode::Rebase).unwrap_err().to_string();
        assert!(err.contains("nothing was changed"), "{err}");
        assert_eq!(head(&mine), before);
        assert_eq!(Repository::open(&mine).unwrap().state(), git2::RepositoryState::Clean);

        // Pulling with merge leaves the conflict for the user to resolve.
        assert!(pull(&mine, PullMode::Merge).is_err());
        assert!(changes::working_status(&mine).unwrap().merging);
    }
}
