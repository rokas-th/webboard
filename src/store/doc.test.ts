import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import type { Action, Cause, Write } from "../log/types";
import { bigLog } from "../test/fixtures/bigLog";
import { LOCAL, PlanDoc, decodeAction, encodeAction } from "./doc";

const send = (from: PlanDoc, to: PlanDoc): void => {
  Y.applyUpdate(to.ydoc, Y.encodeStateAsUpdate(from.ydoc, Y.encodeStateVector(to.ydoc)));
};

const fresh = (): PlanDoc => new PlanDoc(new Y.Doc());

const base = (id: string, w: readonly Write[] = [{ u: "pn", v: "Plan", c: "own" }]): Action => ({
  id,
  dev: "dev-a",
  ses: "ses-a",
  at: 1_762_600_000_000,
  par: [],
  lbl: "Created the plan",
  w,
});

const valid = (): unknown[] => ["dev-a", "ses-a", 5, ["p1"], "Moved", ["s:i1", null, "o"]];

describe("round trip", () => {
  it("an action appended on A reads back equal on B", () => {
    const causes: Cause[] = ["own", "push", "recalendar", "undo", "revert", "resolution"];
    const action: Action = {
      id: "x1",
      dev: "dev-a",
      ses: "ses-a",
      at: 1_762_600_000_123,
      par: ["p1", "p2"],
      lbl: "Moved “Review”",
      w: causes.map((c, n) => ({ u: `s:i${n}`, v: n === 0 ? null : { start: "2026-11-25", dur: n, nested: { list: [n, "x", null] } }, c })),
      meta: { undo: "u1", redo: "r1", revert: "v1", resolves: "ch1", imported: "file.webboard" },
    };
    const a = fresh();
    const b = fresh();
    a.append(action, []);
    send(a, b);
    expect([...b.actions()]).toEqual([action]);
  });

  it("an action without meta reads back without a meta key", () => {
    const a = fresh();
    const b = fresh();
    a.append(base("x2"), []);
    send(a, b);
    const [got] = [...b.actions()];
    expect(got).toEqual(base("x2"));
    expect(Object.keys(got)).not.toContain("meta");
  });
});

describe("encoding", () => {
  it("is the positional tuple with flat writes and one-letter causes", () => {
    const action: Action = {
      ...base("x1"),
      par: ["p1"],
      w: [
        { u: "s:i1", v: 1, c: "own" },
        { u: "s:i2", v: 2, c: "push" },
        { u: "s:i3", v: 3, c: "recalendar" },
        { u: "a:x0", v: false, c: "undo" },
        { u: "a:x9", v: false, c: "revert" },
        { u: "s:i4", v: 4, c: "resolution" },
      ],
    };
    expect(encodeAction(action)).toEqual([
      "dev-a",
      "ses-a",
      1_762_600_000_000,
      ["p1"],
      "Created the plan",
      ["s:i1", 1, "o", "s:i2", 2, "p", "s:i3", 3, "r", "a:x0", false, "u", "a:x9", false, "v", "s:i4", 4, "s"],
    ]);
  });

  it("carries meta as the seventh element only when present", () => {
    expect(encodeAction(base("x1"))).toHaveLength(6);
    const withMeta = encodeAction({ ...base("x1"), meta: { undo: "u1" } });
    expect(withMeta).toHaveLength(7);
    expect(withMeta[6]).toEqual({ undo: "u1" });
  });

  it("keeps the id only as the map key", () => {
    const doc = fresh();
    doc.append(base("x1"), []);
    const stored = doc.ydoc.getMap("actions").get("x1");
    expect(stored).toEqual(encodeAction(base("x1")));
    expect(JSON.stringify(stored)).not.toContain("x1");
  });

  it("decodes a valid tuple", () => {
    expect(decodeAction("x1", valid())).toEqual({
      id: "x1",
      dev: "dev-a",
      ses: "ses-a",
      at: 5,
      par: ["p1"],
      lbl: "Moved",
      w: [{ u: "s:i1", v: null, c: "own" }],
    });
  });

  const malformed = (field: number, value: unknown): unknown[] => valid().map((x, n) => (n === field ? value : x));

  it.each([
    ["dev", malformed(0, 7)],
    ["ses", malformed(1, null)],
    ["at", malformed(2, "5")],
    ["at", malformed(2, Number.NaN)],
    ["par", malformed(3, "p1")],
    ["par", malformed(3, ["p1", 2])],
    ["lbl", malformed(4, 5)],
    ["w", malformed(5, "not-writes")],
    ["w", malformed(5, ["s:i1", null, "x"])],
    ["w", malformed(5, ["s:i1", null])],
    ["w", malformed(5, [3, null, "o"])],
    ["w", valid().slice(0, 5)],
    ["meta", [...valid(), "undo"]],
    ["meta", [...valid(), null]],
    ["meta", [...valid(), { undo: 3 }]],
    ["meta", [...valid(), { later: "u1" }]],
    ["meta", [...valid(), { undo: "u1" }, "extra"]],
    ["dev", "not-a-tuple"],
  ])("names %s when it is malformed", (field, raw) => {
    expect(() => decodeAction("x1", raw)).toThrow(new Error(`Action x1 has a malformed ${field}`));
  });
});

