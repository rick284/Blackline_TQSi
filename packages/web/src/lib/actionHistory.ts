/**
 * Undo and redo for edits that are saved to the server as they are made (contacts and the enquiry register), where there are no drafts to put
 * back. Each step knows how to reverse and repeat itself with another save. A step that fails stays where it was, so nothing is half undone.
 */
export interface Action { label: string; undo(): Promise<void>; redo(): Promise<void> }
export interface ActionHistory { past: Action[]; future: Action[] }

export const LIMIT = 100;
export const none = (): ActionHistory => ({ past: [], future: [] });

export function record(h: ActionHistory, a: Action): ActionHistory {
  const past = [...h.past, a];
  return { past: past.length > LIMIT ? past.slice(past.length - LIMIT) : past, future: [] };
}

/** Reverse the latest step. Returns the new history and what was undone; throws (history unchanged) if the save fails. */
export async function stepBack(h: ActionHistory): Promise<{ history: ActionHistory; label: string } | null> {
  const a = h.past[h.past.length - 1];
  if (!a) return null;
  await a.undo();
  return { label: a.label, history: { past: h.past.slice(0, -1), future: [...h.future, a] } };
}

export async function stepForward(h: ActionHistory): Promise<{ history: ActionHistory; label: string } | null> {
  const a = h.future[h.future.length - 1];
  if (!a) return null;
  await a.redo();
  return { label: a.label, history: { past: [...h.past, a], future: h.future.slice(0, -1) } };
}
