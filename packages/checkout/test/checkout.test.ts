import { describe, expect, it } from "vitest";
import { appendRecord, breakLock, checkIn, checkOut, createStore } from "../src/index.js";

const T = "2026-10-21T00:00:00Z";
const base = () => createStore([{ id: "drain", version: 1, records: { r1: { rate: 55 } } }]);

function must<T extends { ok: boolean }>(r: T): Extract<T, { ok: true }> {
  if (!r.ok) throw new Error("expected ok");
  return r as Extract<T, { ok: true }>;
}

describe("checkout", () => {
  it("locks a package to one person", () => {
    const a = must(checkOut(base(), "drain", "carlo", T));
    expect(a.snapshot.version).toBe(1);
    const b = checkOut(a.store, "drain", "rick", T);
    expect(b.ok).toBe(false);
    expect(!b.ok && b.reason).toBe("already-checked-out");
  });

  it("applies a check-in, bumps the version and releases the lock", () => {
    const a = must(checkOut(base(), "drain", "carlo", T));
    const c = must(
      checkIn(a.store, "drain", "carlo", 1, { upserts: { r1: { rate: 60 }, r2: { rate: 1 } }, deletes: [] }, T),
    );
    expect(c.version).toBe(2);
    expect(c.store.packages.drain!.records).toEqual({ r1: { rate: 60 }, r2: { rate: 1 } });
    expect(c.store.locks.drain).toBeUndefined();
  });

  it("refuses a check-in from someone who does not hold the lock", () => {
    const a = must(checkOut(base(), "drain", "carlo", T));
    const r = checkIn(a.store, "drain", "rick", 1, { upserts: {}, deletes: [] }, T);
    expect(!r.ok && r.reason).toBe("not-holder");
  });

  it("only a manager can break a lock", () => {
    const a = must(checkOut(base(), "drain", "carlo", T));
    expect(breakLock(a.store, "drain", "rick", false, T).ok).toBe(false);
    expect(breakLock(base(), "drain", "boss", true, T).ok).toBe(false);
  });

  it("parks, never applies, a check-in after a lock was broken", () => {
    const a = must(checkOut(base(), "drain", "carlo", T));
    const b = must(breakLock(a.store, "drain", "boss", true, T));
    // someone else takes the package and changes it
    const c = must(checkOut(b.store, "drain", "rick", T));
    const d = must(checkIn(c.store, "drain", "rick", 1, { upserts: { r1: { rate: 70 } }, deletes: [] }, T));
    // carlo returns from his flight
    const late = checkIn(d.store, "drain", "carlo", 1, { upserts: { r1: { rate: 99 } }, deletes: [] }, T);
    expect(late.ok).toBe(false);
    expect(late.store.packages.drain!.records.r1).toEqual({ rate: 70 });
    expect(late.store.parked).toHaveLength(1);
    expect(late.store.parked[0]!.changes.upserts.r1).toEqual({ rate: 99 });
  });

  it("parks a check-in after a broken lock even if nobody else edited", () => {
    const a = must(checkOut(base(), "drain", "carlo", T));
    const b = must(breakLock(a.store, "drain", "boss", true, T));
    const late = checkIn(b.store, "drain", "carlo", 1, { upserts: {}, deletes: [] }, T);
    expect(!late.ok && late.reason).toBe("no-lock");
    expect(late.store.parked).toHaveLength(1);
  });

  it("append-only records never conflict and replay safely", () => {
    const a = must(checkOut(base(), "drain", "carlo", T));
    let s = appendRecord(a.store, "quote-1", { amount: 100 });
    s = appendRecord(s, "quote-1", { amount: 999 });
    expect(s.appendOnly["quote-1"]).toEqual({ amount: 100 });
    expect(s.locks.drain).toBeDefined();
  });

  it("keeps an audit trail", () => {
    const a = must(checkOut(base(), "drain", "carlo", T));
    const c = must(checkIn(a.store, "drain", "carlo", 1, { upserts: {}, deletes: [] }, T));
    expect(c.store.audit.map((e) => e.action)).toEqual(["check-out", "check-in"]);
  });
});
