# Tech registry

What GitKraked is built with, how it fits together, the decisions behind it, and every
change so far. Add to the change log with each change; record a decision when one is made.

## Stack

| Layer | Technology | Version | Why |
| --- | --- | --- | --- |
| Desktop shell | Tauri | 2 | Small installers and native webviews on Windows, macOS and Linux; Rust backend. |
| Git engine | git2 (libgit2), vendored | 0.21 | Fast, in-process reads: history, diffs, status, staging, commits, branches. Vendored so users need no libgit2 install. |
| Git CLI | the user's `git` | any recent | Network and multi-step operations (see "Two Git engines"). |
| UI | React + TypeScript | 19 / 6.0 | Component model; types mirror the Rust structs. |
| Bundler | Vite | 8 | Fast dev server on port 1420, which Tauri loads. |
| Tests | cargo test, Vitest | –, 5 | Core Git logic against real temporary repos; pure UI helpers. |
| Dialogs | @tauri-apps/plugin-dialog | 2 | Folder pickers and confirm prompts. Capabilities: `dialog:allow-open`, `dialog:allow-ask`. |
| Errors | thiserror | 2 | `Error::NotOwned` / `Error::Git`, sent to the UI as `{ kind, message }`. |
| Test fixtures | tempfile | 3 | Throwaway repositories in tests. |

Licence: MIT OR Apache-2.0. Rust edition 2024 (needs Rust 1.88+ for let-chains).

## Architecture

```
src/ (React UI)  ──invoke──▶  src-tauri/src/lib.rs (commands)  ──▶  crates/gitkraked-core
   api.ts mirrors every          async commands keep Git work         graph, changes, branches,
   command and struct            off the main thread                  sync, stash, clone, cherry,
                                                                      worktrees
```

### Core modules (`crates/gitkraked-core/src`)

| Module | Responsibility |
| --- | --- |
| `lib.rs` | Open/discover repos, `safe.directory` trust, history loading, ref and stash labels, history filter. |
| `graph.rs` | Lane layout for the commit graph; edges serialised as `[from, to, lane]`. |
| `changes.rs` | Commit details, diffs, working status, staging files and hunks, commit/amend. |
| `branches.rs` | List/create/checkout/rename/delete/merge branches, conflict sides, parent-branch detection. |
| `sync.rs` | Fetch, pull, pull-from-branch, push via `git`; the shared `git_command` runner and error explanations. |
| `tags.rs` | List tags; check one out with a detached HEAD. |
| `ancestry.rs` | One history walk that answers ahead/behind for every pair of branch tips. |
| `stash.rs` | Stash save/apply/pop/drop, labels in the graph. |
| `clone.rs` | `git clone --progress`, progress parsing, cancellation. |
| `cherry.rs` | Pick candidates (`git cherry`), cherry-pick, continue, abort. |
| `worktrees.rs` | List/add/remove/prune worktrees via `git worktree`. |

### UI (`src/`)

| Path | Responsibility |
| --- | --- |
| `App.tsx` | Layout, repo loading, toolbar, centre view switch, dialogs, commit menu. |
| `api.ts` | Typed wrappers for every Tauri command. |
| `prefs.ts` | `usePref`: small UI settings in localStorage, shared live between components. |
| `graph/` | Virtualised canvas commit graph, resizable columns, filter. |
| `changes/` | File lists (list/tree), staging panel, commit panel, diff view (inline/split). |
| `repos/` | Repository tabs and their labels. |
| `branches/` | Left panel, branch tree view, branch capsule, worktree dialog. |
| `sync/` | Fetch, pull, pull-from, push, stash buttons. |
| `clone/`, `cherry/` | Clone and cherry-pick dialogs. |
| `ui/` | `Section` (collapsible), `PaneResizer`, `ThemeSwitch` (light/dark toggle and theme menu), `themes` (theme list), `ListFilter`, toolbar `icons`, `dialogs` (pop-ups). |

## Key decisions

- **Clean-room.** Behaviour comes from Git's public documentation and observed `git`
  behaviour; nothing is taken from other Git clients.
- **Two Git engines.** libgit2 for fast local reads and simple writes; the user's `git` for
  fetch, pull, push, clone, cherry-pick, worktrees and `git cherry`, so credential helpers,
  SSH config, proxies and Git's own sequencing apply. `git` runs with `GIT_TERMINAL_PROMPT=0`,
  `GIT_EDITOR=true`, stdin closed and, on Windows, `CREATE_NO_WINDOW`.
