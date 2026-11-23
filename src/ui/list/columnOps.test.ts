import { act, cleanup, render } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { clearToasts, Toasts } from "../common/Toast";
import { addSortKey, dropIndex, fitWidth, hideColumn, moveColumn, removeSortKey, resetColumns, resizeColumn, setSort, showColumn } from "./columnOps";
import { DEFAULT_LIST_PREFS, MAX_WIDTH, readListPrefs, writeListPrefs, type ColumnId, type ListPrefs } from "./prefs";
import { SORT_LIMIT } from "./text";

const PLAN = "planMesa001";

afterEach(() => {
  cleanup();
  clearToasts();
  window.localStorage.clear();
});

const ids = (p: ListPrefs): ColumnId[] => p.cols.map((c) => c.id);

const BASE: ListPrefs = DEFAULT_LIST_PREFS;

describe("moveColumn", () => {
  it("inserts a column before the column at the index, or at the end", () => {
    expect(ids(moveColumn(BASE, "status", 1))).toEqual(["name", "status", "step", "assignees", "start", "end"]);
    expect(ids(moveColumn(BASE, "step", 6))).toEqual(["name", "assignees", "start", "end", "status", "step"]);
    expect(ids(moveColumn(BASE, "start", 2))).toEqual(["name", "step", "start", "assignees", "end", "status"]);
    expect(ids(moveColumn(BASE, "step", 4))).toEqual(["name", "assignees", "start", "step", "end", "status"]);
  });

  it("leaves the order alone for the column's own place and the one after it", () => {
    expect(ids(moveColumn(BASE, "start", 3))).toEqual(ids(BASE));
    expect(ids(moveColumn(BASE, "start", 4))).toEqual(ids(BASE));
  });

  it("keeps the widths with their columns", () => {
    const p = resizeColumn(BASE, "end", 120);
    expect(moveColumn(p, "end", 1).cols[1]).toEqual({ id: "end", w: 120 });
  });

  it("throws for Name, an absent column and an index outside 1 to the column count", () => {
    expect(() => moveColumn(BASE, "name", 3)).toThrow("List: Name stays the first column");
    expect(() => moveColumn(BASE, "note", 2)).toThrow("List: note is not a shown column");
    expect(() => moveColumn(BASE, "step", 0)).toThrow("List: 0 is not an insertion index from 1 to 6");
    expect(() => moveColumn(BASE, "step", 7)).toThrow("List: 7 is not an insertion index from 1 to 6");
  });
});

describe("resizeColumn", () => {
  it("rounds and clamps to the column's minimum and the maximum width", () => {
    expect(resizeColumn(BASE, "start", 100.6).cols[3]).toEqual({ id: "start", w: 101 });
    expect(resizeColumn(BASE, "start", 10).cols[3]).toEqual({ id: "start", w: 72 });
    expect(resizeColumn(BASE, "start", 5000).cols[3]).toEqual({ id: "start", w: MAX_WIDTH });
  });

  it("throws for an absent column", () => {
    expect(() => resizeColumn(BASE, "note", 200)).toThrow("List: note is not a shown column");
  });
});

describe("hideColumn and showColumn", () => {
  it("hides a column and drops its sort key", () => {
    const p = hideColumn({ ...BASE, sort: [{ id: "start", dir: "desc" }, { id: "name", dir: "asc" }] }, "start");
    expect(ids(p)).toEqual(["name", "step", "assignees", "end", "status"]);
    expect(p.sort).toEqual([{ id: "name", dir: "asc" }]);
  });

  it("refuses to hide Name or a hidden column", () => {
    expect(() => hideColumn(BASE, "name")).toThrow("List: Name cannot be hidden");
    expect(() => hideColumn(BASE, "note")).toThrow("List: note is not a shown column");
  });

  it("shows a column at the end at its default width, and refuses a shown one", () => {
    expect(showColumn(BASE, "note").cols[6]).toEqual({ id: "note", w: 240 });
    expect(() => showColumn(BASE, "start")).toThrow("List: start is already shown");
  });
});

describe("resetColumns", () => {
  it("restores the default columns and keeps only the sort keys still shown", () => {
    const p: ListPrefs = { ...BASE, cols: [{ id: "name", w: 400 }, { id: "note", w: 300 }, { id: "end", w: 100 }], sort: [{ id: "note", dir: "asc" }, { id: "end", dir: "desc" }], scope: "all" };
    const r = resetColumns(p);
    expect(r.cols).toEqual(DEFAULT_LIST_PREFS.cols);
    expect(r.sort).toEqual([{ id: "end", dir: "desc" }]);
    expect(r.scope).toBe("all");
  });
});

describe("fitWidth", () => {
  it("rounds the widest up and clamps it to the minimum and the maximum", () => {
    expect(fitWidth(120, [80.2, 150.1, 99])).toBe(151);
    expect(fitWidth(120, [30, 40])).toBe(120);
    expect(fitWidth(120, [900])).toBe(MAX_WIDTH);
  });

  it("throws without a width to fit", () => {
    expect(() => fitWidth(120, [])).toThrow("List: nothing to fit");
  });
});

describe("dropIndex", () => {
  it("counts the midpoints left of the pointer, from 1 to the column count", () => {
    const mids = [400, 500, 600, 700, 800];
    expect(dropIndex(mids, 10)).toBe(1);
    expect(dropIndex(mids, 400)).toBe(1);
    expect(dropIndex(mids, 401)).toBe(2);
    expect(dropIndex(mids, 650)).toBe(4);
    expect(dropIndex(mids, 5000)).toBe(6);
    expect(dropIndex([], 5000)).toBe(1);
  });
});

describe("sort keys", () => {
  it("sets one key in a direction", () => {
    expect(setSort({ ...BASE, sort: [{ id: "end", dir: "asc" }, { id: "start", dir: "asc" }] }, "start", "desc").sort).toEqual([{ id: "start", dir: "desc" }]);
  });

  it("adds a key ascending at the end, and refuses one already there", () => {
    expect(addSortKey({ ...BASE, sort: [{ id: "end", dir: "desc" }] }, "start").sort).toEqual([
      { id: "end", dir: "desc" },
      { id: "start", dir: "asc" },
    ]);
    expect(() => addSortKey({ ...BASE, sort: [{ id: "end", dir: "desc" }] }, "end")).toThrow("List: end already sorts");
    expect(() => addSortKey(BASE, "note")).toThrow("List: note is not a shown column");
  });

  it("removes a key and refuses one not there", () => {
    expect(removeSortKey({ ...BASE, sort: [{ id: "end", dir: "desc" }, { id: "start", dir: "asc" }] }, "end").sort).toEqual([{ id: "start", dir: "asc" }]);
    expect(() => removeSortKey(BASE, "end")).toThrow("List: end does not sort");
  });

  it("toasts for a fourth key and keeps the three", () => {
    const three: ListPrefs = {
      ...BASE,
      sort: [
        { id: "end", dir: "desc" },
        { id: "start", dir: "asc" },
        { id: "step", dir: "asc" },
      ],
    };
    render(createElement(Toasts));
    writeListPrefs(window.localStorage, PLAN, three);
    act(() => {
      writeListPrefs(window.localStorage, PLAN, addSortKey(three, "status"));
    });
    expect(Array.from(document.querySelectorAll<HTMLElement>(".toasts .toast")).map((e) => e.textContent)).toEqual([SORT_LIMIT]);
    expect(readListPrefs(window.localStorage, PLAN).sort).toEqual(three.sort);
  });
});
