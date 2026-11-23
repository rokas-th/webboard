import { afterEach, describe, expect, it, vi } from "vitest";
import type { ItemId } from "../../domain/model";
import { projectBoard, stepsOf } from "../../domain/steps";
import type { PlanView } from "../../store/doc";
import type { PlanSession } from "../../store/session";
import { testSession, type SeedItem, type TestSession } from "../../test/session";
import { boardLayout, cardOrder, filterLayout, nearnessOf, statusOf, type BoardColumn, type BoardLayout } from "./layout";
import { EMPTY_BOARD_PREFS, type BoardPrefs } from "./prefs";
import { NO_OPEN_STEP } from "./text";

vi.mock("@tauri-apps/api/core", () => import("../../test/tauriMock"));

const sessions: PlanSession[] = [];

afterEach(async () => {
  await Promise.all(sessions.splice(0).map((s) => s.close()));
});

const made = async (seed: readonly SeedItem[]): Promise<TestSession> => {
  const t = await testSession(seed);
  sessions.push(t.session);
  return t;
};

const SEED: SeedItem[] = [
  { name: "soon", start: "2026-11-20", dur: 2 },
  { name: "mid", start: "2026-12-15", dur: 2 },
  { name: "d1", start: "2026-11-02", dur: 1, status: "done", progress: 100 },
  { name: "d2", start: "2026-11-03", dur: 1, status: "done", progress: 100 },
  { name: "u", horizon: "next" },
  { name: "w" },
];

const layoutOf = (view: PlanView, prefs: BoardPrefs = EMPTY_BOARD_PREFS): BoardLayout => boardLayout(view, projectBoard(view.plan, view.derived), prefs);

const shape = (c: BoardColumn): string => {
  if (c.kind === "noStep") return `noStep[${c.items.map((i) => i.id).join(",")}]`;
  if (c.kind === "step") return `${c.step.id}${c.completing ? "!" : ""}[${c.items.map((i) => i.id).join(",")}]`;
  return `${c.kind}:${c.step.id}=${c.count}`;
};

const shapes = (l: BoardLayout): string[] => l.columns.map(shape);

const prefs = (hidden: readonly string[], doneOpen = false): BoardPrefs => ({ v: 1, hidden, doneOpen });

describe("boardLayout", () => {
  it("lays a by-dates plan out as three columns and a Done strip of 2", async () => {
    const t = await made(SEED);
    const l = layoutOf(t.session.view());
    expect(l.mode).toBe("dates");
    expect(shapes(l)).toEqual(["now[soon]", "next[mid,u]", "later[w]", "doneStrip:done=2"]);
    expect([l.hiddenDone, l.problems, l.empty]).toEqual([0, [], null]);
  });

  it("puts No step first", async () => {
    const t = await made(SEED);
    t.session.apply({ t: "step", op: "add", name: "QA", colour: "amber", after: "later" });
    const qa = [...t.session.view().plan.workflow.steps.keys()][0];
    const phone = await t.peer("iphone");
    sessions.push(phone.session);
    phone.session.apply({ t: "toStep", items: ["w"], step: qa });
    t.session.apply({ t: "step", op: "delete", step: qa, to: null });
    phone.sync();
    const l = layoutOf(t.session.view());
    expect(l.mode).toBe("steps");
    expect(shapes(l)).toEqual(["noStep[w]", "now[soon]", "next[mid,u]", "later[]", "doneStrip:done=2"]);
  });

  it("makes hidden steps 36 px strips, and a hidden Done a hidden strip rather than a Done strip", async () => {
    const t = await made(SEED);
    expect(shapes(layoutOf(t.session.view(), prefs(["next", "gone0000001"])))).toEqual(["now[soon]", "hiddenStrip:next=2", "later[w]", "doneStrip:done=2"]);
    expect(shapes(layoutOf(t.session.view(), prefs(["done"], true)))).toEqual(["now[soon]", "next[mid,u]", "later[w]", "hiddenStrip:done=2"]);
  });

  it("opens Done into a full column with doneOpen", async () => {
    const t = await made(SEED);
    expect(shapes(layoutOf(t.session.view(), prefs([], true)))).toEqual(["now[soon]", "next[mid,u]", "later[w]", "done![d1,d2]"]);
  });

  it("keeps Done expanded while it holds open items, open cards first, and reports them", async () => {
    const t = await made(SEED);
    t.session.apply({ t: "toStep", items: ["w"], step: "done" });
    t.session.apply({ t: "step", op: "completes", step: "later", completes: true });
    t.session.apply({ t: "schedule", item: "w", set: { status: "todo", progress: 0 } });
    const l = layoutOf(t.session.view());
    expect(shapes(l)).toEqual(["now[soon]", "next[mid,u]", "later![w,d1,d2]", "done[]"]);
    expect(l.problems).toEqual(["“Later” completes items but holds 1 item that is not done."]);
  });

  it("counts done items as hidden when no step completes, and names the problems in order", async () => {
    const t = await made(SEED);
    t.session.apply({ t: "step", op: "completes", step: "done", completes: false });
    const none = layoutOf(t.session.view());
    expect(shapes(none)).toEqual(["now[soon]", "next[mid,u]", "later[w]", "done[]"]);
    expect([none.hiddenDone, none.problems]).toEqual([2, []]);
    const phone = await t.peer("iphone");
    sessions.push(phone.session);
    t.session.apply({ t: "step", op: "rename", step: "later", name: "Review" });
    t.session.apply({ t: "step", op: "completes", step: "done", completes: true });
    phone.session.apply({ t: "step", op: "rename", step: "now", name: "Review" });
    phone.session.apply({ t: "step", op: "add", name: "Shipped", colour: "sky", after: "done" });
    const shipped = stepsOf(phone.session.view().plan).find((s) => s.name === "Shipped");
    if (shipped === undefined) throw new Error("no Shipped");
    phone.session.apply({ t: "step", op: "completes", step: shipped.id, completes: true });
    phone.sync();
    const both = layoutOf(t.session.view());
    expect(both.problems).toEqual(["Several steps complete items: “Done”, “Shipped”. Only “Done” does; clear Completes items on the others.", "More than one step is named “Review”. Rename one."]);
  });

  it("names the reason when every live step completes, with the done count", async () => {
    const t = await made([{ name: "d1", start: "2026-11-02", dur: 1, status: "done", progress: 100 }]);
    const phone = await t.peer("iphone");
    sessions.push(phone.session);
    phone.session.apply({ t: "step", op: "delete", step: "now", to: null });
    phone.session.apply({ t: "step", op: "delete", step: "next", to: null });
    t.session.apply({ t: "step", op: "delete", step: "later", to: "done" });
    phone.sync();
    const l = layoutOf(t.session.view());
    expect(shapes(l)).toEqual(["doneStrip:done=1"]);
    expect(l.empty).toBe(`${NO_OPEN_STEP} 1 done item is hidden.`);
  });
});

