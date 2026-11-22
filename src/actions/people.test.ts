import { generateKeyBetween } from "fractional-indexing";
import { describe, expect, it } from "vitest";
import type { StepColour } from "../domain/model";
import { LogState } from "../log/state";
import type { Action, Cause, Write } from "../log/types";
import { planRules } from "../plan/rules";
import { act } from "../test/act";
import { ctxOf } from "../test/planCtx";
import { buildAction } from "./build";
import { Refused, type Built, type Ctx, type Intent } from "./intents";
import { buildUndo } from "./undo";

const TODAY = "2026-11-09";

const w = (u: string, v: unknown, c: Cause = "own"): Write => ({ u, v, c });

const sched = (start: string | null, dur: number): unknown[] => [start, dur, "todo", 0, "later"];

const item = (id: string, kind: "task" | "milestone" | "group", name: string, parent: string | null, order: string, s?: unknown[], trashed = false): Write[] => [
  w(`e:${id}`, { k: kind, t: trashed }),
  w(`n:${id}`, name),
  ...(s === undefined ? [] : [w(`s:${id}`, s)]),
  w(`p:${id}`, [parent, order]),
];

const MIRA = { n: "Mira Okafor", i: "MO", c: "cyan", o: "a0" };
const OLE = { n: "Ole Berg", i: "OB", c: "lime", o: "a1" };
const ANA = { n: "Ana Ruiz", i: "AR", c: "amber", o: "a2" };
const ZED = { n: "Zed Former", i: "ZF", c: "slate", o: "a3" };

const ROOT: Write[] = [
  w("pn", "MESA 1.0"),
  w("cw", [1, 2, 3, 4, 5]),
  w("cr", null),
  ...item("T1", "task", "Mirror test", null, "a0", sched("2026-11-16", 3)),
  ...item("T2", "task", "Dome survey", null, "a1", sched("2026-12-14", 3)),
  ...item("T3", "task", "Ship", null, "a2", sched("2027-03-01", 2)),
  ...item("M1", "milestone", "First light", null, "a3", sched("2027-03-15", 0)),
  ...item("G", "group", "Phase", null, "a4"),
  ...item("C1", "task", "Wire", "G", "a0", sched("2026-11-18", 2)),
  ...item("X", "task", "Old", null, "a5", sched("2026-11-20", 2), true),
  ...item("TG", "group", "Shelved", null, "a6", undefined, true),
  ...item("C2", "task", "Lens order", "TG", "a0", sched("2026-11-18", 2)),
  w("pp:mira", MIRA),
  w("pp:ole", OLE),
  w("pp:ana", ANA),
  w("pp:zed", ZED),
  w("pa:T1", ["mira"]),
  w("pa:T2", ["mira", "ole", "zed"]),
  w("pa:M1", ["zed"]),
  w("pa:X", ["mira"]),
  w("pa:C2", ["mira"]),
];

const logOf = (...actions: Action[]): LogState => {
  const log = new LogState(planRules);
  const delta = log.add(actions);
  expect(delta.refused).toEqual([]);
  expect(log.pending).toEqual([]);
  return log;
};

const ctxFrom = (root: readonly Write[], ...rest: Action[]): Ctx => ctxOf(logOf(act("a0", [], root), ...rest), "d1", TODAY);

const people = (): Ctx => ctxFrom(ROOT, act("a1", ["a0"], [w("pp:zed", null)]));

const applied = (ctx: Ctx, b: Built): Ctx => {
  expect(ctx.log.add([b.action]).refused).toEqual([]);
  return ctxOf(ctx.log, ctx.dev, TODAY, ctx.devices);
};

const units = (b: Built): string[] => b.action.w.map((x) => x.u);

const valueAt = (b: Built, u: string): unknown => {
  const found = b.action.w.find((x) => x.u === u);
  if (found === undefined) throw new Error(`no write to ${u}`);
  return found.v;
};

const newPersonUnit = (b: Built): string => {
  const found = units(b).filter((u) => u.startsWith("pp:"));
  expect(found).toHaveLength(1);
  return found[0];
};

const refusedWith = (ctx: Ctx, intent: Intent, message: string): void => {
  const before = [...ctx.log.order()];
  let caught: unknown = null;
  try {
    buildAction(ctx, intent);
  } catch (e) {
    caught = e;
  }
  if (!(caught instanceof Refused)) throw new Error(`expected a Refused, caught ${String(caught)}`);
  expect(caught.message).toBe(message);
  expect([...ctx.log.order()]).toEqual(before);
};