- **History.** Ordered TOPOLOGICAL|TIME; up to 200,000 commits loaded in the backend and paged
  to the UI 200 rows at a time; graph drawn on a canvas for visible rows only. A first-parent
  line joins an existing lane heading for the same commit, halving width on large repos.
- **Quick refresh after ref-only operations.** Checkout, branch create/rename, tag checkout and
  stash apply/drop don't add or remove commits, so the app keeps the loaded history and only
  re-labels it (`relabel_history`); it falls back to a full reload when a label points at a
  commit that isn't loaded. History includes `refs/tags/*` so tags can be labelled.
- **Ahead/behind for many branches** (`ancestry.rs`): one walk from all branch tips gives each
  commit a bitmask of the tips that reach it; counts come from grouping commits by mask.
  Cached per repository and set of tips. Replaced one `graph_ahead_behind` per pair, which
  took 5.4 s on a 20,000-commit repo with many branches (now 0.13 s, 4 ms cached).
- **Loader.** Every Git operation from the UI goes through `runTask` in `App.tsx`: a top progress
  bar and a status pill, clicks blocked, the window dimmed only after 250 ms so quick operations
  don't flash.
- **Themes.** Colours are CSS tokens in layers (`--bg` → `--sidebar` → `--panel` → `--inset` /
  `--raised`) with shadow tokens. Dark values apply under `prefers-color-scheme: dark` unless
  `<html data-theme>` is set, or always with `data-theme="dark"`. `ThemeSwitch` always sets the
  resolved theme: the mode pref (`theme`: system/light/dark) picks between the `theme.light`
  and `theme.dark` prefs, with a `prefers-color-scheme` listener for System (`appliedTheme` in
  `ui/themes.ts`). Named themes (`lavender`, `solarized-light`, `solarized-dark`, `nord`,
  `dracula`) are each one `:root[data-theme=…]` block that
  redefines every token, so adding a theme is one CSS block plus one entry in `ui/themes.ts`. Text on accent colours uses `--on-accent` so each theme picks a readable one.
- **Toolbar** is icon-only to fit on one row; icons are inline SVG in `ui/icons.tsx` drawn in
  `currentColor` so they follow the theme. Tooltips are CSS (`data-tip` attribute, shown after
  350 ms on hover or keyboard focus), not the browser's `title`, so they appear quickly and
  match the theme. Pull's options (merge/rebase, pull from another branch) live in a popover.
- **Several repositories.** Open repositories are tabs; the list and the active one are prefs
  (`repos.open`, `repos.active`) and the active one reopens on start. The backend keeps one
  loaded history, so switching tabs reloads the repository; each `load` takes a token and drops
  results of a load that a newer one overtook, so quick tab switches can't mix repositories.
  `usePref` now also stores arrays and takes update functions.
- **Pop-ups instead of native dialogs.** Confirmations and errors use the app's own dialogs
  (`ui/dialogs.tsx`: `confirmDialog`, `errorDialog`, `chooseDialog`, shown one at a time by
  `DialogHost`) so they match the theme and can offer specific actions (Trust and open, Close
  its tab). The Tauri dialog plugin is now only used for folder pickers.
- **New repository** uses libgit2's init; the first branch name follows Git's
  `init.defaultBranch`. Picking a folder that's already a repository just opens it.
- **Filtered history** is computed in the backend over the loaded rows; filtered rows show dots
  without lines because neighbouring rows are no longer parent and child.
- **Parent branch** (Git has no such concept), in order: saved `branch.<name>.gitkrakedParent`
  (set when the app creates a branch, or via "Set as parent"); Git's reflog ("branch: Created
  from X" or "checkout: moving from X to name"); the nearest branch by shared history (topic
  branches only, trunks preferred); else `origin/HEAD`, main or master.
- **Pull safety.** A rebase pull that conflicts is aborted so nothing changes. Merge pulls never
  use `--autostash`: the app finishes merges with libgit2, which would never restore Git's
  `MERGE_AUTOSTASH`.
- **Cherry-pick** applies picked commits oldest first; on conflicts it stays in progress with
  Continue and Abort; a pick that stops without conflicts is aborted.
- **Worktrees.** Checkout refuses a branch that's open in another worktree before touching any
  file (libgit2 would otherwise change files and only then fail).
