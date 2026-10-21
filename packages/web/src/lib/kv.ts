/**
 * A small async key-value store for things too big for localStorage (the cached copy of a job). IndexedDB in the browser; if it is
 * unavailable (private windows, blocked storage) it falls back to memory, so the app still works, it just cannot keep a copy between visits.
 */
export interface Kv {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  del(key: string): Promise<void>;
}

export function memoryKv(): Kv {
  const m = new Map<string, unknown>();
  return {
    get: async <T,>(k: string) => m.get(k) as T | undefined,
    set: async (k, v) => { m.set(k, structuredClone(v)); },
    del: async (k) => { m.delete(k); },
  };
}

export function indexedDbKv(dbName = "blackline", store = "kv"): Kv {
  const fallback = memoryKv();
  let opened: Promise<IDBDatabase | null> | null = null;
  const open = () =>
    (opened ??= new Promise<IDBDatabase | null>((resolve) => {
      try {
        const req = indexedDB.open(dbName, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(store);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
        req.onblocked = () => resolve(null);
      } catch {
        resolve(null);
      }
    }));
  const run = async <T,>(mode: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest<any>, alt: () => Promise<T>): Promise<T> => {
    const db = await open();
    if (!db) return alt();
    return new Promise<T>((resolve) => {
      try {
        const req = f(db.transaction(store, mode).objectStore(store));
        req.onsuccess = () => resolve(req.result as T);
        req.onerror = () => void alt().then(resolve);
      } catch {
        void alt().then(resolve);
      }
    });
  };
  return {
    get: <T,>(k: string) => run<T | undefined>("readonly", (s) => s.get(k), () => fallback.get<T>(k)),
    set: async (k, v) => { await run("readwrite", (s) => s.put(v, k), async () => fallback.set(k, v)); },
    del: async (k) => { await run("readwrite", (s) => s.delete(k), async () => fallback.del(k)); },
  };
}

/** The app's store. Replaced in tests. */
export let kv: Kv = typeof indexedDB === "undefined" ? memoryKv() : indexedDbKv();
export const setKv = (k: Kv) => { kv = k; };
