/**
 * Undo and redo for drafts. A step is the whole set of drafts as it stood before a change, so undoing is putting that set back: it can
 * never leave the draft half-changed. Pure and immutable; the workspace keeps one of these and bumps it on every edit.
 */
export interface History<T> {
  past: T[];
  future: T[];
}

export const LIMIT = 200;
export const empty = <T,>(): History<T> => ({ past: [], future: [] });

/** A change was made: `before` is what the drafts were. Anything that could have been redone is gone. */
export function record<T>(h: History<T>, before: T, limit = LIMIT): History<T> {
  const past = [...h.past, before];
  return { past: past.length > limit ? past.slice(past.length - limit) : past, future: [] };
}

/** One step back. `current` goes onto the redo list. Null when there is nothing to undo. */
export function undo<T>(h: History<T>, current: T): { history: History<T>; value: T } | null {
  if (h.past.length === 0) return null;
  const value = h.past[h.past.length - 1]!;
  return { value, history: { past: h.past.slice(0, -1), future: [...h.future, current] } };
}

/** One step forward again. Null when there is nothing to redo. */
export function redo<T>(h: History<T>, current: T): { history: History<T>; value: T } | null {
  if (h.future.length === 0) return null;
  const value = h.future[h.future.length - 1]!;
  return { value, history: { past: [...h.past, current], future: h.future.slice(0, -1) } };
}