describe("append validation", () => {
  it.each([
    ["meta", { ...base("x1"), meta: { undo: undefined } }],
    ["at", { ...base("x1"), at: Number.NaN }],
    ["at", { ...base("x1"), at: Number.POSITIVE_INFINITY }],
    ["w", base("x1", [{ u: "s:i1", v: 1, c: "bogus" as Cause }])],
    ["w", base("x1", [{ u: "s:i1", v: 1, c: "toString" as Cause }])],
  ])("refuses an action with a bad %s and stores nothing", (field, action) => {
    const doc = fresh();
    doc.append(base("x0"), []);
    const before = Y.encodeStateAsUpdate(doc.ydoc);
    expect(() => doc.append(action, [])).toThrow(new Error(`Action x1 has a malformed ${field}`));
    expect(Y.encodeStateAsUpdate(doc.ydoc)).toEqual(before);
  });

  it("encodeAction refuses a cause outside the union", () => {
    expect(() => encodeAction(base("x1", [{ u: "s:i1", v: 1, c: "bogus" as Cause }]))).toThrow(
      new Error("Action x1 has a malformed w"),
    );
  });

  it("refuses a second action with the same id and stores nothing", () => {
    const doc = fresh();
    doc.append(base("x1"), []);
    const before = Y.encodeStateAsUpdate(doc.ydoc);
    expect(() => doc.append({ ...base("x1"), lbl: "Other" }, [])).toThrow(new Error("Action x1 already exists"));
    expect(Y.encodeStateAsUpdate(doc.ydoc)).toEqual(before);
    expect([...doc.actions()]).toEqual([base("x1")]);
  });
});