describe("cardOrder", () => {
  it("lists the cards of No step and the full columns, left to right and top to bottom, never a strip", async () => {
    const t = await made(SEED);
    expect(cardOrder(layoutOf(t.session.view()))).toEqual(["soon", "mid", "u", "w"]);
    expect(cardOrder(layoutOf(t.session.view(), prefs(["next"], true)))).toEqual(["soon", "w", "d1", "d2"]);
  });
});

describe("filterLayout", () => {
  const shownOf = (c: BoardColumn): string => (c.kind === "noStep" || c.kind === "step" ? c.shown.map((i) => i.id).join(",") : `${c.kind}=${c.count}`);

  it("is the layout itself without a matcher", async () => {
    const t = await made(SEED);
    const l = layoutOf(t.session.view());
    expect(filterLayout(l, null)).toBe(l);
    expect(l.columns.map(shownOf)).toEqual(["soon", "mid,u", "w", "doneStrip=2"]);
  });

  it("drops the cards that do not match from what is shown, keeps every column's items and strip counts, and orders only the shown cards", async () => {
    const t = await made(SEED);
    const l = filterLayout(layoutOf(t.session.view(), prefs([], true)), (id) => id === "u" || id === "d2");
    expect(l.columns.map(shownOf)).toEqual(["", "u", "", "d2"]);
    expect(shapes(l)).toEqual(["now[soon]", "next[mid,u]", "later[w]", "done![d1,d2]"]);
    expect(cardOrder(l)).toEqual(["u", "d2"]);
    expect(filterLayout(layoutOf(t.session.view()), () => false).columns.map(shownOf)).toEqual(["", "", "", "doneStrip=2"]);
  });
});

describe("nearnessOf", () => {
  const near = async (seed: readonly SeedItem[], steps: boolean): Promise<(id: ItemId) => unknown> => {
    const t = await made(seed);
    if (steps) t.session.apply({ t: "step", op: "rename", step: "next", name: "Review" });
    const view = t.session.view();
    const mode = projectBoard(view.plan, view.derived).mode;
    return (id) => {
      const item = view.plan.items.get(id);
      if (item === undefined) throw new Error("no item " + id);
      return nearnessOf(view, mode, item);
    };
  };

  const SOON: SeedItem[] = [
    { name: "d1", start: "2026-11-10", dur: 2 },
    { name: "d7", start: "2026-11-16", dur: 2 },
    { name: "d8", start: "2026-11-17", dur: 2 },
    { name: "doing", start: "2026-11-10", dur: 2, status: "doing", progress: 10 },
    { name: "late", start: "2026-11-02", dur: 2 },
    { name: "done", start: "2026-11-10", dur: 1, status: "done", progress: 100 },
    { name: "undated" },
  ];

  it("says starts in 1 and 7 days, nothing at 8, late when late, and nothing for doing, done or undated items", async () => {
    const of = await near(SOON, true);
    expect(["d1", "d7", "d8", "doing", "late", "done", "undated"].map(of)).toEqual([
      { kind: "soon", days: 1 },
      { kind: "soon", days: 7 },
      null,
      null,
      { kind: "late" },
      null,
      null,
    ]);
  });

  it("says nothing by dates", async () => {
    const of = await near(SOON, false);
    expect(["d1", "late"].map(of)).toEqual([null, null]);
  });
});

describe("statusOf", () => {
  it("reads an item's status and throws for an item the derivation has none for", async () => {
    const t = await made(SEED);
    const view = t.session.view();
    expect([statusOf(view, "d1"), statusOf(view, "w")]).toEqual(["done", "todo"]);
    expect(() => statusOf(view, "nope")).toThrow("Board: item nope has no status");
  });
});
