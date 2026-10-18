# GitKraked

An open-source, cross-platform desktop Git client with a visual commit graph, for Windows,
macOS and Linux. Built clean-room from public Git behaviour; it contains no code from any
other Git client.

Status: v1 feature-complete, early. See [bugs.md](bugs.md) for known problems and
[tech-registry.md](tech-registry.md) for the technology, design decisions and change log.

## What it does

**Repositories**
- Open a repository folder, create a new empty one, or clone one by URL with a progress bar
  and Cancel.
- Repositories owned by another user (common for WSL folders) can be trusted with one click.
- Worktrees: create one for an existing or new branch, open it, remove it, prune missing ones.

**History**
- The full history as a commit graph, smooth even with 100,000+ commits. Tags are included.
- Uncommitted changes are the first row of the graph (`// WIP`); click it to stage and commit.
- Filter commits by message, author or commit id.
- Resize the Graph, Author, When and Commit columns by dragging their edges (double-click
  the Graph edge to fit the lanes again). The side panels resize the same way.
- Hover a time in the When column to see the exact date and time.
- **Branch tree** view: branches nested under the branch each was started from, with how far
  ahead and behind its parent each one is.

**Changes**
- Commit details and diffs, inline or side by side.
- Stage and unstage whole files, whole folders (tree view) or single hunks.
- Changed files as a flat list or a folder tree.
- Commit and amend.

**Branches**
- Create, check out, rename, delete; check out remote branches as tracking branches.
- Checkouts, merges and other Git operations show a loader and block clicks until the window
  has caught up, so nothing stale can be clicked.
- Merge, with per-file "ours / theirs" conflict resolution.
- Cherry-pick a single commit (right-click it in the graph) or pick several from another
  branch's commits, with a filter.
- The badge at the top right shows the current branch and the branch it came from, e.g.
  `feature | from main ↑4 ↓2`: 4 commits of its own, 2 new ones on main it doesn't have yet.

**Tags**
- The left panel lists tags, newest first, with a filter. Double-click one
  to check it out (you're then not on a branch; Git calls this a detached HEAD), or right-click
  it to create a branch there.

**Remotes and stashes**
- Fetch, pull (merge or rebase) and push, using your own `git` and its credentials.
- **Pull from** brings any other branch into the current one; it suggests the parent branch.
- Stash (untracked files included), pop, apply and delete stashes.

## Toolbar

Every toolbar button is an icon; hover one (or tab to it) for a tooltip saying what it does.
From the left:

| Icon | What it does |
| --- | --- |
| Folder | Open a repository folder. |
| + | Create a new empty repository, or clone one. |
| Circular arrow | Refresh history, branches and changes. |
| Cloud | Fetch from all remotes. |
| Arrow down | Pull. The small arrow next to it chooses merge or rebase, and pulls from another branch (the parent is offered first). |
| Arrow up | Push. |
| Box with arrow in / out | Stash your changes / pop the latest stash. |
| Cherries | Cherry-pick commits from another branch. |

On the right: the repository name, the current branch with its parent, and the theme switch.

## How to merge by dragging

In the left panel, drag any branch (local or remote) onto the **current branch**, the one in
blue. While you drag, the current branch gets a dashed outline that says "drop here to merge";
drop it there and confirm. You can also right-click a branch and choose **Merge into …**.

## Left panel layout

- **Local**: your branches. ⧉ marks a branch checked out in another worktree.
- **Remotes**: one collapsible list per remote (origin, upstream, …).
- **Tags**: double-click to check out.
- **Stashes**: shared by every worktree of the repository, which is why they aren't listed
  under a worktree.
- **Worktrees**: every working folder of this repository; the open one is in blue.

Local, Remotes and Tags each have a filter box: type any part of a name (several words all
have to match); Escape clears it. The current branch always stays in the Local list.

Every section collapses by clicking its header, and the app remembers which ones you closed.

## Light and dark themes

The three icons at the right end of the toolbar switch the theme: a monitor for **System**
(follow your OS setting, the default), a sun for **Light** and a moon for **Dark**. The choice
is remembered.

## Prerequisites

- [Rust](https://rustup.rs/) (stable) and Node.js 20 or newer.
- [Git](https://git-scm.com/) on your PATH. Fetch, pull, push, clone, cherry-pick and worktrees
  run your own `git`, so they use the credentials and SSH keys it already has.
- Tauri's system dependencies for your OS: <https://tauri.app/start/prerequisites/>
  - **Windows:** Microsoft C++ Build Tools ("Desktop development with C++") and WebView2 (preinstalled on Windows 10 and 11).
  - **macOS:** Xcode Command Line Tools (`xcode-select --install`).
  - **Linux (Debian/Ubuntu):** `sudo apt install libwebkit2gtk-4.1-dev librsvg2-dev build-essential`.

## Run it

```sh
npm install
npm run tauri dev
```

On Windows PowerShell, use `npm.cmd install` and `npm.cmd run tauri dev` if scripts are blocked.
The first run compiles libgit2 and Tauri, which takes a few minutes.

## Test it

```sh
cargo test --workspace   # Git logic
npm test                 # UI helpers
```

## Build an installer

```sh
npm run tauri build
```

Installers land in `target/release/bundle/`.

## Layout

| Path | What it is |
| --- | --- |
| `crates/gitkraked-core/` | All Git logic, in Rust, using `git2` (libgit2) and the `git` command. No UI code, fully unit-tested. |
| `src-tauri/` | The Tauri desktop shell. Exposes core functions to the UI as commands. |
| `src/` | The React + TypeScript interface. Calls commands through `src/api.ts`. |

## Next plan

Planned in this order; open to change. Known problems are in [bugs.md](bugs.md).

1. **Try it for real on Windows**, then macOS and Linux, and fix what turns up. Add a CI build
   for all three.
2. **Tags in full:** create (lightweight or annotated), delete, push.
3. **Commits made with `git`**, so hooks and commit signing (GPG/SSH) work, matching what the
   `git` command does.
4. **Conflict editor:** a three-way view to pick lines from each side, not just whole files.
5. **Rebase in the app:** resolve rebase conflicts instead of aborting, then interactive
   rebase (reorder, squash, reword, drop).
6. **File history and blame**, and search inside diffs.
7. **Undo** for the last operation (checkout, merge, commit, branch delete) using Git's reflog.
8. **Keyboard shortcuts** and a command palette.
9. **Several repositories open at once** in tabs, with a recent-repositories list on the start
   screen.
10. **Installers and updates:** signed installers for each OS and automatic updates.
11. **v2:** full WSL support (run Git inside WSL), submodules, Git LFS, hosting integrations
    (pull requests, issues).

## License

Dual-licensed under either of [MIT](LICENSE-MIT) or [Apache-2.0](LICENSE-APACHE), at your option.