- **WSL.** v1 only offers "Trust this folder" (adds `safe.directory`). Full WSL support is v2.
- **Window.** The page never scrolls; each pane scrolls. `dragDropEnabled: false` in
  `tauri.conf.json` so HTML drag and drop (drag-to-merge) works in WebView2 on Windows.
- **UI preferences** (list/tree, collapsed sections, column and pane widths, diff layout, pull
  mode, centre view) are per machine in localStorage.

## Change log

### 2026-10-18 — Round 8
- More themes: Lavender and Solarized Light for light mode; Solarized Dark, Nord and Dracula
  for dark mode. The System / Light / Dark toggle stays; a palette menu chooses which theme
  each mode uses, and System switches between them when the OS does.
- Named themes are no longer overridden by the OS dark setting.

### 2026-10-18 — Round 7
- Errors and confirmations are pop-ups with action buttons instead of red text on the page or
  native message boxes; destructive actions have red buttons; errors can be copied.
- A repository that fails to open offers its fix (trust the folder) or a way out (close its
  tab, open another folder).
- Errors that stay inside a panel or form are shown in a tinted box.

### 2026-10-18 — Round 6
- Repository tabs: open several repositories, switch, close (× or middle-click); remembered
  across restarts, last one reopened.
- Opening, cloning and creating repositories show the loader.
- README: build-from-source steps for Windows, macOS and Linux.
- Git history started on the owner's PC; work is committed in small pieces from now on.

### 2026-10-18 — Round 5
- Toolbar redone as icon buttons with tooltips: Open, New (+: create or clone), Refresh,
  Fetch, Pull (with an options popover), Push, Stash, Pop, Cherry-pick; dividers between
  groups. Network and stash operations now use the app's loader.
- New repository (`init_repo`), from the + menu or the new start screen.
- Filters on the Local, Remotes and Tags lists.
- README: toolbar guide and the next plan.

### 2026-10-18 — Round 4
- Uncommitted changes shown as the first row of the commit graph, joined to HEAD by a dashed
  line; Author, When and Commit stay empty on that row.
- Tags section in the left panel: double-click to check out, right-click to create a branch
  from a tag, filter when there are more than 8. Core: `tags::list_tags`, `tags::checkout_tag`.
- Faster checkout: branch list ahead/behind via `ancestry.rs` (5.4 s → 0.13 s on the bench
  repo); quick re-label of the loaded history instead of reloading it.
- Loader for checkouts, merges, cherry-picks and opening worktrees instead of a half-updated UI.
- Visual redesign: layered surfaces, raised buttons with shadows, hover/pressed/focus states,
  sunken fields, segmented controls, accent edge on selected rows, animated menus and dialogs.
- Theme switch (System / Light / Dark) in the toolbar.
- Fixed: remote branches of a remote that's no longer configured broke the branch list.
- Fixed: commit rows could turn into "…" placeholders after any re-render, because the filter
  cleared the fetched rows on startup.

### 2026-10-18 — Round 3
- Resizable Graph, Author, When and Commit columns; resizable left and right panes.
- Commit filter by message, author or id (backend `filter_history` + `history_rows`).
- Exact commit date and time on hover in the When column; author email on hover.
- "Pull from" any local or remote branch, parent first.
- Drag-to-merge: fixed on Windows (`dragDropEnabled: false`), drop target highlighted, confirm
  before merging, clearer hint.
- Cherry-pick: right-click a commit, or a picker for another branch's commits with filter and
  "already applied" detection; Continue/Abort after conflicts.
- Left panel regrouped: Local, Remotes (one section per remote), Stashes, Worktrees.
- Docs: README rewritten, this registry, bugs.md.

### 2026-10-17 — Round 2 (v1 completion and requests)
- Clone with progress bar and cancel.
- Side-by-side diff.
- List/tree toggle for changed files, with folder-level stage/unstage.
- Collapsible sections, remembered.
- Pull from parent branch; parent detection; "Set as parent".
- Git worktrees.
- Branch tree view; parent shown in the top-right branch capsule with ahead/behind.
- Pointer cursor on clickable items; page no longer scrolls as a whole.

### 2026-10-17 — Round 1 (v1 core)
- Scaffold: Tauri + React + Rust workspace, dual licence.
- Open repository; "Trust this folder" for repos owned by another user (WSL).
- Commit graph with lane layout, virtualised canvas, ref badges.
- Commit details, diffs, staging of files and hunks, commit and amend.
- Branches: create, checkout, rename, delete, merge (drag to merge), ours/theirs conflicts.
- Fetch, pull (merge or rebase), push; stash with graph labels.
