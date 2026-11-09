import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as Y from "yjs";
import { openPersisted, COMPACT_EVERY_MS, COMPACT_AFTER_BYTES } from "./persist";
import { AppError, callBytes } from "../services/ipc";
import { resetTauri, hold, tauri, type Call } from "../test/tauriMock";
import { encodeLoad } from "../test/fixtures/store";

vi.mock("@tauri-apps/api/core", () => import("../test/tauriMock"));

const headerOf = (c: Call, name: string): string | null => new Headers(c.options?.headers).get(name);

const writes = (): Call[] => tauri.calls.filter((c) => c.cmd === "store_append" || c.cmd === "store_compact");

const seqs = (cmd: string): number[] => tauri.calls.filter((c) => c.cmd === cmd).map((c) => Number(headerOf(c, "x-seq")));

function remoteUpdate(f: (d: Y.Doc) => void): Uint8Array {
  const d = new Y.Doc();
  let out: Uint8Array | null = null;
  d.on("update", (u: Uint8Array) => {
    out = u;
  });
  f(d);
  if (out === null) throw new Error("no update");
  return out;
}

async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

describe("openPersisted", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("serial appends in seq order", async () => {
    resetTauri({ store_load: () => encodeLoad({ lastSeq: 7 }), store_append: () => null });
    const p = await openPersisted("p1");
    const first = hold("store_append");
    p.ydoc.getMap("m").set("a", 1);
    Y.applyUpdate(p.ydoc, remoteUpdate((d) => d.getMap("r").set("x", 1)), "remote");
    p.ydoc.getMap("m").set("b", 2);
    await settle();
    expect(seqs("store_append")).toEqual([8]);
    const second = hold("store_append");
    first.resolve(null);
    await settle();
    expect(seqs("store_append")).toEqual([8, 9]);
    second.resolve(null);
    await p.flush();
    expect(seqs("store_append")).toEqual([8, 9, 10]);
    expect(tauri.calls.filter((c) => c.cmd === "store_append").map((c) => headerOf(c, "x-doc"))).toEqual(["p1", "p1", "p1"]);
    expect(tauri.calls.filter((c) => c.cmd === "store_append").every((c) => c.args instanceof Uint8Array)).toBe(true);
    expect(p.error()).toBeNull();
  });

  it("rebuilds from snapshot and records", async () => {
    const source = new Y.Doc();
    source.getMap("m").set("a", 1);
    const snapshot = Y.encodeStateAsUpdate(source);
    const records: Uint8Array[] = [];
    source.on("update", (u: Uint8Array) => records.push(u));
    source.getMap("m").set("b", 2);
    source.getMap("m").set("c", 3);
    resetTauri({ store_load: () => encodeLoad({ snapshot, records, lastSeq: 3 }) });
    const p = await openPersisted("p1");
    expect(p.ydoc.getMap("m").toJSON()).toEqual({ a: 1, b: 2, c: 3 });
    expect(p.id).toBe("p1");
    await p.flush();
    expect(writes()).toEqual([]);
    expect(tauri.calls[0]).toMatchObject({ cmd: "store_load", args: { doc: "p1" } });
  });

  it("reports a repaired torn tail", async () => {
    resetTauri({ store_load: () => encodeLoad({ torn: true, lastSeq: 0 }) });
    expect((await openPersisted("p1")).repairedTornTail).toBe(true);
    resetTauri({ store_load: () => encodeLoad({ lastSeq: 0 }) });
    expect((await openPersisted("p1")).repairedTornTail).toBe(false);
  });

  it("timer compaction", async () => {
    resetTauri({ store_load: () => encodeLoad({ lastSeq: 7 }), store_append: () => null, store_compact: () => null });
    const p = await openPersisted("p1");
    await vi.advanceTimersByTimeAsync(COMPACT_EVERY_MS);
    expect(writes()).toEqual([]);
    p.ydoc.getMap("m").set("a", 1);
    p.ydoc.getMap("m").set("b", 2);
    await vi.advanceTimersByTimeAsync(COMPACT_EVERY_MS - 1);
    expect(seqs("store_compact")).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(seqs("store_compact")).toEqual([9]);
    const compact = tauri.calls.find((c) => c.cmd === "store_compact");
    expect(headerOf(compact!, "x-doc")).toBe("p1");
    expect(compact!.args).toEqual(Y.encodeStateAsUpdate(p.ydoc));
    await vi.advanceTimersByTimeAsync(COMPACT_EVERY_MS * 3);
    expect(seqs("store_compact")).toEqual([9]);
  });

  it("size compaction", async () => {
    resetTauri({ store_load: () => encodeLoad({ lastSeq: 0 }), store_append: () => null, store_compact: () => null });
    const p = await openPersisted("p1");
    const text = p.ydoc.getText("t");
    text.insert(0, "x".repeat(600_000));
    await settle();
    expect(seqs("store_compact")).toEqual([]);
    text.insert(0, "y".repeat(600_000));
    await settle();
    expect(600_000 * 2).toBeGreaterThan(COMPACT_AFTER_BYTES);
    expect(seqs("store_compact")).toEqual([2]);
    expect(tauri.calls.map((c) => c.cmd)).toEqual(["store_load", "store_append", "store_append", "store_compact"]);
    await vi.advanceTimersByTimeAsync(COMPACT_EVERY_MS * 2);
    expect(seqs("store_compact")).toEqual([2]);
  });

  it("failed append halts and surfaces", async () => {
    let failing = true;
    resetTauri({
      store_load: () => encodeLoad({ lastSeq: 7 }),
      store_append: () => {
        if (failing) throw { code: "store.io", message: "disk full" };
        return null;
      },
    });
    const p = await openPersisted("p1");
    const seen: AppError[] = [];
    p.onError((e) => seen.push(e));
    p.ydoc.getMap("m").set("a", 1);
    p.ydoc.getMap("m").set("b", 2);
    await settle();
    p.ydoc.getMap("m").set("c", 3);
    await settle();
    expect(seqs("store_append")).toEqual([8]);
    expect(p.error()).toBeInstanceOf(AppError);
    expect(p.error()).toMatchObject({ code: "store.io", message: "disk full" });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe(p.error());
    await expect(p.flush()).rejects.toBe(p.error());
    failing = false;
    await p.retry();
    expect(seqs("store_append")).toEqual([8, 8, 9, 10]);
    expect(p.error()).toBeNull();
    expect(seen).toHaveLength(1);
  });

  it("close flushes", async () => {
    resetTauri({ store_load: () => encodeLoad({ lastSeq: 7 }), store_append: () => null, store_compact: () => null });
    const p = await openPersisted("p1");
    p.ydoc.getMap("m").set("a", 1);
    p.ydoc.getMap("m").set("b", 2);
    await p.close();
    expect(writes().map((c) => [c.cmd, Number(headerOf(c, "x-seq"))])).toEqual([
      ["store_append", 8],
      ["store_append", 9],
      ["store_compact", 9],
    ]);
    expect(tauri.calls[tauri.calls.length - 1].args).toEqual(Y.encodeStateAsUpdate(p.ydoc));
    p.ydoc.getMap("m").set("c", 3);
    await vi.advanceTimersByTimeAsync(COMPACT_EVERY_MS * 2);
    expect(writes()).toHaveLength(3);
  });

  it("a load failure rejects with its AppError", async () => {
    resetTauri({
      store_load: () => {
        throw { code: "store.corrupt", message: "seg-1.log: bad record" };
      },
    });
    await expect(openPersisted("p1")).rejects.toMatchObject({ code: "store.corrupt", message: "seg-1.log: bad record" });
  });
});

describe("callBytes", () => {
  it("callBytes shape", async () => {
    resetTauri({ file_read: () => [1, 2], store_load: () => new Uint8Array([1, 2]).buffer });
    const e = await callBytes("file_read").catch((x: unknown) => x);
    expect(e).toBeInstanceOf(AppError);
    expect(e).toMatchObject({ code: "ipc.shape" });
    await expect(callBytes("store_load", { doc: "p1" })).resolves.toEqual(new Uint8Array([1, 2]));
    resetTauri({ file_read: () => new ArrayBuffer(0) });
    await callBytes("file_read", {}, { headers: { "x-path": "a%20b" } });
    expect(tauri.calls).toHaveLength(1);
    expect(tauri.calls[0].args).toEqual({});
    expect(headerOf(tauri.calls[0], "x-path")).toBe("a%20b");
  });
});
