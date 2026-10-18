import { useEffect, useRef, useSyncExternalStore } from "react";

// In-app pop-ups for errors and confirmations. Call `confirmDialog`, `errorDialog` or
// `chooseDialog` from anywhere; `<DialogHost />` (rendered once by the app) shows them one at
// a time, in the order they were asked.

export type DialogTone = "info" | "warning" | "danger" | "error";

export interface DialogAction<T> {
  label: string;
  value: T;
  /** The highlighted button, chosen by Enter. */
  primary?: boolean;
  /** A destructive action, shown in red. */
  danger?: boolean;
}

interface Request {
  title: string;
  message: string;
  tone: DialogTone;
  actions: DialogAction<unknown>[];
  /** What Escape, the backdrop and the close button answer. */
  dismissValue: unknown;
  /** Offer a "Copy details" button (for errors people may want to paste somewhere). */
  copyable: boolean;
  resolve: (value: unknown) => void;
}

const queue: Request[] = [];
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

/** Shows a dialog with the given buttons and resolves to the chosen button's value. */
export function chooseDialog<T>(options: {
  title: string;
  message: string;
  tone?: DialogTone;
  actions: DialogAction<T>[];
  dismissValue: T;
  copyable?: boolean;
}): Promise<T> {
  return new Promise<T>((resolve) => {
    queue.push({
      title: options.title,
      message: options.message,
      tone: options.tone ?? "info",
      actions: options.actions,
      dismissValue: options.dismissValue,
      copyable: options.copyable ?? false,
      resolve: resolve as (value: unknown) => void,
    });
    notify();
  });
}

/** Asks a yes/no question; resolves true for the confirm button. */
export function confirmDialog(options: {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Destructive: the confirm button is red and the dialog is marked as a warning. */
  danger?: boolean;
}): Promise<boolean> {
  return chooseDialog({
    title: options.title,
    message: options.message,
    tone: options.danger ? "danger" : "info",
    dismissValue: false,
    actions: [
      { label: options.cancelLabel ?? "Cancel", value: false },
      { label: options.confirmLabel ?? "OK", value: true, primary: true, danger: options.danger },
    ],
  });
}

/** Shows an error with an OK button (and Copy details). */
export function errorDialog(message: string, title = "Something went wrong"): Promise<void> {
  return chooseDialog<void>({
    title,
    message,
    tone: "error",
    copyable: true,
    dismissValue: undefined,
    actions: [{ label: "OK", value: undefined, primary: true }],
  });
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const ICONS: Record<DialogTone, string> = { info: "i", warning: "!", danger: "!", error: "×" };

/** Renders the dialog at the front of the queue. */
export function DialogHost() {
  const current = useSyncExternalStore(subscribe, () => queue[0]);
  const primaryRef = useRef<HTMLButtonElement>(null);
  const copiedRef = useRef<HTMLButtonElement>(null);

  function answer(value: unknown) {
    const request = queue.shift();
    notify();
    request?.resolve(value);
  }

  useEffect(() => {
    if (!current) return;
    primaryRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        answer(current.dismissValue);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [current]);

  if (!current) return null;
  return (
    <div className="overlay modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && answer(current.dismissValue)}>
      <div className={`dialog modal tone-${current.tone}`} role="alertdialog" aria-modal="true" aria-labelledby="modal-title" aria-describedby="modal-message">
        <div className="modal-head">
          <span className="modal-icon" aria-hidden>
            {ICONS[current.tone]}
          </span>
          <h2 id="modal-title">{current.title}</h2>
          <button className="modal-close" aria-label="Close" title="Close (Esc)" onClick={() => answer(current.dismissValue)}>
            ×
          </button>
        </div>
        <p id="modal-message" className="modal-message selectable">
          {current.message}
        </p>
        <div className="dialog-actions">
          {current.copyable && (
            <button
              ref={copiedRef}
              className="modal-copy"
              onClick={() => {
                navigator.clipboard?.writeText(`${current.title}\n${current.message}`);
                if (copiedRef.current) copiedRef.current.textContent = "Copied";
              }}
            >
              Copy details
            </button>
          )}
          <span className="grow" />
          {current.actions.map((a) => (
            <button
              key={a.label}
              ref={a.primary ? primaryRef : undefined}
              className={[a.primary && "primary", a.danger && "danger"].filter(Boolean).join(" ") || undefined}
              onClick={() => answer(a.value)}
            >
              {a.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
