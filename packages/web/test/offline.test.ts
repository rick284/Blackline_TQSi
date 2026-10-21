import { describe, expect, it } from "vitest";
import { indexedDbKv, memoryKv } from "../src/lib/kv.js";
import { flushQueue, type SendOutcome } from "../src/lib/queue.js";

describe("key-value store", () => {
  it("keeps, replaces and deletes values, and stores copies so later edits to the original do not leak in", async () => {
    const kv = memoryKv();
    const v = { records: [{ id: "a" }] };
    await kv.set("job:1", v);
    v.records.push({ id: "b" });
    expect((await kv.get<typeof v>("job:1"))!.records).toHaveLength(1);
    await kv.set("job:1", { records: [] });
    expect((await kv.get<typeof v>("job:1"))!.records).toHaveLength(0);
    await kv.del("job:1");
    expect(await kv.get("job:1")).toBeUndefined();
  });

  it("falls back to memory where IndexedDB does not exist, so the app still works", async () => {
    const kv = indexedDbKv("no-such-db"); // this test runs in Node, which has no indexedDB
    await kv.set("k", { n: 1 });
    expect(await kv.get("k")).toEqual({ n: 1 });
    await kv.del("k");
    expect(await kv.get("k")).toBeUndefined();
  });
});

const ok = (v = 2): SendOutcome => ({ kind: "ok", version: v });

describe("queued check-ins", () => {
  it("sends them oldest first and clears them once the server has answered", async () => {
    const sent: string[] = [];
    const r = await flushQueue(["a", "b", "c"], async (id) => { sent.push(id); return id === "b" ? { kind: "refused", message: "lock broken" } : ok(); });
    expect(sent).toEqual(["a", "b", "c"]);
    expect(Object.keys(r.finished)).toEqual(["a", "b", "c"]);
    expect(r.finished.b).toEqual({ kind: "refused", message: "lock broken" });
    expect(r.remaining).toEqual([]);
  });

  it("stops at the first one that cannot reach the server and keeps it, and the rest, queued in order", async () => {
    const sent: string[] = [];
    const r = await flushQueue(["a", "b", "c"], async (id) => { sent.push(id); return id === "b" ? { kind: "offline" } : ok(); });
    expect(sent).toEqual(["a", "b"]); // c is not attempted after the connection drops
    expect(Object.keys(r.finished)).toEqual(["a"]);
    expect(r.remaining).toEqual(["b", "c"]);
  });

  it("treats a server rejection as finished, so it is not retried forever", async () => {
    const r = await flushQueue(["a"], async () => ({ kind: "error", message: "Another person holds this package." }));
    expect(r.remaining).toEqual([]);
    expect(r.finished.a).toEqual({ kind: "error", message: "Another person holds this package." });
  });

  it("does nothing for an empty queue", async () => {
    expect(await flushQueue([], async () => ok())).toEqual({ finished: {}, remaining: [] });
  });
});
