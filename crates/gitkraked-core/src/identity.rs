//! Who commits: the `user.name` and `user.email` Git records in every commit.

use std::path::Path;

use git2::{ConfigLevel, Repository, Signature};
use serde::{Deserialize, Serialize};

use crate::{Error, Result, discover, global_config_path};

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Identity {
    pub name: Option<String>,
    pub email: Option<String>,
    /// Set in this repository's own config, overriding the global one.
    pub local: bool,
}

/// Where [`set_identity`] saves the name and email.
#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum IdentityScope {
    /// `git config user.name …` in this repository only.
    Repository,
    /// `git config --global user.name …` for every repository.
    Global,
}

/// The name and email commits in this repository are made with, if Git knows them.
pub fn identity(path: impl AsRef<Path>) -> Result<Identity> {
    let repo = discover(path.as_ref())?;
    let config = repo.config()?.snapshot()?;
    let local = repo
        .config()?
        .open_level(ConfigLevel::Local)
        .and_then(|mut c| c.snapshot())
        .map(|c| c.get_string("user.name").is_ok() || c.get_string("user.email").is_ok())
        .unwrap_or(false);
    Ok(Identity {
        name: config.get_string("user.name").ok().filter(|s| !s.trim().is_empty()),
        email: config.get_string("user.email").ok().filter(|s| !s.trim().is_empty()),
        local,
    })
}

/// Saves the name and email for this repository or for every repository.
pub fn set_identity(path: impl AsRef<Path>, name: &str, email: &str, scope: IdentityScope) -> Result<()> {
    let (name, email) = (name.trim(), email.trim());
    if name.is_empty() || email.is_empty() {
        return Err(git2::Error::from_str("enter both a name and an email").into());
    }
    if [name, email].iter().any(|v| v.contains(['<', '>', '\n'])) {
        return Err(git2::Error::from_str("the name and email can't contain <, > or line breaks").into());
    }
    let mut config = match scope {
        IdentityScope::Repository => discover(path.as_ref())?.config()?.open_level(ConfigLevel::Local)?,
        IdentityScope::Global => git2::Config::open(&global_config_path()?)?,
    };
    config.set_str("user.name", name)?;
    config.set_str("user.email", email)?;
    Ok(())
}

/// The signature for a new commit, or [`Error::NoIdentity`] so the UI can ask for it.
pub(crate) fn signature(repo: &Repository) -> Result<Signature<'static>> {
    repo.signature().map_err(|_| Error::NoIdentity)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn saves_a_repository_identity_and_reads_it_back() {
        let dir = TempDir::new().unwrap();
        Repository::init(dir.path()).unwrap();
        set_identity(dir.path(), " Ada ", "ada@example.com", IdentityScope::Repository).unwrap();
        let who = identity(dir.path()).unwrap();
        assert_eq!(who.name.as_deref(), Some("Ada"));
        assert_eq!(who.email.as_deref(), Some("ada@example.com"));
        assert!(who.local);
        let repo = Repository::open(dir.path()).unwrap();
        assert_eq!(signature(&repo).unwrap().name().unwrap(), "Ada");
    }

    #[test]
    fn rejects_empty_or_malformed_values() {
        let dir = TempDir::new().unwrap();
        Repository::init(dir.path()).unwrap();
        assert!(set_identity(dir.path(), "", "a@b.c", IdentityScope::Repository).is_err());
        assert!(set_identity(dir.path(), "Ada", "<a@b.c>", IdentityScope::Repository).is_err());
    }
}
