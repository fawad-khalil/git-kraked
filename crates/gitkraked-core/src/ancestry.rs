//! Ahead/behind counts between many branches from one walk of history.
//!
//! Comparing every branch with every other one pair by pair (libgit2's
//! `graph_ahead_behind`) took over five seconds on a repo with 40 branches. Instead, one
//! walk marks each commit with the set of branch tips it's reachable from, stopping once
//! every commit still to visit is reachable from all of them. "Commits on A that aren't on
//! B" is then a count over those marks.

use std::collections::{BinaryHeap, HashMap, HashSet};

use git2::{Oid, Repository};

use crate::Result;

type Mask = Vec<u64>;

pub(crate) struct Ancestry {
    index: HashMap<String, usize>,
    /// Each distinct mark and how many commits carry it. Commits reachable from every
    /// tip aren't stored: they never count towards a difference.
    groups: Vec<(Mask, usize)>,
}

fn has(mask: &Mask, bit: usize) -> bool {
    mask[bit / 64] & (1 << (bit % 64)) != 0
}

impl Ancestry {
    /// Walks history from `tips` (name and commit). Names must be unique.
    pub(crate) fn compute(repo: &Repository, tips: &[(String, Oid)]) -> Result<Ancestry> {
        let n = tips.len();
        let words = n.div_ceil(64).max(1);
        let mut full: Mask = vec![0; words];
        for bit in 0..n {
            full[bit / 64] |= 1 << (bit % 64);
        }

        let mut masks: HashMap<Oid, Mask> = HashMap::new();
        let mut queued: HashSet<Oid> = HashSet::new();
        // Queued commits whose mark isn't full yet. Once there are none, everything left
        // is reachable from every tip and the walk can stop.
        let mut partial: HashSet<Oid> = HashSet::new();
        let mut heap: BinaryHeap<(i64, Oid)> = BinaryHeap::new();
        let time = |oid: Oid| repo.find_commit(oid).map(|c| c.time().seconds()).unwrap_or(0);

        for (bit, (_, oid)) in tips.iter().enumerate() {
            let mask = masks.entry(*oid).or_insert_with(|| vec![0; words]);
            mask[bit / 64] |= 1 << (bit % 64);
            if queued.insert(*oid) {
                heap.push((time(*oid), *oid));
            }
        }
        for (oid, mask) in &masks {
            if *mask != full {
                partial.insert(*oid);
            }
        }

        // Newest first. Clock skew can visit a parent before its child; the parent is
        // then queued again when the child adds marks to it.
        while let Some((_, oid)) = heap.pop() {
            if partial.is_empty() {
                break;
            }
            if !queued.remove(&oid) {
                continue;
            }
            partial.remove(&oid);
            let mask = masks[&oid].clone();
            let commit = repo.find_commit(oid)?;
            for parent in commit.parent_ids() {
                let entry = masks.entry(parent).or_insert_with(|| vec![0; words]);
                let mut changed = false;
                for (w, m) in entry.iter_mut().zip(&mask) {
                    if *w | m != *w {
                        *w |= m;
                        changed = true;
                    }
                }
                if changed {
                    if *entry == full {
                        partial.remove(&parent);
                    } else {
                        partial.insert(parent);
                    }
                    if queued.insert(parent) {
                        heap.push((time(parent), parent));
                    }
                }
            }
        }

        let mut counts: HashMap<Mask, usize> = HashMap::new();
        for mask in masks.into_values() {
            if mask != full {
                *counts.entry(mask).or_default() += 1;
            }
        }
        Ok(Ancestry {
            index: tips.iter().enumerate().map(|(i, (name, _))| (name.clone(), i)).collect(),
            groups: counts.into_iter().collect(),
        })
    }

    /// Commits reachable from `a` but not from `b`, if both were tips.
    pub(crate) fn ahead(&self, a: &str, b: &str) -> Option<usize> {
        let (a, b) = (*self.index.get(a)?, *self.index.get(b)?);
        Some(self.groups.iter().filter(|(m, _)| has(m, a) && !has(m, b)).map(|(_, c)| c).sum())
    }

    /// `(ahead, behind)` of `a` compared with `b`.
    pub(crate) fn ahead_behind(&self, a: &str, b: &str) -> Option<(usize, usize)> {
        Some((self.ahead(a, b)?, self.ahead(b, a)?))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use git2::{Signature, Time};
    use tempfile::TempDir;

    fn commit(repo: &Repository, at: i64, parents: &[Oid]) -> Oid {
        let sig = Signature::new("A", "a@example.com", &Time::new(at, 0)).unwrap();
        let tree = repo.find_tree(repo.index().unwrap().write_tree().unwrap()).unwrap();
        let parents = parents.iter().map(|p| repo.find_commit(*p).unwrap()).collect::<Vec<_>>();
        repo.commit(None, &sig, &sig, "c", &tree, &parents.iter().collect::<Vec<_>>()).unwrap()
    }

    #[test]
    fn matches_pairwise_counts() {
        let dir = TempDir::new().unwrap();
        let repo = Repository::init(dir.path()).unwrap();
        // root - a1 - a2 - merge
        //     \- b1 - b2 /   \- c1 (skewed clock: older than its parent)
        let root = commit(&repo, 100, &[]);
        let a1 = commit(&repo, 200, &[root]);
        let a2 = commit(&repo, 300, &[a1]);
        let b1 = commit(&repo, 250, &[root]);
        let b2 = commit(&repo, 350, &[b1]);
        let merge = commit(&repo, 400, &[a2, b2]);
        let c1 = commit(&repo, 50, &[b2]);
        let tips = [("a", a2), ("b", b2), ("m", merge), ("c", c1), ("root", root)]
            .map(|(n, o)| (n.to_owned(), o));
        let ancestry = Ancestry::compute(&repo, &tips).unwrap();
        for (x, xo) in &tips {
            for (y, yo) in &tips {
                assert_eq!(
                    ancestry.ahead_behind(x, y).unwrap(),
                    repo.graph_ahead_behind(*xo, *yo).unwrap(),
                    "{x} vs {y}"
                );
            }
        }
        assert_eq!(ancestry.ahead("a", "missing"), None);
    }
}
