//! Tags: listing them and checking one out.

use std::path::Path;

use git2::ObjectType;
use serde::Serialize;

use crate::branches::checkout_safely;
use crate::{Result, discover, lossy};

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Tag {
    pub name: String,
    /// The commit the tag points at.
    pub target: String,
    /// An annotated tag's message summary; `None` for a lightweight tag.
    pub message: Option<String>,
    /// The tagged commit's time, in seconds since the epoch.
    pub time: i64,
}

/// Every tag that points at a commit, newest commit first.
pub fn list_tags(path: impl AsRef<Path>) -> Result<Vec<Tag>> {
    let repo = discover(path.as_ref())?;
    let mut tags = Vec::new();
    for reference in repo.references_glob("refs/tags/*")? {
        let reference = reference?;
        // Tags of trees or blobs exist but can't be checked out; skip them.
        let Ok(commit) = reference.peel_to_commit() else { continue };
        let name = lossy(reference.name_bytes());
        let message = reference
            .peel(ObjectType::Tag)
            .ok()
            .and_then(|o| o.into_tag().ok())
            .and_then(|t| t.message_bytes().map(|m| lossy(m).lines().next().unwrap_or("").trim().to_owned()))
            .filter(|m| !m.is_empty());
        tags.push(Tag {
            name: name.strip_prefix("refs/tags/").unwrap_or(&name).to_owned(),
            target: commit.id().to_string(),
            message,
            time: commit.time().seconds(),
        });
    }
    tags.sort_by(|a, b| b.time.cmp(&a.time).then_with(|| b.name.cmp(&a.name)));
    Ok(tags)
}

/// Checks out the commit `name` tags, leaving HEAD detached as `git checkout <tag>` does.
/// Refuses if uncommitted changes would be overwritten.
pub fn checkout_tag(path: impl AsRef<Path>, name: &str) -> Result<()> {
    let repo = discover(path.as_ref())?;
    let commit = repo.find_reference(&format!("refs/tags/{name}"))?.peel_to_commit()?;
    checkout_safely(&repo, commit.as_object(), name)?;
    repo.set_head_detached(commit.id())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::changes;
    use git2::Repository;
    use std::fs;
    use tempfile::TempDir;

    fn commit(dir: &Path, content: &str, message: &str) -> String {
        fs::write(dir.join("a.txt"), content).unwrap();
        changes::stage_files(dir, &["a.txt".to_owned()]).unwrap();
        changes::commit(dir, message, false).unwrap()
    }

    fn setup() -> (TempDir, Repository) {
        let dir = TempDir::new().unwrap();
        let repo = Repository::init(dir.path()).unwrap();
        let mut config = repo.config().unwrap();
        config.set_str("user.name", "Ada").unwrap();
        config.set_str("user.email", "ada@example.com").unwrap();
        // Keep checkouts byte-for-byte: Git for Windows turns on autocrlf system-wide.
        config.set_bool("core.autocrlf", false).unwrap();
        (dir, repo)
    }

    #[test]
    fn lists_lightweight_and_annotated_tags() {
        let (dir, repo) = setup();
        let first = commit(dir.path(), "1\n", "one");
        let obj = repo.revparse_single(&first).unwrap();
        repo.tag_lightweight("v1", &obj, false).unwrap();
        let second = commit(dir.path(), "2\n", "two");
        let obj = repo.revparse_single(&second).unwrap();
        let sig = repo.signature().unwrap();
        repo.tag("v2", &obj, &sig, "Second release\n\nDetails", false).unwrap();

        let tags = list_tags(dir.path()).unwrap();
        let names: Vec<_> = tags.iter().map(|t| t.name.as_str()).collect();
        assert!(names.contains(&"v1") && names.contains(&"v2"));
        let v2 = tags.iter().find(|t| t.name == "v2").unwrap();
        assert_eq!(v2.target, second);
        assert_eq!(v2.message.as_deref(), Some("Second release"));
        assert_eq!(tags.iter().find(|t| t.name == "v1").unwrap().message, None);
    }

    #[test]
    fn checkout_detaches_head_at_the_tag() {
        let (dir, repo) = setup();
        let first = commit(dir.path(), "1\n", "one");
        repo.tag_lightweight("v1", &repo.revparse_single(&first).unwrap(), false).unwrap();
        commit(dir.path(), "2\n", "two");

        checkout_tag(dir.path(), "v1").unwrap();
        assert!(repo.head_detached().unwrap());
        assert_eq!(repo.head().unwrap().target().unwrap().to_string(), first);
        assert_eq!(fs::read_to_string(dir.path().join("a.txt")).unwrap(), "1\n");
    }

    #[test]
    fn checkout_refuses_to_overwrite_changes() {
        let (dir, repo) = setup();
        let first = commit(dir.path(), "1\n", "one");
        repo.tag_lightweight("v1", &repo.revparse_single(&first).unwrap(), false).unwrap();
        commit(dir.path(), "2\n", "two");
        fs::write(dir.path().join("a.txt"), "mine\n").unwrap();

        let err = checkout_tag(dir.path(), "v1").unwrap_err().to_string();
        assert!(err.contains("uncommitted changes"), "{err}");
        assert!(!repo.head_detached().unwrap());
    }
}