const errorWith = (ctx: Ctx, intent: Intent, message: string): void => {
  let caught: unknown = null;
  try {
    buildAction(ctx, intent);
  } catch (e) {
    caught = e;
  }
  if (!(caught instanceof Error)) throw new Error(`expected an Error, caught ${String(caught)}`);
  expect(caught).not.toBeInstanceOf(Refused);
  expect(caught.message).toBe(message);
};

const NOTHING = "Nothing to change.";

const NINE = ["p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8", "p9"];

const crowded = (): Ctx =>
  ctxFrom([
    ...ROOT,
    ...NINE.map((id, n) => w(`pp:${id}`, { n: `Person ${n + 1}`, i: `P${n + 1}`, c: "sky", o: `b${n}` })),
    w("pa:T3", NINE.slice(0, 8)),
  ]);

describe("person add", () => {
  it("adds a person after another with a fresh id, a normalised name and trimmed initials", () => {
    const b = buildAction(people(), { t: "person", op: "add", name: "  Lena Vogt\n", initials: " Lv ", colour: "violet", after: "ole" });
    const u = newPersonUnit(b);
    expect(units(b)).toEqual([u]);
    expect(u).toMatch(/^pp:[A-Za-z0-9_-]+$/);
    expect(valueAt(b, u)).toEqual({ n: "Lena Vogt", i: "Lv", c: "violet", o: generateKeyBetween("a1", "a2") });
    expect(b.action.lbl).toBe("Added “Lena Vogt” to people");
    expect(b.toast).toBe("Added “Lena Vogt” to people.");
  });

  it("adds a person first when after is null", () => {
    const b = buildAction(people(), { t: "person", op: "add", name: "Lena Vogt", initials: "LV", colour: "sky", after: null });
    expect(valueAt(b, newPersonUnit(b))).toEqual({ n: "Lena Vogt", i: "LV", c: "sky", o: generateKeyBetween(null, "a0") });
  });

  it("rekeys a tied run of orders", () => {
    const ctx = ctxFrom(ROOT.map((x) => (x.u === "pp:ole" ? w("pp:ole", { ...OLE, o: "a0" }) : x)));
    const b = buildAction(ctx, { t: "person", op: "add", name: "Lena Vogt", initials: "LV", colour: "sky", after: "mira" });
    const fresh = units(b).filter((u) => u !== "pp:mira" && u !== "pp:ole");
    expect(fresh).toHaveLength(1);
    const after = applied(ctx, b);
    expect(after.view.people.people.map((p) => p.id)).toEqual(["mira", fresh[0].slice(3), "ole", "ana", "zed"]);
    expect([...units(b)].sort()).toEqual([fresh[0], "pp:mira", "pp:ole"].sort());
  });

  it("refuses a long name, a taken name, an empty name and bad initials", () => {
    refusedWith(people(), { t: "person", op: "add", name: "x".repeat(65), initials: "X", colour: "cyan", after: null }, "A name has at most 64 characters.");
    refusedWith(people(), { t: "person", op: "add", name: "mira OKAFOR", initials: "M", colour: "cyan", after: null }, "There is already a person named “Mira Okafor”.");
    refusedWith(people(), { t: "person", op: "add", name: "  ", initials: "X", colour: "cyan", after: null }, "The name is empty. Type at least one character.");
    ["", "  ", "ABCD", "A B"].forEach((initials) =>
      refusedWith(people(), { t: "person", op: "add", name: "Lena Vogt", initials, colour: "cyan", after: null }, "Initials are 1 to 3 characters without spaces."),
    );
  });

  it("counts the name and the initials in code points, and takes the name of a removed person", () => {
    const b = buildAction(people(), { t: "person", op: "add", name: "🔭".repeat(64), initials: "🔭🔭🔭", colour: "cyan", after: null });
    expect(b.action.lbl).toBe(`Added “${"🔭".repeat(64)}” to people`);
    expect(buildAction(people(), { t: "person", op: "add", name: "Zed Former", initials: "ZF", colour: "cyan", after: null }).action.lbl).toBe("Added “Zed Former” to people");
  });

  it("throws for an unknown colour, an unknown after and a removed after", () => {
    const teal = "teal" as StepColour;
    errorWith(people(), { t: "person", op: "add", name: "A", initials: "A", colour: teal, after: null }, "Person colour teal is not one of cyan, violet, magenta, lime, amber, coral, sky, slate");
    errorWith(people(), { t: "person", op: "add", name: "A", initials: "A", colour: "cyan", after: "nobody" }, "Person nobody is not in this plan");
    errorWith(people(), { t: "person", op: "add", name: "A", initials: "A", colour: "cyan", after: "zed" }, "Person zed is not in this plan");
  });
});

