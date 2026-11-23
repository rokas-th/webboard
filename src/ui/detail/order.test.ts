import { afterEach, describe, expect, it, vi } from "vitest";
import type { PlanView } from "../../store/doc";
import type { PlanSession } from "../../store/session";
import { testSession, type SeedItem } from "../../test/session";
import { EMPTY_BOARD_PREFS } from "../board/prefs";
import type { NoteText } from "../list/columns";
import { DEFAULT_LIST_PREFS, type ListPrefs } from "../list/prefs";
import { planMatcher } from "../search/match";
import { stepFrom, tabOrder } from "./order";

vi.mock("@tauri-apps/api/core", () => import("../../test/tauriMock"));

const sessions: PlanSession[] = [];

afterEach(async () => {
  await Promise.all(sessions.splice(0).map((s) => s.close()));
});

const SEED: readonly SeedItem[] = [
  { id: "g", name: "G", kind: "group" },
  { id: "a", name: "A", parent: "g", start: "2026-11-10", dur: 2 },
  { id: "b", name: "B", parent: "g", start: "2027-02-01", dur: 2 },
  { id: "n", name: "N", start: "2026-12-10", dur: 2 },
  { id: "u", name: "U", horizon: "next" },
  {
    id: "d",
    name: "D",
    start: "2026-11-02",
    dur: 1,
    status: "done",
    progress: 100,
  },
];

const made = async (): Promise<{ v: PlanView; notes: NoteText }> => {
  const t = await testSession(SEED);
  sessions.push(t.session);
  return { v: t.session.view(), notes: (id) => t.session.note(id).toString() };
};

describe("tabOrder", () => {
  it("is the Timeline's rows, groups included, minus what a collapsed group hides", async () => {
    const { v, notes } = await made();
    expect(tabOrder(v, { view: "timeline", collapsed: new Set() }, EMPTY_BOARD_PREFS, DEFAULT_LIST_PREFS, notes, null, null)).toEqual(["g", "a", "b", "n", "d"]);
    expect(tabOrder(v, { view: "timeline", collapsed: new Set(["g"]) }, EMPTY_BOARD_PREFS, DEFAULT_LIST_PREFS, notes, null, null)).toEqual(["g", "n", "d"]);
  });

  it("is the Board's cards, Now then Next then Later, top to bottom, without the hidden done ones", async () => {
    const { v, notes } = await made();
    expect(tabOrder(v, { view: "board", collapsed: new Set(["g"]) }, EMPTY_BOARD_PREFS, DEFAULT_LIST_PREFS, notes, null, null)).toEqual(["a", "n", "u", "b"]);
  });

  it("skips the Board's cards the search filters out", async () => {
    const { v, notes } = await made();
    expect(tabOrder(v, { view: "board", collapsed: new Set() }, EMPTY_BOARD_PREFS, DEFAULT_LIST_PREFS, notes, null, (id) => id !== "n" && id !== "a")).toEqual(["u", "b"]);
  });

  it("is the List's rows, section by section, in Open without the done ones", async () => {
    const { v, notes } = await made();
    expect(tabOrder(v, { view: "list", collapsed: new Set(["g"]) }, EMPTY_BOARD_PREFS, DEFAULT_LIST_PREFS, notes, null, null)).toEqual(["a", "b", "n", "u"]);
  });

  it("is the List's rows in its scope and sort", async () => {
    const { v, notes } = await made();
    const prefs: ListPrefs = { ...DEFAULT_LIST_PREFS, scope: "all", group: "none", sort: [{ id: "start", dir: "desc" }] };
    expect(tabOrder(v, { view: "list", collapsed: new Set() }, EMPTY_BOARD_PREFS, prefs, notes, null, null)).toEqual(["b", "n", "a", "d", "u"]);
  });

  it("is only the List's matching rows while a search is set", async () => {
    const { v, notes } = await made();
    const match = planMatcher(v, notes, "g");
    expect(tabOrder(v, { view: "list", collapsed: new Set() }, EMPTY_BOARD_PREFS, DEFAULT_LIST_PREFS, notes, null, match)).toEqual(["a", "b"]);
  });
});

describe("tabOrder on the phone", () => {
  it("is the list's rows on the list tab, in its scope, sort and search, and the rows on the timeline tab", async () => {
    const { v, notes } = await made();
    expect(tabOrder(v, { view: "list", collapsed: new Set(["g"]) }, EMPTY_BOARD_PREFS, DEFAULT_LIST_PREFS, notes, null, null)).toEqual(["a", "b", "n", "u"]);
    const prefs: ListPrefs = { ...DEFAULT_LIST_PREFS, scope: "all", group: "none", sort: [{ id: "start", dir: "desc" }] };
    expect(tabOrder(v, { view: "list", collapsed: new Set() }, EMPTY_BOARD_PREFS, prefs, notes, null, null)).toEqual(["b", "n", "a", "d", "u"]);
    expect(tabOrder(v, { view: "list", collapsed: new Set() }, EMPTY_BOARD_PREFS, DEFAULT_LIST_PREFS, notes, null, planMatcher(v, notes, "g"))).toEqual(["a", "b"]);
    expect(tabOrder(v, { view: "timeline", collapsed: new Set(["g"]) }, EMPTY_BOARD_PREFS, prefs, notes, null, null)).toEqual(["g", "n", "d"]);
  });
});

describe("stepFrom", () => {
  it("stepFrom clamps, starts at an end, empty is null", () => {
    const order = ["a", "b", "c"];
    expect([stepFrom(order, "a", 1), stepFrom(order, "b", -1), stepFrom(order, "c", 1), stepFrom(order, "a", -1)]).toEqual(["b", "a", "c", "a"]);
    expect([stepFrom(order, null, 1), stepFrom(order, null, -1), stepFrom(order, "x", 1), stepFrom(order, "x", -1)]).toEqual(["a", "c", "a", "c"]);
    expect([stepFrom([], null, 1), stepFrom([], "a", -1)]).toEqual([null, null]);
  });
});
