import { afterEach, describe, expect, it, vi } from "vitest";
import type { PlanSession } from "../../store/session";
import { testSession, type SeedItem } from "../../test/session";
import { phoneOrder, stepFrom, tabOrder } from "./order";

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

const view = async () => {
  const t = await testSession(SEED);
  sessions.push(t.session);
  return t.session.view();
};

describe("tabOrder", () => {
  it("is the Timeline's rows, groups included, minus what a collapsed group hides", async () => {
    const v = await view();
    expect(tabOrder(v, { view: "timeline", collapsed: new Set() })).toEqual(["g", "a", "b", "n", "d"]);
    expect(tabOrder(v, { view: "timeline", collapsed: new Set(["g"]) })).toEqual(["g", "n", "d"]);
  });

  it("is the Board's cards, Now then Next then Later, top to bottom, without the hidden done ones", async () => {
    const v = await view();
    expect(tabOrder(v, { view: "board", collapsed: new Set(["g"]) })).toEqual(["a", "n", "u", "b"]);
  });

  it("is the List's rows, section by section", async () => {
    const v = await view();
    expect(tabOrder(v, { view: "list", collapsed: new Set(["g"]) })).toEqual(["a", "b", "n", "u", "d"]);
  });
});

describe("phoneOrder", () => {
  it("is the list's rows on the list tab, whatever the bucket, and the rows on the timeline tab", async () => {
    const v = await view();
    expect(phoneOrder(v, "list", new Set(["g"]))).toEqual(["a", "b", "n", "u", "d"]);
    expect(phoneOrder(v, "timeline", new Set(["g"]))).toEqual(["g", "n", "d"]);
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