describe("person rename, initials, colour, reorder", () => {
  it("renames with one full pp write", () => {
    const b = buildAction(people(), { t: "person", op: "rename", person: "mira", name: " Mira Okafor-Lund " });
    expect(b.action.w).toEqual([w("pp:mira", { ...MIRA, n: "Mira Okafor-Lund" })]);
    expect(b.action.lbl).toBe("Renamed person “Mira Okafor” to “Mira Okafor-Lund”");
  });

  it("renames to a case change of the own name, refuses another person's name, the same name and a long one", () => {
    expect(valueAt(buildAction(people(), { t: "person", op: "rename", person: "mira", name: "mira okafor" }), "pp:mira")).toEqual({ ...MIRA, n: "mira okafor" });
    refusedWith(people(), { t: "person", op: "rename", person: "mira", name: "OLE berg" }, "There is already a person named “Ole Berg”.");
    refusedWith(people(), { t: "person", op: "rename", person: "mira", name: "Mira Okafor" }, NOTHING);
    refusedWith(people(), { t: "person", op: "rename", person: "mira", name: "y".repeat(65) }, "A name has at most 64 characters.");
  });

  it("sets initials as typed after trimming, and refuses bad or unchanged ones", () => {
    const b = buildAction(people(), { t: "person", op: "initials", person: "mira", initials: " mo " });
    expect(b.action.w).toEqual([w("pp:mira", { ...MIRA, i: "mo" })]);
    expect(b.action.lbl).toBe("Set the initials of “Mira Okafor” to mo");
    refusedWith(people(), { t: "person", op: "initials", person: "mira", initials: "M O" }, "Initials are 1 to 3 characters without spaces.");
    refusedWith(people(), { t: "person", op: "initials", person: "mira", initials: "MO" }, NOTHING);
  });

  it("colours a person and refuses the same colour", () => {
    const b = buildAction(people(), { t: "person", op: "colour", person: "mira", colour: "coral" });
    expect(b.action.w).toEqual([w("pp:mira", { ...MIRA, c: "coral" })]);
    expect(b.action.lbl).toBe("Coloured “Mira Okafor” coral");
    refusedWith(people(), { t: "person", op: "colour", person: "mira", colour: "cyan" }, NOTHING);
  });

  it("reorders a person", () => {
    const b = buildAction(people(), { t: "person", op: "reorder", person: "mira", after: "ole" });
    expect(b.action.w).toEqual([w("pp:mira", { ...MIRA, o: generateKeyBetween("a1", "a2") })]);
    expect(b.action.lbl).toBe("Moved “Mira Okafor” in people");
    const first = buildAction(people(), { t: "person", op: "reorder", person: "ana", after: null });
    expect(first.action.w).toEqual([w("pp:ana", { ...ANA, o: generateKeyBetween(null, "a0") })]);
  });

  it("refuses a reorder to where the person already is, and throws for a reorder after itself", () => {
    refusedWith(people(), { t: "person", op: "reorder", person: "ole", after: "mira" }, NOTHING);
    refusedWith(people(), { t: "person", op: "reorder", person: "mira", after: null }, NOTHING);
    errorWith(people(), { t: "person", op: "reorder", person: "mira", after: "mira" }, "Person mira cannot follow itself");
  });

  it("throws for an op on an unknown or removed person", () => {
    errorWith(people(), { t: "person", op: "rename", person: "nobody", name: "A" }, "Person nobody is not in this plan");
    errorWith(people(), { t: "person", op: "initials", person: "zed", initials: "Z" }, "Person zed is not in this plan");
    errorWith(people(), { t: "person", op: "colour", person: "zed", colour: "cyan" }, "Person zed is not in this plan");
    errorWith(people(), { t: "person", op: "reorder", person: "zed", after: null }, "Person zed is not in this plan");
    errorWith(people(), { t: "person", op: "remove", person: "zed", to: null }, "Person zed is not in this plan");
  });
});

