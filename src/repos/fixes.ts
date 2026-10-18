import { CommandError, addRemote, asCommandError, getIdentity, openTerminal, setIdentity } from "../api";
import { chooseDialog, errorDialog, formDialog } from "../ui/dialogs";

// Errors the app can help fix: Git doesn't know who you are, the repository has no remote,
// or Git couldn't sign in. Each gets a pop-up offering the fix instead of a bare error.

/**
 * Shows a failed command's error, offering a fix when there is one. Resolves true when it was
 * fixed and the caller should try again.
 */
export async function offerFix(e: unknown, repoPath: string, title = "That didn't work"): Promise<boolean> {
  const error: CommandError = asCommandError(e);
  switch (error.kind) {
    case "noIdentity": {
      const fix = await chooseDialog({
        title: "Who's committing?",
        message: `${error.message}.\n\nSet your name and email once. Use the email of your GitHub (or other) account so your commits are linked to you.`,
        tone: "warning",
        dismissValue: false,
        actions: [
          { label: "Cancel", value: false },
          { label: "Set name and email…", value: true, primary: true },
        ],
      });
      return fix && editIdentity(repoPath);
    }
    case "noRemote": {
      const fix = await chooseDialog({
        title: "No remote yet",
        message: `${capitalize(error.message)}.\n\nA remote is this repository's copy on a server such as GitHub. Create a repository there, copy its URL and add it here.`,
        tone: "warning",
        dismissValue: false,
        actions: [
          { label: "Cancel", value: false },
          { label: "Add a remote…", value: true, primary: true },
        ],
      });
      return fix && (await addRemoteDialog(repoPath)) !== null;
    }
    case "signIn":
      for (;;) {
        const choice = await chooseDialog<"close" | "terminal" | "retry">({
          title: "Sign-in needed",
          message: `${error.message}\n\nTo fix it, open a terminal here and run git fetch once. Git asks you to sign in (or uses your SSH key) and remembers it. Then try again.`,
          tone: "warning",
          copyable: true,
          dismissValue: "close",
          actions: [
            { label: "Close", value: "close" },
            { label: "Open terminal", value: "terminal" },
            { label: "Try again", value: "retry", primary: true },
          ],
        });
        if (choice !== "terminal") return choice === "retry";
        try {
          await openTerminal(repoPath);
        } catch (err) {
          await errorDialog(asCommandError(err).message, "Couldn't open a terminal");
        }
      }
    default:
      await errorDialog(error.message, title);
      return false;
  }
}

/**
 * Asks for the name and email commits are made with, for this repository or all of them.
 * Resolves true when saved.
 */
export async function editIdentity(repoPath: string): Promise<boolean> {
  const current = await getIdentity(repoPath).catch(() => null);
  const values = await formDialog({
    title: "Your name and email",
    message: "Git records these in every commit you make.",
    fields: [
      { name: "name", label: "Name", value: current?.name ?? "", placeholder: "Ada Lovelace" },
      { name: "email", label: "Email", value: current?.email ?? "", placeholder: "ada@example.com" },
    ],
    choice: {
      name: "scope",
      label: "Use them for",
      value: current?.local ? "repository" : "global",
      options: [
        { value: "global", label: "All my repositories", hint: "git config --global" },
        { value: "repository", label: "This repository only", hint: "e.g. a work email for work projects" },
      ],
    },
    submitLabel: "Save",
  });
  if (!values) return false;
  try {
    await setIdentity(repoPath, values.name, values.email, values.scope === "repository" ? "repository" : "global");
    return true;
  } catch (err) {
    await errorDialog(asCommandError(err).message, "Couldn't save your name and email");
    return false;
  }
}

/** Asks for a remote's name and URL and adds it. Resolves to its name, or null. */
export async function addRemoteDialog(repoPath: string, suggestedName = "origin"): Promise<string | null> {
  const values = await formDialog({
    title: "Add a remote",
    message: "Paste the URL of the repository on GitHub (or another server). HTTPS and SSH URLs both work.",
    fields: [
      { name: "url", label: "URL", placeholder: "https://github.com/you/project.git" },
      { name: "name", label: "Name", value: suggestedName },
    ],
    submitLabel: "Add remote",
  });
  if (!values) return null;
  try {
    await addRemote(repoPath, values.name, values.url);
    return values.name.trim();
  } catch (err) {
    await errorDialog(asCommandError(err).message, "Couldn't add the remote");
    return null;
  }
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
