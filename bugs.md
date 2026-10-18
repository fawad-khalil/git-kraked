# Known bugs and limitations

Open problems in GitKraked, most noticeable first. Remove an entry when it's fixed and note
the fix in [tech-registry.md](tech-registry.md).

## Bugs

| # | Problem | Where | Workaround |
| --- | --- | --- | --- |
| 1 | Cancelling a clone on Windows can leave a partly cloned folder if Windows still has files in it locked when the app tries to delete it. | `clone.rs` | Delete the folder by hand. |
| 2 | A cherry-pick of a merge commit fails with Git's own "is a merge but no -m option was given" message. | `cherry.rs` | Pick the commits that were merged instead, or use `git cherry-pick -m 1` in a terminal. |
| 3 | The commit graph doesn't notice commits made outside the app until Refresh; only the working changes refresh when the window regains focus. | `App.tsx` | Press Refresh. |
| 4 | "Pull from" a remote branch fetches only that remote branch, so other remote branches stay stale until Fetch. | `sync.rs` | Press Fetch. |
| 5 | After a quick refresh (e.g. checkout), the graph's lane layout isn't recomputed, so a commit that a deleted ref made unreachable can stay listed until Refresh. Deleting a branch always does a full reload, so this needs a ref removed outside the app. | `App.tsx` | Press Refresh. |

## Limitations

- **Git hooks don't run** for commits made in the app (they're written with libgit2). Merges
  finished in the app and amends don't run hooks either. Operations that run `git` (pull,
  cherry-pick, clone, worktrees) do run hooks.
- **Commit signing** (GPG or SSH) isn't applied to commits made in the app.
- **Parent branch is a best guess** for branches not created in the app; it can be wrong.
  Right-click the right branch and choose "Set as parent of …".
- **Tags can only be checked out**, not created, deleted or pushed, from the app yet.
- **Switching repository tabs reloads the repository** (about 0.2 s for 20,000 commits) and
  doesn't keep the graph's scroll position, the selected commit or an open diff.
- **A tab whose folder was moved or deleted** shows an error when selected; close it with ×.
- **A new repository has no commits**, so there's no branch to show in the left panel until the
  first commit.
- **The uncommitted-changes row** joins HEAD with a dashed line only when HEAD's commit is in
  the first 200 rows.
- **Filtered history shows dots only**, without the graph lines.
- **Very wide graphs are clipped** at 320px unless the Graph column is widened by hand.
- **History is capped at 200,000 commits** per repository.
- **Rebase conflicts can't be resolved in the app:** a rebase pull or rebase pull-from that
  conflicts is undone; pull with merge instead.
- **WSL repositories** run Windows `git` over `\\wsl$` paths, which is slow and can fail;
  full WSL support is planned for v2.
- **Clone progress** isn't shown for clones from a local folder path (Git doesn't report it).
- **Not yet run on macOS or Linux**, and the latest round hasn't been tried on Windows; tests
  run on Linux with a mocked UI.
