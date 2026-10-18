import { useCallback, useSyncExternalStore } from "react";

// Small UI preferences (list or tree view, collapsed sections), saved in localStorage and
// shared live between every component that reads the same one.

const PREFIX = "gitkraked.";
// Values set this session, so preferences still work when localStorage is unavailable.
const memory = new Map<string, unknown>();
const listeners = new Set<() => void>();

function read<T>(key: string, fallback: T): T {
  if (memory.has(key)) return memory.get(key) as T;
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (raw !== null) {
      const value = JSON.parse(raw) as T;
      memory.set(key, value);
      return value;
    }
  } catch {
    // Unreadable or unavailable: use the fallback.
  }
  return fallback;
}

export function setPref<T>(key: string, value: T) {
  memory.set(key, value);
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    // Kept for this session only.
  }
  listeners.forEach((notify) => notify());
}

function subscribe(notify: () => void) {
  listeners.add(notify);
  return () => {
    listeners.delete(notify);
  };
}

/** A saved preference. `fallback` must be a string, number or boolean so snapshots compare by value. */
export function usePref<T extends string | number | boolean>(key: string, fallback: T): [T, (value: T) => void] {
  const value = useSyncExternalStore(subscribe, () => read(key, fallback));
  const set = useCallback((next: T) => setPref(key, next), [key]);
  return [value, set];
}
