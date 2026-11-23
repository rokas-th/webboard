import { afterEach, describe, expect, it, vi } from "vitest";
import { projectBoard } from "../../domain/steps";
import type { PlanView } from "../../store/doc";
import type { PlanSession } from "../../store/session";
import { testSession, type SeedItem, type TestSession } from "../../test/session";
import { boardLayout, filterLayout, NO_STEP_KEY } from "../board/layout";
import { EMPTY_BOARD_PREFS, type BoardPrefs } from "../board/prefs";
import { boardPages, keptPage, NO_STEP_PAGE, pageAt, pageOfItem, type BoardPage } from "./boardPages";

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

const prefs = (hidden: readonly string[], doneOpen = false): BoardPrefs => ({ v: 1, hidden, doneOpen });

const pagesOf = (view: PlanView, p: BoardPrefs = EMPTY_BOARD_PREFS): readonly BoardPage[] => boardPages(boardLayout(view, projectBoard(view.plan, view.derived), p));

const shape = (page: BoardPage): string =>
  `${page.key}:${page.kind}${page.completing ? "!" : ""}=${page.count}/${page.limit === null ? "-" : page.limit}[${page.items.map((i) => i.id).join(",")}|${page.shown.map((i) => i.id).join(",")}]`;

const keyed = (keys: readonly string[]): readonly BoardPage[] => keys.map((key) => ({ key, kind: "step", step: null, count: 0, limit: null, items: [], shown: [], completing: false }));

describe("boardPages", () => {
  it("makes one page per column, a folded Done with its count and no items", async () => {
    const t = await made(SEED);
    const pages = pagesOf(t.session.view());
    expect(pages.map(shape)).toEqual(["now:step=1/-[soon|soon]", "next:step=2/-[mid,u|mid,u]", "later:step=1/-[w|w]", "done:folded!=2/-[|]"]);
    expect(pages.map((p) => (p.step === null ? null : p.step.id))).toEqual(["now", "next", "later", "done"]);
  });

  it("puts No step first, keyed no-step, with no step and no limit", async () => {
    const t = await made(SEED);
    t.session.apply({ t: "step", op: "add", name: "QA", colour: "amber", after: "later" });
    const qa = [...t.session.view().plan.workflow.steps.keys()][0];
    const phone = await t.peer("iphone");
    sessions.push(phone.session);
    phone.session.apply({ t: "toStep", items: ["w"], step: qa });
    t.session.apply({ t: "step", op: "delete", step: qa, to: null });
    phone.sync();
    const pages = pagesOf(t.session.view());
    expect([NO_STEP_PAGE, NO_STEP_KEY]).toEqual(["no-step", "no-step"]);
    expect(pages.map(shape)).toEqual(["no-step:noStep=1/-[w|w]", "now:step=1/-[soon|soon]", "next:step=2/-[mid,u|mid,u]", "later:step=0/-[|]", "done:folded!=2/-[|]"]);
    expect(pages[0].step).toBeNull();
  });

  it("makes a hidden step a hidden page with its count and no items, and an open Done a completing step", async () => {
    const t = await made(SEED);
    t.session.apply({ t: "step", op: "limit", step: "next", limit: 1 });
    expect(pagesOf(t.session.view(), prefs(["next"], true)).map(shape)).toEqual(["now:step=1/-[soon|soon]", "next:hidden=2/1[|]", "later:step=1/-[w|w]", "done:step!=2/-[d1,d2|d1,d2]"]);
    expect(pagesOf(t.session.view(), prefs([], false)).map(shape)[1]).toBe("next:step=2/1[mid,u|mid,u]");
  });

  it("keeps the filtered cards as shown and every card as items", async () => {
    const t = await made(SEED);
    const view = t.session.view();
    const layout = filterLayout(boardLayout(view, projectBoard(view.plan, view.derived), EMPTY_BOARD_PREFS), (id) => id === "u");
    expect(boardPages(layout).map(shape)[1]).toBe("next:step=2/-[mid,u|u]");
  });
});

describe("pageAt", () => {
  const pages = keyed(["a", "b", "c"]);

  it("rounds the scroll position to the nearest page", () => {
    expect([pageAt(0, 390, pages), pageAt(194, 390, pages), pageAt(196, 390, pages), pageAt(780, 390, pages)]).toEqual([0, 0, 1, 2]);
  });

  it("clamps into the pages", () => {
    expect([pageAt(-120, 390, pages), pageAt(5000, 390, pages)]).toEqual([0, 2]);
  });

  it("throws on no width or no pages", () => {
    expect(() => pageAt(0, 0, pages)).toThrow();
    expect(() => pageAt(0, -1, pages)).toThrow();
    expect(() => pageAt(0, 390, [])).toThrow();
  });
});

describe("keptPage", () => {
  const pages = keyed(["a", "b", "c"]);

  it("keeps a key that is still a page", () => {
    expect(keptPage(pages, "c", 0)).toBe("c");
  });

  it("falls back to the key at the index, clamped, when the key is gone or null", () => {
    expect([keptPage(pages, "gone", 1), keptPage(pages, null, 0), keptPage(pages, "gone", 7), keptPage(pages, null, -2)]).toEqual(["b", "a", "c", "a"]);
  });

  it("throws on no pages", () => {
    expect(() => keptPage([], "a", 0)).toThrow();
  });
});

describe("pageOfItem", () => {
  it("finds the page whose shown cards hold the item, and null for a folded or hidden one", async () => {
    const t = await made(SEED);
    const pages = pagesOf(t.session.view());
    expect([pageOfItem(pages, "mid"), pageOfItem(pages, "w"), pageOfItem(pages, "d1"), pageOfItem(pages, "nope")]).toEqual(["next", "later", null, null]);
    const hidden = pagesOf(t.session.view(), prefs(["next"]));
    expect(pageOfItem(hidden, "mid")).toBeNull();
  });
});
