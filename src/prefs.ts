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

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

/**
 * A saved preference. A fallback that's an object or array is remembered on first read, so
 * snapshots stay the same object until the preference is set. The setter also accepts an
 * update function, applied to the latest saved value.
 */
export function usePref<T extends Json>(key: string, fallback: T): [T, (next: T | ((previous: T) => T)) => void] {
  const value = useSyncExternalStore(subscribe, () => {
    const current = read(key, fallback);
    if (current === fallback && typeof fallback === "object" && fallback !== null) memory.set(key, fallback);
    return current;
  });
  const set = useCallback(
    (next: T | ((previous: T) => T)) =>
      setPref(key, typeof next === "function" ? (next as (previous: T) => T)(read(key, fallback)) : next),
    // The fallback only matters before the first save; leaving it out keeps the setter stable.
    [key],
  );
  return [value, set];
}
