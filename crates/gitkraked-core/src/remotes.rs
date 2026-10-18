//! Adding remotes: the server copies fetch, pull and push talk to.

use std::path::Path;

use git2::Remote;

use crate::{Result, discover};

/// Adds a remote, like `git remote add <name> <url>`.
pub fn add_remote(path: impl AsRef<Path>, name: &str, url: &str) -> Result<()> {
    let (name, url) = (name.trim(), url.trim());
    if url.is_empty() {
        return Err(git2::Error::from_str("paste the remote's URL first").into());
    }
    if !Remote::is_valid_name(name) {
        return Err(git2::Error::from_str(&format!("\"{name}\" can't be a remote name; try origin")).into());
    }
    let repo = discover(path.as_ref())?;
    repo.remote(name, url).map_err(|e| match e.code() {
        git2::ErrorCode::Exists => git2::Error::from_str(&format!("there's already a remote called {name}")),
        _ => e,
    })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use git2::Repository;
    use tempfile::TempDir;

    #[test]
    fn adds_a_remote_once() {
        let dir = TempDir::new().unwrap();
        Repository::init(dir.path()).unwrap();
        add_remote(dir.path(), "origin", " https://example.com/a.git ").unwrap();
        let repo = Repository::open(dir.path()).unwrap();
        assert_eq!(repo.find_remote("origin").unwrap().url().unwrap(), "https://example.com/a.git");
        let again = add_remote(dir.path(), "origin", "https://example.com/b.git").unwrap_err();
        assert!(again.to_string().contains("already"));
        assert!(add_remote(dir.path(), "bad name", "x").is_err());
        assert!(add_remote(dir.path(), "up", "  ").is_err());
    }
}
