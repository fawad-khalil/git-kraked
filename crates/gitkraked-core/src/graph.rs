//! Lane layout for the commit graph.
//!
//! Commits arrive newest first in topological order (children before parents). Each
//! commit gets a column, and every row records the line segments that run from its
//! centre down to the next row's centre. The UI only has to draw those segments.

use serde::{Serialize, Serializer};

/// One segment between this row and the next, in column units.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Edge {
    /// Column at this row where the segment starts.
    pub from: usize,
    /// Column at the next row where the segment ends.
    pub to: usize,
    /// The lane the line belongs to; the UI colours segments by lane.
    pub lane: usize,
}

/// Sent as `[from, to, lane]`: a busy row has a hundred edges, so field names would
/// triple the size of every page the UI fetches.
impl Serialize for Edge {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        (self.from, self.to, self.lane).serialize(serializer)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct GraphRow {
    /// Column of this commit's dot.
    pub column: usize,
    /// Segments from this row down to the next one. Lines whose commit is beyond the
    /// loaded history continue straight down out of the last row.
    pub edges: Vec<Edge>,
}

/// A line waiting for the commit `target`. It currently sits in `lane` and left the
/// previous row at column `from`.
struct Pending<'a, Id> {
    target: &'a Id,
    from: usize,
    lane: usize,
}

/// Lays out commits given as `(id, parent ids)`, newest first, children before parents.
pub fn layout<Id: Eq>(commits: &[(Id, Vec<Id>)]) -> Vec<GraphRow> {
    // lanes[i] = the commit the line in column i is heading for.
    let mut lanes: Vec<Option<&Id>> = Vec::new();
    let mut pending: Vec<Pending<Id>> = Vec::new();
    let mut rows: Vec<GraphRow> = Vec::with_capacity(commits.len());

    for (id, parents) in commits {
        // A branch tip nobody points at yet starts in the first free column.
        let column = lanes
            .iter()
            .position(|l| *l == Some(id))
            .unwrap_or_else(|| claim_free(&mut lanes));

        // Lines from the previous row end here: at the dot if they were waiting for
        // this commit, otherwise straight down their own lane.
        if let Some(previous) = rows.last_mut() {
            previous.edges = pending
                .iter()
                .map(|p| Edge {
                    from: p.from,
                    to: if p.target == id { column } else { p.lane },
                    lane: p.lane,
                })
                .collect();
        }

        // Every lane that was waiting for this commit has arrived.
        for lane in lanes.iter_mut() {
            if *lane == Some(id) {
                *lane = None;
            }
        }

        let mut next = Vec::new();
        for (j, lane) in lanes.iter().enumerate() {
            if let Some(target) = lane {
                next.push(Pending { target: *target, from: j, lane: j });
            }
        }

        if let Some((first, rest)) = parents.split_first() {
            // The first parent carries on in this commit's column, unless another lane is
            // already heading for it: then the line joins that lane right away. Without
            // this, every topic branch forked from a shared base keeps its own line all
            // the way down, and a busy repo grows hundreds of columns wide.
            let lane = match lanes.iter().position(|l| *l == Some(first)) {
                Some(existing) => existing,
                None => {
                    lanes[column] = Some(first);
                    column
                }
            };
            next.push(Pending { target: first, from: column, lane });

            // Merged-in parents likewise join the lane heading for them, or open a new one.
            for parent in rest {
                let lane = lanes
                    .iter()
                    .position(|l| *l == Some(parent))
                    .unwrap_or_else(|| {
                        let free = claim_free(&mut lanes);
                        lanes[free] = Some(parent);
                        free
                    });
                next.push(Pending { target: parent, from: column, lane });
            }
        }

        while lanes.last() == Some(&None) {
            lanes.pop();
        }

        pending = next;
        rows.push(GraphRow { column, edges: Vec::new() });
    }

    // Lines still open after the last row lead to commits that weren't loaded.
    if let Some(last) = rows.last_mut() {
        last.edges = pending
            .iter()
            .map(|p| Edge { from: p.from, to: p.lane, lane: p.lane })
            .collect();
    }

    rows
}

