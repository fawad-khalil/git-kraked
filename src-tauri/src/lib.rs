use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};

use gitkraked_core::{Error, History, HistoryRow, RepoSummary, branches, changes, cherry, clone, identity, remotes, stash, sync, tags, worktrees};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

/// The most commits loaded into the graph. Far beyond what most repos have; keeps
/// memory bounded on giant histories until the graph can stream.
const HISTORY_LIMIT: usize = 200_000;

/// What the UI receives when a command fails. `kind` lets it offer a fix for known cases.
#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum CommandError {
    NotOwned { message: String, path: String },
    NoIdentity { message: String },
    NoRemote { message: String },
    SignIn { message: String },
    Other { message: String },
}

impl From<Error> for CommandError {
    fn from(e: Error) -> Self {
        let message = e.to_string();
        match e {
            Error::NotOwned { path } => CommandError::NotOwned { message, path },
            Error::NoIdentity => CommandError::NoIdentity { message },
            Error::NoRemote => CommandError::NoRemote { message },
            Error::SignIn { .. } => CommandError::SignIn { message },
            Error::Git(_) => CommandError::Other { message },
        }
    }
}

type CommandResult<T> = Result<T, CommandError>;

/// The history of the open repo. The UI fetches it a page at a time as it scrolls.
#[derive(Default)]
struct LoadedHistory(Mutex<History>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HistoryMeta {
    total: usize,
    columns: usize,
}

#[tauri::command]
fn init_repo(path: String) -> CommandResult<RepoSummary> {
    Ok(gitkraked_core::init_repo(path)?)
}

#[tauri::command]
fn open_repo(path: String) -> CommandResult<RepoSummary> {
    Ok(gitkraked_core::open_repo(path)?)
}

#[tauri::command]
async fn load_history(path: String, loaded: State<'_, LoadedHistory>) -> CommandResult<HistoryMeta> {
    // async so a large history loads off the main thread and the window stays responsive.
    let history = gitkraked_core::load_history(path, HISTORY_LIMIT)?;
    let meta = HistoryMeta { total: history.rows.len(), columns: history.columns };
    *loaded.0.lock().unwrap() = history;
    Ok(meta)
}

#[tauri::command]
fn history_page(offset: usize, count: usize, loaded: State<'_, LoadedHistory>) -> Vec<HistoryRow> {
    let history = loaded.0.lock().unwrap();
    history.rows.iter().skip(offset).take(count).cloned().collect()
}

/// Refreshes branch and tag labels on the loaded history after refs moved without new
/// commits. Returns false when the history has to be loaded again instead.
#[tauri::command]
async fn relabel_history(path: String, loaded: State<'_, LoadedHistory>) -> CommandResult<bool> {
    Ok(loaded.0.lock().unwrap().relabel(path)?)
}

/// Indexes of the loaded history rows matching `query`; see `History::filter`.
#[tauri::command]
fn filter_history(query: String, loaded: State<'_, LoadedHistory>) -> Vec<usize> {
    loaded.0.lock().unwrap().filter(&query)
}

/// The loaded history rows at `indexes`, for showing a filtered list.
#[tauri::command]
fn history_rows(indexes: Vec<usize>, loaded: State<'_, LoadedHistory>) -> Vec<HistoryRow> {
    let history = loaded.0.lock().unwrap();
    indexes.iter().filter_map(|&i| history.rows.get(i).cloned()).collect()
}

#[tauri::command]
async fn pick_candidates(path: String, branch: String) -> CommandResult<Vec<cherry::PickCandidate>> {
    Ok(cherry::pick_candidates(path, &branch, 500)?)
}

#[tauri::command]
async fn cherry_pick(path: String, ids: Vec<String>) -> CommandResult<String> {
    Ok(cherry::cherry_pick(path, &ids)?)
}

#[tauri::command]
async fn continue_cherry_pick(path: String) -> CommandResult<String> {
    Ok(cherry::continue_cherry_pick(path)?)
}

#[tauri::command]
async fn abort_cherry_pick(path: String) -> CommandResult<()> {
    Ok(cherry::abort_cherry_pick(path)?)
}

// Git work runs in async commands so it stays off the main thread and the window keeps
// responding while a big diff or status is computed.

#[tauri::command]
async fn commit_details(path: String, id: String) -> CommandResult<changes::CommitDetails> {
    Ok(changes::commit_details(path, &id)?)
}

#[tauri::command]
async fn commit_file_diff(path: String, id: String, file: String) -> CommandResult<changes::FileDiff> {
    Ok(changes::commit_file_diff(path, &id, &file)?)
}

#[tauri::command]
async fn working_status(path: String) -> CommandResult<changes::WorkingStatus> {
    Ok(changes::working_status(path)?)
}

#[tauri::command]
async fn working_file_diff(path: String, file: String, staged: bool) -> CommandResult<changes::FileDiff> {
    Ok(changes::working_file_diff(path, &file, staged)?)
}

#[tauri::command]
async fn stage_files(path: String, files: Vec<String>) -> CommandResult<()> {
    Ok(changes::stage_files(path, &files)?)
}

#[tauri::command]
async fn unstage_files(path: String, files: Vec<String>) -> CommandResult<()> {
    Ok(changes::unstage_files(path, &files)?)
}

#[tauri::command]
async fn stage_hunk(path: String, file: String, hunk: usize) -> CommandResult<()> {
    Ok(changes::stage_hunk(path, &file, hunk)?)
}

#[tauri::command]
async fn unstage_hunk(path: String, file: String, hunk: usize) -> CommandResult<()> {
    Ok(changes::unstage_hunk(path, &file, hunk)?)
}

#[tauri::command]
async fn commit(path: String, message: String, amend: bool) -> CommandResult<String> {
    Ok(changes::commit(path, &message, amend)?)
}

#[tauri::command]
async fn list_branches(path: String) -> CommandResult<branches::Branches> {
    Ok(branches::list_branches(path)?)
}

#[tauri::command]
async fn create_branch(path: String, name: String, from: Option<String>, checkout: bool) -> CommandResult<()> {
    Ok(branches::create_branch(path, &name, from.as_deref(), checkout)?)
}

#[tauri::command]
async fn list_tags(path: String) -> CommandResult<Vec<tags::Tag>> {
    Ok(tags::list_tags(path)?)
}

#[tauri::command]
async fn checkout_tag(path: String, name: String) -> CommandResult<()> {
    Ok(tags::checkout_tag(path, &name)?)
}

#[tauri::command]
async fn checkout_branch(path: String, name: String) -> CommandResult<()> {
    Ok(branches::checkout_branch(path, &name)?)
}

#[tauri::command]
async fn checkout_remote_branch(path: String, name: String) -> CommandResult<String> {
    Ok(branches::checkout_remote_branch(path, &name)?)
}

#[tauri::command]
async fn rename_branch(path: String, name: String, new_name: String) -> CommandResult<()> {
    Ok(branches::rename_branch(path, &name, &new_name)?)
}

#[tauri::command]
async fn delete_branch(path: String, name: String, force: bool) -> CommandResult<()> {
    Ok(branches::delete_branch(path, &name, force)?)
}

#[tauri::command]
async fn merge_branch(path: String, name: String) -> CommandResult<branches::MergeResult> {
    Ok(branches::merge_branch(path, &name)?)
}

#[tauri::command]
async fn abort_merge(path: String) -> CommandResult<()> {
    Ok(branches::abort_merge(path)?)
}

#[tauri::command]
async fn resolve_conflict(path: String, file: String, side: branches::Side) -> CommandResult<()> {
    Ok(branches::resolve_conflict(path, &file, side)?)
}

#[tauri::command]
async fn fetch(path: String) -> CommandResult<()> {
    Ok(sync::fetch(path)?)
}

#[tauri::command]
async fn pull(path: String, mode: sync::PullMode) -> CommandResult<String> {
    Ok(sync::pull(path, mode)?)
}

#[tauri::command]
async fn pull_from(path: String, parent: String, mode: sync::PullMode) -> CommandResult<String> {
    Ok(sync::pull_from(path, &parent, mode)?)
}

#[tauri::command]
async fn set_parent_branch(path: String, branch: String, parent: String) -> CommandResult<()> {
    Ok(branches::set_parent_branch(path, &branch, &parent)?)
}

#[tauri::command]
async fn push(path: String) -> CommandResult<String> {
    Ok(sync::push(path)?)
}

#[tauri::command]
async fn list_stashes(path: String) -> CommandResult<Vec<stash::StashEntry>> {
    Ok(stash::list_stashes(path)?)
}

#[tauri::command]
async fn stash_save(path: String, message: Option<String>) -> CommandResult<()> {
    Ok(stash::stash_save(path, message.as_deref())?)
}

#[tauri::command]
async fn stash_apply(path: String, index: usize, pop: bool) -> CommandResult<()> {
    Ok(stash::stash_apply(path, index, pop)?)
}

#[tauri::command]
async fn stash_drop(path: String, index: usize) -> CommandResult<()> {
    Ok(stash::stash_drop(path, index)?)
}

#[tauri::command]
async fn list_worktrees(path: String) -> CommandResult<Vec<worktrees::Worktree>> {
    Ok(worktrees::list_worktrees(path)?)
}

#[tauri::command]
async fn add_worktree(path: String, dest: String, branch: String, new_branch: bool) -> CommandResult<()> {
    Ok(worktrees::add_worktree(path, &dest, &branch, new_branch)?)
}

#[tauri::command]
async fn remove_worktree(path: String, worktree: String, force: bool) -> CommandResult<()> {
    Ok(worktrees::remove_worktree(path, &worktree, force)?)
}

#[tauri::command]
async fn prune_worktrees(path: String) -> CommandResult<()> {
    Ok(worktrees::prune_worktrees(path)?)
}

/// Set by `cancel_clone` to stop the clone in progress.
#[derive(Default)]
struct CloneCancel(AtomicBool);

/// Clones a repository, sending `clone-progress` events as it goes. Returns the new path.
#[tauri::command]
async fn clone_repo(
    url: String,
    parent: String,
    name: String,
    app: AppHandle,
    cancel: State<'_, CloneCancel>,
) -> CommandResult<String> {
    cancel.0.store(false, Ordering::Relaxed);
    let path = clone::clone_repo(&url, parent, &name, &cancel.0, |progress| {
        let _ = app.emit("clone-progress", progress);
    })?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
fn cancel_clone(cancel: State<'_, CloneCancel>) {
    cancel.0.store(true, Ordering::Relaxed);
}

#[tauri::command]
fn trust_repo(path: String) -> CommandResult<String> {
    Ok(gitkraked_core::trust_repo(path)?)
}

#[tauri::command]
fn get_identity(path: String) -> CommandResult<identity::Identity> {
    Ok(identity::identity(path)?)
}

#[tauri::command]
fn set_identity(path: String, name: String, email: String, scope: identity::IdentityScope) -> CommandResult<()> {
    Ok(identity::set_identity(path, &name, &email, scope)?)
}

#[tauri::command]
fn add_remote(path: String, name: String, url: String) -> CommandResult<()> {
    Ok(remotes::add_remote(path, &name, &url)?)
}

/// Opens the system terminal in `path`, e.g. so `git push` can ask for a sign-in once.
#[tauri::command]
fn open_terminal(path: String) -> CommandResult<()> {
    use std::process::Command;
    let failed = |e: std::io::Error| CommandError::Other { message: format!("couldn't open a terminal: {e}") };
    #[cfg(windows)]
    {
        // Windows Terminal when it's installed, otherwise a classic console window.
        if Command::new("wt.exe").args(["-d", &path]).spawn().is_ok() {
            return Ok(());
        }
        Command::new("cmd").args(["/C", "start", "", "cmd", "/K"]).current_dir(&path).spawn().map_err(failed)?;
        Ok(())
    }
    #[cfg(target_os = "macos")]
    {
        Command::new("open").args(["-a", "Terminal", &path]).spawn().map_err(failed)?;
        Ok(())
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        // Each opens in its current directory.
        let candidates = ["x-terminal-emulator", "gnome-terminal", "konsole", "xfce4-terminal", "alacritty", "kitty", "xterm"];
        let mut last = None;
        for program in candidates {
            match Command::new(program).current_dir(&path).spawn() {
                Ok(_) => return Ok(()),
                Err(e) => last = Some(e),
            }
        }
        Err(failed(last.unwrap_or_else(|| std::io::Error::other("no terminal found"))))
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(LoadedHistory::default())
        .manage(CloneCancel::default())
        .invoke_handler(tauri::generate_handler![
            open_repo,
            init_repo,
            load_history,
            history_page,
            filter_history,
            relabel_history,
            history_rows,
            pick_candidates,
            cherry_pick,
            continue_cherry_pick,
            abort_cherry_pick,
            trust_repo,
            get_identity,
            set_identity,
            add_remote,
            open_terminal,
            commit_details,
            commit_file_diff,
            working_status,
            working_file_diff,
            stage_files,
            unstage_files,
            stage_hunk,
            unstage_hunk,
            commit,
            list_branches,
            create_branch,
            checkout_branch,
            list_tags,
            checkout_tag,
            checkout_remote_branch,
            rename_branch,
            delete_branch,
            merge_branch,
            abort_merge,
            resolve_conflict,
            fetch,
            pull,
            push,
            pull_from,
            set_parent_branch,
            list_stashes,
            stash_save,
            stash_apply,
            stash_drop,
            clone_repo,
            cancel_clone,
            list_worktrees,
            add_worktree,
            remove_worktree,
            prune_worktrees,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
