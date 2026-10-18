//! Stashes: put uncommitted work aside and bring it back later.

use std::path::Path;

use git2::{StashApplyOptions, StashFlags, build::CheckoutBuilder};
use serde::Serialize;

use crate::{Result, discover, lossy};

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StashEntry {
    /// 0 is the newest, as in `stash@{0}`.
    pub index: usize,
    pub message: String,
    /// The stash commit itself.
    pub id: String,
    /// The commit the work was stashed on top of.
    pub base: String,
}

pub fn list_stashes(path: impl AsRef<Path>) -> Result<Vec<StashEntry>> {
    let mut repo = discover(path.as_ref())?;
    let mut entries = Vec::new();
    repo.stash_foreach(|index, message, id| {
        entries.push((index, message.to_owned(), *id));
        true
    })?;
    entries
        .into_iter()
        .map(|(index, message, id)| {
            let base = repo.find_commit(id)?.parent_id(0)?;
            Ok(StashEntry { index, message, id: id.to_string(), base: base.to_string() })
        })
        .collect()
}

/// Stashes all uncommitted changes, untracked files included, and cleans the working tree.
pub fn stash_save(path: impl AsRef<Path>, message: Option<&str>) -> Result<()> {
    let mut repo = discover(path.as_ref())?;
    let signature = crate::identity::signature(&repo)?;
    let message = message.map(str::trim).filter(|m| !m.is_empty());
    repo.stash_save2(&signature, message, Some(StashFlags::INCLUDE_UNTRACKED))
        .map_err(|e| match e.code() {
            git2::ErrorCode::NotFound => git2::Error::from_str("there are no changes to stash"),
            _ => e,
        })?;
    Ok(())
}

/// Applies a stash. With `pop`, also drops it once it applied cleanly.
pub fn stash_apply(path: impl AsRef<Path>, index: usize, pop: bool) -> Result<()> {
    let mut repo = discover(path.as_ref())?;
    let mut checkout = CheckoutBuilder::new();
    checkout.safe();
    let mut opts = StashApplyOptions::new();
    opts.checkout_options(checkout).reinstantiate_index();
    let result = if pop {
        repo.stash_pop(index, Some(&mut opts))
    } else {
        repo.stash_apply(index, Some(&mut opts))
    };
    result.map_err(|e| match e.code() {
        git2::ErrorCode::Conflict | git2::ErrorCode::MergeConflict => git2::Error::from_str(
            "the stash changes files you've also changed; commit or stash those first",
        ),
        _ => e,
    })?;
    Ok(())
}

pub fn stash_drop(path: impl AsRef<Path>, index: usize) -> Result<()> {
    discover(path.as_ref())?.stash_drop(index)?;
    Ok(())
}

/// The label text for a stash in the graph, e.g. `stash@{0}: WIP on main`.
pub(crate) fn stash_label(entry: &StashEntry) -> String {
    let short = entry.message.split(": ").last().unwrap_or(&entry.message);
    lossy(format!("stash@{{{}}} {}", entry.index, short).as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::changes;
    use std::fs;
    use tempfile::TempDir;

    fn setup() -> TempDir {
        let dir = TempDir::new().unwrap();
        let repo = git2::Repository::init(dir.path()).unwrap();
        let mut config = repo.config().unwrap();
        config.set_str("user.name", "Ada").unwrap();
        config.set_str("user.email", "ada@example.com").unwrap();
        fs::write(dir.path().join("a.txt"), "a\n").unwrap();
        changes::stage_files(dir.path(), &["a.txt".into()]).unwrap();
        changes::commit(dir.path(), "first", false).unwrap();
        dir
    }

    #[test]
    fn stashes_and_restores_work_including_untracked_files() {
        let dir = setup();
        assert!(stash_save(dir.path(), None).is_err(), "nothing to stash yet");

        fs::write(dir.path().join("a.txt"), "edited\n").unwrap();
        fs::write(dir.path().join("new.txt"), "new\n").unwrap();
        changes::stage_files(dir.path(), &["a.txt".into()]).unwrap();
        stash_save(dir.path(), Some("half-done idea")).unwrap();

        let status = changes::working_status(dir.path()).unwrap();
        assert!(status.staged.is_empty() && status.unstaged.is_empty());
        let stashes = list_stashes(dir.path()).unwrap();
        assert_eq!(stashes.len(), 1);
        assert!(stashes[0].message.ends_with("half-done idea"), "{}", stashes[0].message);
        assert_eq!(stash_label(&stashes[0]), "stash@{0} half-done idea");

        stash_apply(dir.path(), 0, true).unwrap();
        assert_eq!(fs::read_to_string(dir.path().join("a.txt")).unwrap(), "edited\n");
        assert!(dir.path().join("new.txt").exists());
        // Staged changes come back staged.
        let status = changes::working_status(dir.path()).unwrap();
        assert_eq!(status.staged.len(), 1);
        assert!(list_stashes(dir.path()).unwrap().is_empty());
    }

    #[test]
    fn stashes_are_labelled_on_their_base_commit() {
        let dir = setup();
        fs::write(dir.path().join("a.txt"), "edited\n").unwrap();
        stash_save(dir.path(), Some("later")).unwrap();
        let history = crate::load_history(dir.path(), 10).unwrap();
        let labels = &history.rows[0].refs;
        assert!(labels.iter().any(|r| r.kind == crate::RefKind::Stash && r.name == "stash@{0} later"));
    }

    #[test]
    fn apply_keeps_the_stash_and_drop_removes_it() {
        let dir = setup();
        fs::write(dir.path().join("a.txt"), "edited\n").unwrap();
        stash_save(dir.path(), None).unwrap();
        stash_apply(dir.path(), 0, false).unwrap();
        assert_eq!(list_stashes(dir.path()).unwrap().len(), 1);
        stash_drop(dir.path(), 0).unwrap();
        assert!(list_stashes(dir.path()).unwrap().is_empty());
    }
}