fn claim_free<Id>(lanes: &mut Vec<Option<&Id>>) -> usize {
    match lanes.iter().position(Option::is_none) {
        Some(free) => free,
        None => {
            lanes.push(None);
            lanes.len() - 1
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rows(commits: &[(&str, &[&str])]) -> Vec<GraphRow> {
        let commits = commits
            .iter()
            .map(|(id, parents)| (*id, parents.to_vec()))
            .collect::<Vec<_>>();
        layout(&commits)
    }

    fn edge(from: usize, to: usize, lane: usize) -> Edge {
        Edge { from, to, lane }
    }

    #[test]
    fn straight_history_is_one_lane() {
        let r = rows(&[("c", &["b"]), ("b", &["a"]), ("a", &[])]);
        assert_eq!(r.iter().map(|r| r.column).collect::<Vec<_>>(), [0, 0, 0]);
        assert_eq!(r[0].edges, [edge(0, 0, 0)]);
        assert_eq!(r[1].edges, [edge(0, 0, 0)]);
        assert!(r[2].edges.is_empty());
    }

    #[test]
    fn merge_opens_a_lane_that_closes_at_the_fork() {
        //  m        merge of a feature branch
        //  |\
        //  x f
        //  |/
        //  r
        let r = rows(&[("m", &["x", "f"]), ("x", &["r"]), ("f", &["r"]), ("r", &[])]);
        assert_eq!(r.iter().map(|r| r.column).collect::<Vec<_>>(), [0, 0, 1, 0]);
        assert_eq!(r[0].edges, [edge(0, 0, 0), edge(0, 1, 1)]);
        assert_eq!(r[1].edges, [edge(1, 1, 1), edge(0, 0, 0)]);
        // f's line bends back into the main lane, which is already heading for r.
        assert_eq!(r[2].edges, [edge(0, 0, 0), edge(1, 0, 0)]);
        assert!(r[3].edges.is_empty());
    }

    #[test]
    fn two_tips_on_one_parent_join_at_the_parent() {
        let r = rows(&[("main", &["base"]), ("topic", &["base"]), ("base", &[])]);
        assert_eq!(r.iter().map(|r| r.column).collect::<Vec<_>>(), [0, 1, 0]);
        assert_eq!(r[0].edges, [edge(0, 0, 0)]);
        // topic's line joins main's lane as soon as it leaves topic.
        assert_eq!(r[1].edges, [edge(0, 0, 0), edge(1, 0, 0)]);
    }

    #[test]
    fn freed_columns_are_reused() {
        // After the feature lane closes, a later tip takes column 1 again, not column 2.
        let r = rows(&[
            ("m", &["x", "f"]),
            ("f", &["x"]),
            ("x", &["y"]),
            ("tip", &["y"]),
            ("y", &[]),
        ]);
        assert_eq!(r.iter().map(|r| r.column).collect::<Vec<_>>(), [0, 1, 0, 1, 0]);
    }

    #[test]
    fn lines_to_unloaded_commits_run_off_the_bottom() {
        let r = rows(&[("b", &["a"])]);
        assert_eq!(r[0].edges, [edge(0, 0, 0)]);
    }

    #[test]
    fn merge_into_a_lane_already_heading_for_the_parent() {
        // m merges p, which t's lane is already waiting for: no third lane opens.
        let r = rows(&[("t", &["p"]), ("m", &["x", "p"]), ("x", &["p"]), ("p", &[])]);
        assert_eq!(r.iter().map(|r| r.column).collect::<Vec<_>>(), [0, 1, 1, 0]);
        assert_eq!(r[1].edges, [edge(0, 0, 0), edge(1, 1, 1), edge(1, 0, 0)]);
    }
}
