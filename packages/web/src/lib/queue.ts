/**
 * Check-ins queued while offline. When the connection comes back they are sent one at a time, oldest first. A check-in that the server
 * answers (accepted, refused and parked, or rejected) is finished and leaves the queue; one that cannot reach the server stays, and the
 * rest wait behind it, so nothing is sent out of order or lost.
 */
export type SendOutcome =
  | { kind: "ok"; version: number }
  | { kind: "refused"; message: string }
  | { kind: "error"; message: string }
  | { kind: "offline" };

export async function flushQueue(
  ids: string[],
  send: (id: string) => Promise<SendOutcome>,
): Promise<{ finished: Record<string, SendOutcome>; remaining: string[] }> {
  const finished: Record<string, SendOutcome> = {};
  for (let i = 0; i < ids.length; i++) {
    const outcome = await send(ids[i]!);
    if (outcome.kind === "offline") return { finished, remaining: ids.slice(i) };
    finished[ids[i]!] = outcome;
  }
  return { finished, remaining: [] };
}
