import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearToasts, COPY_DETAILS, Toasts } from "../common/Toast";
import { DEFAULT_LIST_PREFS, listKey, readListPrefs, readListPrefsRecord, useListPrefs, writeListPrefs, type ColumnId, type ListPrefs, type SortKey } from "./prefs";
import { CHIP_LIMIT, LIST_PREFS_UNREADABLE, SORT_LIMIT } from "./text";

const PLAN = "planMesa001";
const OTHER = "planOther01";

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  clearToasts();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

const asc = (id: ColumnId): SortKey => ({ id, dir: "asc" });

const toastTexts = (): (string | null)[] => Array.from(document.querySelectorAll<HTMLElement>(".toasts .toast")).map((e) => e.textContent);

const FULL: ListPrefs = {
  v: 1,
  cols: [
    { id: "name", w: 300 },
    { id: "step", w: 140 },
    { id: "note", w: 240 },
  ],
  sort: [
    { id: "step", dir: "asc" },
    { id: "name", dir: "desc" },
  ],
  scope: "late",
  chips: [
    { f: "step", v: "stepQa00001" },
    { f: "assignee", v: null },
    { f: "kind", v: "milestone" },
    { f: "group", v: "g1" },
  ],
  group: "step",
};

const copied = async (): Promise<string[]> => {
  const written: string[] = [];
  vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText: (text: string) => Promise.resolve(void written.push(text)) } });
  fireEvent.click(screen.getByRole("button", { name: COPY_DETAILS }));
  await act(async () => {
    await Promise.resolve();
  });
  return written;
};