describe("person remove", () => {
  it("remove with a replacement rewrites every affected list in one action, trashed included; undo restores all", () => {
    const ctx = people();
    const b = buildAction(ctx, { t: "person", op: "remove", person: "mira", to: "ole" });
    expect(b.action.w).toEqual([
      w("pp:mira", null),
      w("pa:C2", ["ole"]),
      w("pa:T1", ["ole"]),
      w("pa:T2", ["ole", "zed"]),
      w("pa:X", ["ole"]),
    ]);
    expect(b.action.lbl).toBe("Removed “Mira Okafor” and gave 4 items to “Ole Berg”");
    const after = applied(ctx, b);
    expect(after.view.people.people.map((p) => p.id)).toEqual(["ole", "ana"]);
    const undone = applied(after, buildUndo(after, b.action.id));
    expect(undone.view.plan.people.persons.get("mira")).toEqual(MIRA);
    expect(undone.view.plan.people.assignees).toEqual(ctx.view.plan.people.assignees);
  });

  it("remove to null drops the person and writes null for an emptied list", () => {
    const b = buildAction(people(), { t: "person", op: "remove", person: "mira", to: null });
    expect(b.action.w).toEqual([w("pp:mira", null), w("pa:C2", null), w("pa:T1", null), w("pa:T2", ["ole", "zed"]), w("pa:X", null)]);
    expect(b.action.lbl).toBe("Removed “Mira Okafor” from people and from 4 items");
  });

  it("removes a person who holds no items with only the pp write", () => {
    const b = buildAction(people(), { t: "person", op: "remove", person: "ana", to: "ole" });
    expect(b.action.w).toEqual([w("pp:ana", null)]);
    expect(b.action.lbl).toBe("Removed “Ana Ruiz” from people");
    expect(buildAction(people(), { t: "person", op: "remove", person: "ana", to: null }).action.lbl).toBe("Removed “Ana Ruiz” from people");
  });

  it("removes a person whose items keep other assignees, counting every item it unassigns", () => {
    const b = buildAction(people(), { t: "person", op: "remove", person: "ole", to: null });
    expect(b.action.w).toEqual([w("pp:ole", null), w("pa:T2", ["mira", "zed"])]);
    expect(b.action.lbl).toBe("Removed “Ole Berg” from people and from 1 item");
  });

  it("throws for a remove into itself or into an unknown or removed person", () => {
    errorWith(people(), { t: "person", op: "remove", person: "mira", to: "mira" }, "Person mira cannot take its own items");
    errorWith(people(), { t: "person", op: "remove", person: "mira", to: "nobody" }, "Person nobody is not in this plan");
    errorWith(people(), { t: "person", op: "remove", person: "mira", to: "zed" }, "Person zed is not in this plan");
  });
});

describe("assign and unassign", () => {
  it("assigns a person to an item with the sorted list", () => {
    const b = buildAction(people(), { t: "assign", items: ["T1"], person: "ole" });
    expect(b.action.w).toEqual([w("pa:T1", ["mira", "ole"])]);
    expect(b.action.lbl).toBe("Assigned “Ole Berg” to “Mirror test”");
  });

  it("assigns to several items, skipping the ones that already hold the person", () => {
    const b = buildAction(people(), { t: "assign", items: ["T1", "T2", "T3", "C1"], person: "ole" });
    expect(b.action.w).toEqual([w("pa:T1", ["mira", "ole"]), w("pa:T3", ["ole"]), w("pa:C1", ["ole"])]);
    expect(b.action.lbl).toBe("Assigned “Ole Berg” to 3 items");
  });

  it("names the one item that changed", () => {
    expect(buildAction(people(), { t: "assign", items: ["T2", "M1"], person: "ole" }).action.lbl).toBe("Assigned “Ole Berg” to “First light”");
  });

  it("refuses an assignment that changes nothing and a ninth assignee", () => {
    refusedWith(people(), { t: "assign", items: ["T2"], person: "ole" }, NOTHING);
    refusedWith(crowded(), { t: "assign", items: ["T1", "T3"], person: "p9" }, "“Ship” already has 8 assignees.");
    refusedWith(crowded(), { t: "assign", items: ["T3"], person: "p8" }, NOTHING);
  });

  it("refuses a trashed item and throws for a group, a repeated item, an unknown and a removed person", () => {
    refusedWith(people(), { t: "assign", items: ["X"], person: "ole" }, "“Old” is in the Trash. Restore it first.");
    refusedWith(people(), { t: "assign", items: ["C2"], person: "ole" }, "“Lens order” is inside “Shelved”, which is in the Trash. Restore “Shelved” first.");
    errorWith(people(), { t: "assign", items: ["G"], person: "ole" }, "Group G has no assignees");
    errorWith(people(), { t: "assign", items: ["T1", "T1"], person: "ole" }, "Item T1 is repeated");
    errorWith(people(), { t: "assign", items: ["T1"], person: "nobody" }, "Person nobody is not in this plan");
    errorWith(people(), { t: "assign", items: ["T1"], person: "zed" }, "Person zed is not in this plan");
  });

  it("unassigns, writing null for an emptied list", () => {
    const b = buildAction(people(), { t: "unassign", items: ["T1"], person: "mira" });
    expect(b.action.w).toEqual([w("pa:T1", null)]);
    expect(b.action.lbl).toBe("Unassigned “Mira Okafor” from “Mirror test”");
    const two = buildAction(people(), { t: "unassign", items: ["T1", "T2", "T3"], person: "mira" });
    expect(two.action.w).toEqual([w("pa:T1", null), w("pa:T2", ["ole", "zed"])]);
    expect(two.action.lbl).toBe("Unassigned “Mira Okafor” from 2 items");
  });

  it("refuses an unassign that changes nothing", () => {
    refusedWith(people(), { t: "unassign", items: ["T3"], person: "mira" }, NOTHING);
  });
});

