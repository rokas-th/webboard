import { describe, it, expect, vi } from "vitest";
import * as Y from "yjs";
import { openPersisted } from "../../store/persist";
import { resetTauri } from "../tauriMock";
import { encodeLoad, memoryStore, type MemoryDoc, type MemoryStore } from "./store";

vi.mock("@tauri-apps/api/core", () => import("../tauriMock"));

function docIn(mem: MemoryStore, id: string): MemoryDoc {
  const d = mem.docs.get(id);
  if (d === undefined) throw new Error(`memoryStore has no doc ${id}`);
  return d;
}

function buffer(x: unknown): ArrayBuffer {
  if (!(x instanceof ArrayBuffer)) throw new Error(`expected an ArrayBuffer, got ${String(x)}`);
  return x;
}

describe("memoryStore", () => {
  it("append then reload through openPersisted gives the same Y state", async () => {
    const mem = memoryStore();
    resetTauri({ ...mem.answers });
    const first = await openPersisted("p1");
    first.ydoc.getMap("m").set("a", 1);
    first.ydoc.getText("t").insert(0, "hello");
    await first.flush();
    expect(docIn(mem, "p1").records.map(([s]) => s)).toEqual([1, 2]);
    const again = await openPersisted("p1");
    expect(Y.encodeStateVector(again.ydoc)).toEqual(Y.encodeStateVector(first.ydoc));
    expect(again.ydoc.getMap("m").toJSON()).toEqual({ a: 1 });
    expect(again.ydoc.getText("t").toString()).toBe("hello");
    await first.close();
    expect(mem.docs.get("p1")).toMatchObject({ snapshotSeq: 2, records: [] });
    const third = await openPersisted("p1");
    expect(third.ydoc.getText("t").toString()).toBe("hello");
    third.ydoc.getMap("m").set("b", 2);
    await third.flush();
    expect(docIn(mem, "p1").records.map(([s]) => s)).toEqual([3]);
  });

  it("fail then recover", async () => {
    const mem = memoryStore();
    resetTauri({ ...mem.answers });
    const p = await openPersisted("p1");
    mem.fail("store_append", "p1", { code: "store.io", message: "disk full" });
    p.ydoc.getMap("m").set("a", 1);
    await expect(p.flush()).rejects.toMatchObject({ code: "store.io", message: "disk full" });
    await expect(p.retry()).rejects.toMatchObject({ code: "store.io" });
    mem.recover("store_append", "p1");
    await p.retry();
    expect(p.error()).toBeNull();
    expect(docIn(mem, "p1").records.map(([s]) => s)).toEqual([1]);

    mem.fail("store_load", "p1", { code: "store.corrupt", message: "bad" });
    await expect(openPersisted("p1")).rejects.toMatchObject({ code: "store.corrupt", message: "bad" });
    mem.recover("store_load", "p1");
    expect((await openPersisted("p1")).ydoc.getMap("m").toJSON()).toEqual({ a: 1 });
  });

  it("seed, list and set aside", async () => {
    const mem = memoryStore();
    resetTauri({ ...mem.answers });
    const src = new Y.Doc();
    src.getMap("m").set("x", 9);
    mem.seed("q", Y.encodeStateAsUpdate(src));
    mem.seed("p", Y.encodeStateAsUpdate(src));
    expect(mem.answers.store_list(undefined)).toEqual(["q", "p"]);
    expect((await openPersisted("q")).ydoc.getMap("m").toJSON()).toEqual({ x: 9 });
    expect(mem.answers.store_set_aside({ doc: "q" })).toBeNull();
    expect(mem.answers.store_list(undefined)).toEqual(["p"]);
    expect(() => mem.answers.store_set_aside({ doc: "q" })).toThrow();
    expect(new Uint8Array(buffer(mem.answers.store_load({ doc: "q" })))).toEqual(new Uint8Array(encodeLoad({ lastSeq: 0 })));
    expect(mem.answers.store_list(undefined)).toEqual(["p", "q"]);
    expect(() => mem.answers.store_append(new Uint8Array([1]), { headers: { "x-doc": "p", "x-seq": "1" } })).toThrow();
  });

  it("loading an unknown doc creates it", async () => {
    const mem = memoryStore();
    resetTauri({ ...mem.answers });
    expect(mem.answers.store_list(undefined)).toEqual([]);
    expect((await openPersisted("z")).ydoc.getMap("m").toJSON()).toEqual({});
    expect(mem.answers.store_list(undefined)).toEqual(["z"]);
    expect(docIn(mem, "z")).toEqual({ snapshot: new Uint8Array(), snapshotSeq: 0, records: [] });
  });

  it("a resend of the last record succeeds and an empty doc starts at seq 1", () => {
    const mem = memoryStore();
    const append = (seq: string, body: number[]): unknown => mem.answers.store_append(new Uint8Array(body), { headers: { "x-doc": "p", "x-seq": seq } });
    expect(() => append("2", [1])).toThrow(expect.objectContaining({ code: "store.seq", message: "seq 2 into an empty document" }));
    expect(append("1", [1])).toBeNull();
    expect(append("1", [1])).toBeNull();
    expect(() => append("1", [2])).toThrow(expect.objectContaining({ code: "store.seq", message: "seq 1 is not after 1" }));
    expect(docIn(mem, "p").records).toEqual([[1, new Uint8Array([1])]]);
  });

  it("encodeLoad writes the store_load wire format", () => {
    const out = new Uint8Array(encodeLoad({ torn: true, snapshot: new Uint8Array([7]), records: [new Uint8Array([8, 9])], lastSeq: 258 }));
    expect([...out]).toEqual([1, 2, 1, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 1, 0, 0, 0, 7, 2, 0, 0, 0, 8, 9]);
  });
});