describe("list prefs", () => {
  it("keys a plan's record by its id and defaults to six columns, Plan order, Open, no chips, the outline", () => {
    expect(listKey(PLAN)).toBe("webboard.list.planMesa001");
    expect(DEFAULT_LIST_PREFS).toEqual({
      v: 1,
      cols: [
        { id: "name", w: 300 },
        { id: "step", w: 140 },
        { id: "assignees", w: 170 },
        { id: "start", w: 88 },
        { id: "end", w: 88 },
        { id: "status", w: 110 },
      ],
      sort: [],
      scope: "open",
      chips: [],
      group: "outline",
    });
  });

  it("round-trips a full record through storage", () => {
    writeListPrefs(window.localStorage, PLAN, FULL);
    expect(JSON.parse(window.localStorage.getItem(listKey(PLAN)) ?? "null")).toEqual(FULL);
    expect(readListPrefs(window.localStorage, PLAN)).toEqual(FULL);
    expect(readListPrefsRecord(JSON.stringify(FULL))).toEqual({ ok: true, value: FULL });
  });

  it("takes every column once, each at its minimum and at 640", () => {
    const ids = ["name", "step", "status", "assignees", "start", "end", "days", "progress", "late", "deps", "blocks", "group", "kind", "note"];
    const mins = [180, 90, 90, 110, 72, 72, 56, 90, 70, 120, 120, 110, 80, 140];
    const at = (w: (i: number) => number) => ({ ...DEFAULT_LIST_PREFS, cols: ids.map((id, i) => ({ id, w: w(i) })) });
    expect(readListPrefsRecord(JSON.stringify(at((i) => mins[i]))).ok).toBe(true);
    expect(readListPrefsRecord(JSON.stringify(at(() => 640))).ok).toBe(true);
  });

  it("reads nothing stored as the defaults and writes nothing", () => {
    expect(readListPrefs(window.localStorage, PLAN)).toEqual(DEFAULT_LIST_PREFS);
    expect(window.localStorage.length).toBe(0);
  });

  const raw = (over: Record<string, unknown>): string => JSON.stringify({ ...FULL, ...over });

  it.each([
    ["an unknown column id", raw({ cols: [{ id: "name", w: 300 }, { id: "owner", w: 100 }] }), "cols[1].id is \"owner\", not a List column"],
    ["name not first", raw({ cols: [{ id: "step", w: 140 }, { id: "name", w: 300 }], sort: [] }), "cols[0] is step, not name"],
    ["a width under its minimum", raw({ cols: [{ id: "name", w: 179 }] , sort: []}), "cols[0].w is 179, not a whole number from 180 to 640"],
    ["a width over 640", raw({ cols: [{ id: "name", w: 641 }], sort: [] }), "cols[0].w is 641, not a whole number from 180 to 640"],
    ["a fractional width", raw({ cols: [{ id: "name", w: 200.5 }], sort: [] }), "cols[0].w is 200.5, not a whole number from 180 to 640"],
    ["a repeated column", raw({ cols: [{ id: "name", w: 300 }, { id: "step", w: 140 }, { id: "step", w: 140 }], sort: [] }), "cols[2] repeats step"],
    ["no columns", raw({ cols: [], sort: [] }), "cols holds 0 columns, not 1 to 14"],
    ["a sort id outside the columns", raw({ sort: [{ id: "status", dir: "asc" }] }), "sort[0].id is status, which is not among the columns"],
    ["a bad sort direction", raw({ sort: [{ id: "name", dir: "up" }] }), "sort[0].dir is \"up\", not asc or desc"],
    ["four sort keys", raw({ cols: [{ id: "name", w: 300 }, { id: "step", w: 140 }, { id: "start", w: 88 }, { id: "end", w: 88 }], sort: ["name", "step", "start", "end"].map((id) => ({ id, dir: "asc" })) }), "sort holds 4 keys, not at most 3"],
    ["a repeated sort key", raw({ sort: [{ id: "name", dir: "asc" }, { id: "name", dir: "desc" }] }), "sort[1] repeats name"],
    ["mine", raw({ scope: "mine" }), "scope is \"mine\", not one of open, soon, late, blocked, unscheduled, unassigned, milestones, done, all"],
    ["a bad chip field", raw({ chips: [{ f: "label", v: "x" }] }), "chips[0].f is \"label\", not step, assignee, kind or group"],
    ["a bad chip value", raw({ chips: [{ f: "step", v: "a b" }] }), "chips[0].v is \"a b\", not null or an id"],
    ["a bad kind chip", raw({ chips: [{ f: "kind", v: "group" }] }), "chips[0].v is \"group\", not task or milestone"],
    ["a chip with an extra key", raw({ chips: [{ f: "step", v: null, x: 1 }] }), "chips[0] is {f, v, x}, not {f, v}"],
    ["a repeated chip", raw({ chips: [{ f: "step", v: null }, { f: "step", v: null }] }), "chips[1] repeats step null"],
    ["33 chips", raw({ chips: Array.from({ length: 33 }, (_, i) => ({ f: "group", v: `g${i}` })) }), "chips holds 33 chips, not at most 32"],
    ["a bad group", raw({ group: "kind" }), "group is \"kind\", not outline, step, assignee or none"],
    ["an extra key", raw({ x: 1 }), "the record is {v, cols, sort, scope, chips, group, x}, not {chips, cols, group, scope, sort, v}"],
    ["v 2", raw({ v: 2 }), "v is 2, not 1"],
    ["an array", "[]", "the record is [], not {chips, cols, group, scope, sort, v}"],
  ])("refuses %s with its reason", (_, text, reason) => {
    expect(readListPrefsRecord(text)).toEqual({ ok: false, reason });
  });

  it("names the JSON error of a record that is not JSON", () => {
    const read = readListPrefsRecord("{v:1");
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.reason).toMatch(/^it is not JSON \(.+\)$/);
  });

  it.each([
    ["an unknown column id", raw({ cols: [{ id: "name", w: 300 }, { id: "owner", w: 100 }] }), "cols[1].id is \"owner\", not a List column"],
    ["name not first", raw({ cols: [{ id: "step", w: 140 }, { id: "name", w: 300 }], sort: [] }), "cols[0] is step, not name"],
    ["a width under its minimum", raw({ cols: [{ id: "name", w: 120 }], sort: [] }), "cols[0].w is 120, not a whole number from 180 to 640"],
    ["a sort id outside the columns", raw({ sort: [{ id: "status", dir: "asc" }] }), "sort[0].id is status, which is not among the columns"],
    ["mine", raw({ scope: "mine" }), "scope is \"mine\", not one of open, soon, late, blocked, unscheduled, unassigned, milestones, done, all"],
    ["a bad chip", raw({ chips: [{ f: "kind", v: "group" }] }), "chips[0].v is \"group\", not task or milestone"],
    ["an extra key", raw({ x: 1 }), "the record is {v, cols, sort, scope, chips, group, x}, not {chips, cols, group, scope, sort, v}"],
  ])("resets %s, removing only this plan's key, and toasts the reason", async (_, text, reason) => {
    render(<Toasts />);
    window.localStorage.setItem(listKey(PLAN), text);
    window.localStorage.setItem(listKey(OTHER), JSON.stringify(FULL));
    window.localStorage.setItem("webboard.board.planMesa001", "{}");
    act(() => {
      expect(readListPrefs(window.localStorage, PLAN)).toEqual(DEFAULT_LIST_PREFS);
      expect(readListPrefs(window.localStorage, PLAN)).toEqual(DEFAULT_LIST_PREFS);
    });
    expect(window.localStorage.getItem(listKey(PLAN))).toBeNull();
    expect(window.localStorage.getItem(listKey(OTHER))).toBe(JSON.stringify(FULL));
    expect(window.localStorage.getItem("webboard.board.planMesa001")).toBe("{}");
    expect(toastTexts()).toEqual([LIST_PREFS_UNREADABLE]);
    expect(document.querySelector(".toasts .toast")?.className).toBe("toast bad");
    const shown = text.length > 200 ? `${text.slice(0, 200)}… (${text.length} characters)` : text;
    expect(await copied()).toEqual([`${reason}. The record was: ${shown}`]);
  });

  it("resets a record that is not JSON and shows its first 200 characters", async () => {
    render(<Toasts />);
    const text = `{"v":1,"cols":[${'"x",'.repeat(400)}`;
    window.localStorage.setItem(listKey(PLAN), text);
    act(() => {
      expect(readListPrefs(window.localStorage, PLAN)).toEqual(DEFAULT_LIST_PREFS);
    });
    expect(window.localStorage.getItem(listKey(PLAN))).toBeNull();
    expect(toastTexts()).toEqual([LIST_PREFS_UNREADABLE]);
    const [details] = await copied();
    expect(details).toMatch(/^it is not JSON \(.+\)\. The record was: /);
    expect(details.endsWith(`The record was: ${text.slice(0, 200)}… (${text.length} characters)`)).toBe(true);
  });

  it("lets an error other than a SyntaxError propagate", () => {
    const parse = vi.spyOn(JSON, "parse").mockImplementation(() => {
      throw new RangeError("deep");
    });
    try {
      expect(() => readListPrefsRecord("{}")).toThrow("deep");
    } finally {
      parse.mockRestore();
    }
  });

  it("refuses a fourth sort key with a toast and keeps the record", () => {
    render(<Toasts />);
    const three: ListPrefs = { ...DEFAULT_LIST_PREFS, sort: [asc("name"), asc("step"), asc("start")] };
    writeListPrefs(window.localStorage, PLAN, three);
    act(() => {
      writeListPrefs(window.localStorage, PLAN, { ...three, sort: [...three.sort, asc("end")] });
    });
    expect(readListPrefs(window.localStorage, PLAN)).toEqual(three);
    expect(toastTexts()).toEqual([SORT_LIMIT]);
  });

  it("refuses a 33rd chip with a toast and keeps the record, as it does a fourth sort key", () => {
    render(<Toasts />);
    const full: ListPrefs = { ...DEFAULT_LIST_PREFS, chips: Array.from({ length: 32 }, (_, i) => ({ f: "group", v: `g${i}` })) };
    writeListPrefs(window.localStorage, PLAN, full);
    act(() => {
      writeListPrefs(window.localStorage, PLAN, { ...full, chips: [...full.chips, { f: "group", v: "g32" }] });
    });
    expect(readListPrefs(window.localStorage, PLAN)).toEqual(full);
    expect(toastTexts()).toEqual([CHIP_LIMIT]);
  });

  it("throws rather than write a record it could not read back", () => {
    expect(() => writeListPrefs(window.localStorage, PLAN, { ...DEFAULT_LIST_PREFS, cols: [{ id: "step", w: 140 }] })).toThrow("cols[0] is step, not name");
    expect(window.localStorage.getItem(listKey(PLAN))).toBeNull();
  });

  it("follows writes and resets in the hook, with one toast", () => {
    window.localStorage.setItem(listKey(PLAN), JSON.stringify(FULL));
    function Probe() {
      const prefs = useListPrefs(PLAN);
      return <span data-scope={prefs.scope} />;
    }
    const view = render(
      <>
        <Toasts />
        <Probe />
      </>,
    );
    const scope = (): string | null | undefined => document.querySelector("[data-scope]")?.getAttribute("data-scope");
    expect(scope()).toBe("late");
    act(() => writeListPrefs(window.localStorage, PLAN, { ...FULL, scope: "done" }));
    expect(scope()).toBe("done");
    window.localStorage.setItem(listKey(PLAN), "{");
    view.rerender(
      <>
        <Toasts />
        <Probe />
      </>,
    );
    expect(window.localStorage.getItem(listKey(PLAN))).toBeNull();
    expect(toastTexts()).toEqual([LIST_PREFS_UNREADABLE]);
    expect(scope()).toBe("open");
  });
});