describe("notes", () => {
  const created = (): Action => base("c1", [{ u: "e:i1", v: "task", c: "own" }]);

  it.each([
    ["A then B", true],
    ["B then A", false],
  ])("first notes typed apart both survive (%s)", (_name, aFirst) => {
    const a = fresh();
    const b = fresh();
    a.append(created(), ["i1"]);
    send(a, b);
    a.note("i1").insert(0, "mac");
    b.note("i1").insert(0, "phone");
    if (aFirst) {
      send(a, b);
      send(b, a);
    } else {
      send(b, a);
      send(a, b);
    }
    const text = a.note("i1").toString();
    expect(b.note("i1").toString()).toBe(text);
    expect(text).toContain("mac");
    expect(text).toContain("phone");
  });

  it("control: two notes created apart keep only one word", () => {
    const a = fresh();
    const b = fresh();
    a.ydoc.getMap("notes").set("i1", new Y.Text("mac"));
    b.ydoc.getMap("notes").set("i1", new Y.Text("phone"));
    send(a, b);
    send(b, a);
    const text = a.note("i1").toString();
    expect(b.note("i1").toString()).toBe(text);
    expect([text.includes("mac"), text.includes("phone")].filter(Boolean)).toHaveLength(1);
  });

  it("note of an item created without one throws", () => {
    expect(() => fresh().note("i9")).toThrow(new Error("Item i9 has no note: it was created without one"));
  });

  it("append refuses a note that exists and stores nothing", () => {
    const doc = fresh();
    doc.append(created(), ["i1"]);
    const before = Y.encodeStateAsUpdate(doc.ydoc);
    expect(() => doc.append(base("b1"), ["i1"])).toThrow(new Error("Item i1 already has a note"));
    expect(Y.encodeStateAsUpdate(doc.ydoc)).toEqual(before);
    expect([...doc.actions()].map((x) => x.id)).toEqual(["c1"]);
  });

  it("append refuses an item listed twice and stores nothing", () => {
    const doc = fresh();
    doc.append(base("x0"), []);
    const before = Y.encodeStateAsUpdate(doc.ydoc);
    expect(() => doc.append(created(), ["i1", "i1"])).toThrow(new Error("Item i1 is listed twice in newNotes"));
    expect(Y.encodeStateAsUpdate(doc.ydoc)).toEqual(before);
  });

  it("note that is not text throws", () => {
    const doc = fresh();
    doc.ydoc.getMap("notes").set("i1", "plain");
    expect(() => doc.note("i1")).toThrow(new Error("Item i1 has a note that is not text"));
  });
});

describe("onActions", () => {
  it("reports local appends as local and received ones as remote", () => {
    const a = fresh();
    const b = fresh();
    const onA = vi.fn();
    const onB = vi.fn();
    a.onActions(onA);
    b.onActions(onB);
    a.append(base("x1"), []);
    send(a, b);
    expect(onA).toHaveBeenCalledExactlyOnceWith([base("x1")], true);
    expect(onB).toHaveBeenCalledExactlyOnceWith([base("x1")], false);
  });

  it("append is one transaction with origin LOCAL", () => {
    const doc = fresh();
    const origins: unknown[] = [];
    doc.ydoc.on("afterTransaction", (t: Y.Transaction) => origins.push(t.origin));
    doc.append(base("x1"), ["i1", "i2"]);
    expect(origins).toEqual([LOCAL]);
    expect(doc.note("i1").toString()).toBe("");
    expect(doc.note("i2").toString()).toBe("");
  });

  it.each([
    ["updated", (map: Y.Map<unknown>) => map.set("x1", encodeAction({ ...base("x1"), lbl: "Rewritten" }))],
    ["deleted", (map: Y.Map<unknown>) => map.delete("x1")],
  ])("throws when a received change says an action was %s", (verb, change) => {
    const a = fresh();
    const b = fresh();
    a.append(base("x1"), []);
    send(a, b);
    const cb = vi.fn();
    a.onActions(cb);
    change(b.ydoc.getMap("actions"));
    expect(() => send(b, a)).toThrow(new Error(`Action x1 was ${verb}; the action log is append-only`));
    expect(cb).not.toHaveBeenCalled();
  });

  it("stops after unsubscribing", () => {
    const doc = fresh();
    const cb = vi.fn();
    const off = doc.onActions(cb);
    off();
    doc.append(base("x1"), []);
    expect(cb).not.toHaveBeenCalled();
  });
});

describe("size", () => {
  it("1,000 actions of the mix average at most 250 B each", () => {
    const { actions } = bigLog(1000, 1);
    const doc = fresh();
    actions.forEach((a) => doc.append(a, []));
    const mean = Y.encodeStateAsUpdate(doc.ydoc).byteLength / 1000;
    const largest = Math.max(
      ...actions.map((a) => {
        const one = fresh();
        one.append(a, []);
        return Y.encodeStateAsUpdate(one.ydoc).byteLength;
      }),
    );
    console.info(`plan document size: mean ${mean.toFixed(1)} B per action, largest single action ${largest} B`);
    expect(mean).toBeLessThanOrEqual(250);
  });
});