describe("assignees", () => {
  it("sets the sorted list of an item", () => {
    const b = buildAction(people(), { t: "assignees", item: "T1", people: ["ole", "ana"] });
    expect(b.action.w).toEqual([w("pa:T1", ["ana", "ole"])]);
    expect(b.action.lbl).toBe("Changed the assignees of “Mirror test”");
  });

  it("writes null for an empty list and refuses an unchanged one", () => {
    expect(buildAction(people(), { t: "assignees", item: "T1", people: [] }).action.w).toEqual([w("pa:T1", null)]);
    refusedWith(people(), { t: "assignees", item: "T3", people: [] }, NOTHING);
    refusedWith(people(), { t: "assignees", item: "T2", people: ["zed", "ole", "mira"] }, NOTHING);
  });

  it("keeps a former assignee the item already holds, and throws for a removed person it does not", () => {
    expect(buildAction(people(), { t: "assignees", item: "M1", people: ["zed", "ole"] }).action.w).toEqual([w("pa:M1", ["ole", "zed"])]);
    errorWith(people(), { t: "assignees", item: "T1", people: ["zed"] }, "Person zed is not in this plan");
  });

  it("refuses nine people and a trashed item, and throws for a repeated person and a group", () => {
    refusedWith(crowded(), { t: "assignees", item: "T1", people: NINE }, "An item has at most 8 assignees.");
    refusedWith(people(), { t: "assignees", item: "X", people: [] }, "“Old” is in the Trash. Restore it first.");
    errorWith(people(), { t: "assignees", item: "T1", people: ["ole", "ole"] }, "Person ole is repeated");
    errorWith(people(), { t: "assignees", item: "G", people: ["ole"] }, "Group G has no assignees");
  });
});

describe("create and duplicate", () => {
  it("duplicate copies live assignees only", () => {
    const b = buildAction(people(), { t: "duplicate", item: "T2" });
    const copied = units(b).filter((u) => u.startsWith("pa:"));
    expect(copied).toHaveLength(1);
    expect(valueAt(b, copied[0])).toEqual(["mira", "ole"]);
    expect(units(buildAction(people(), { t: "duplicate", item: "M1" })).some((u) => u.startsWith("pa:"))).toBe(false);
    expect(units(buildAction(people(), { t: "duplicate", item: "T3" })).some((u) => u.startsWith("pa:"))).toBe(false);
  });

  it("duplicating a group copies the assignees of its items", () => {
    const ctx = ctxFrom([...ROOT, w("pa:C1", ["ana"])], act("a1", ["a0"], [w("pp:zed", null)]));
    const b = buildAction(ctx, { t: "duplicate", item: "G" });
    const copied = units(b).filter((u) => u.startsWith("pa:"));
    expect(copied).toHaveLength(1);
    expect(valueAt(b, copied[0])).toEqual(["ana"]);
  });

  it("create writes no pa", () => {
    const b = buildAction(people(), { t: "create", kind: "task", name: "New", parent: null, after: null, start: "2026-11-16" });
    expect(units(b).some((u) => u.startsWith("pa:"))).toBe(false);
  });
});
