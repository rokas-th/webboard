import { describe, expect, it } from "vitest";
import type { PickSection } from "../common/ContextMenu";
import { headMenu, runHeadRow } from "./headMenu";
import { DEFAULT_LIST_PREFS, type ColumnId, type ListPrefs, type SortKey } from "./prefs";

const withSort = (sort: SortKey[]): ListPrefs => ({ ...DEFAULT_LIST_PREFS, sort });

const lines = (sections: readonly PickSection[]): string[][] => sections.map((s) => s.rows.map((r) => `${r.id}|${r.title}${r.checked ? " ✓" : ""}${r.checkable ? " ☐" : ""}`));

const titles = (p: ListPrefs, id: ColumnId): string[] => headMenu(p, id).flatMap((s) => s.rows.map((r) => r.title));

describe("headMenu", () => {
  it("offers the sort directions, Hide, Size to fit, Columns… and Reset columns without a sort", () => {
    const sections = headMenu(DEFAULT_LIST_PREFS, "start");
    expect(sections.map((s) => s.title)).toEqual([null, null, null]);
    expect(lines(sections)).toEqual([
      ["asc|Sort ascending ☐", "desc|Sort descending ☐"],
      ["hide|Hide column", "fit|Size to fit"],
      ["columns|Columns…", "reset|Reset columns"],
    ]);
  });

  it("checks the primary key's direction and offers a second key on another column", () => {
    expect(lines(headMenu(withSort([{ id: "start", dir: "desc" }]), "start"))[0]).toEqual(["asc|Sort ascending ☐", "desc|Sort descending ✓ ☐", "unsort|Remove from sort"]);
    expect(lines(headMenu(withSort([{ id: "start", dir: "asc" }]), "end"))[0]).toEqual(["asc|Sort ascending ☐", "desc|Sort descending ☐", "second|Add as second sort key"]);
  });

  it("offers a third key with two keys, and only removal on a column that sorts second", () => {
    const two = withSort([
      { id: "start", dir: "asc" },
      { id: "end", dir: "desc" },
    ]);
    expect(lines(headMenu(two, "status"))[0]).toEqual(["asc|Sort ascending ☐", "desc|Sort descending ☐", "third|Add as third sort key"]);
    expect(lines(headMenu(two, "end"))[0]).toEqual(["asc|Sort ascending ☐", "desc|Sort descending ☐", "unsort|Remove from sort"]);
  });

  it("offers no further key with three keys", () => {
    const three = withSort([
      { id: "start", dir: "asc" },
      { id: "end", dir: "desc" },
      { id: "step", dir: "asc" },
    ]);
    expect(lines(headMenu(three, "status"))[0]).toEqual(["asc|Sort ascending ☐", "desc|Sort descending ☐"]);
    expect(lines(headMenu(three, "step"))[0]).toEqual(["asc|Sort ascending ☐", "desc|Sort descending ☐", "unsort|Remove from sort"]);
  });

  it("offers no Hide on Name", () => {
    expect(titles(DEFAULT_LIST_PREFS, "name")).not.toContain("Hide column");
    expect(lines(headMenu(DEFAULT_LIST_PREFS, "name"))[1]).toEqual(["fit|Size to fit"]);
  });
});

describe("runHeadRow", () => {
  const one = withSort([{ id: "start", dir: "asc" }]);

  it("sorts ascending or descending by the column alone", () => {
    expect(runHeadRow(one, "end", "desc")).toEqual({ prefs: withSort([{ id: "end", dir: "desc" }]) });
    expect(runHeadRow(one, "end", "asc")).toEqual({ prefs: withSort([{ id: "end", dir: "asc" }]) });
  });

  it("adds a second and a third key, and removes a key", () => {
    expect(runHeadRow(one, "end", "second")).toEqual({
      prefs: withSort([
        { id: "start", dir: "asc" },
        { id: "end", dir: "asc" },
      ]),
    });
    const two = withSort([
      { id: "start", dir: "asc" },
      { id: "end", dir: "asc" },
    ]);
    expect(runHeadRow(two, "step", "third")).toEqual({ prefs: withSort([...two.sort, { id: "step", dir: "asc" }]) });
    expect(runHeadRow(two, "start", "unsort")).toEqual({ prefs: withSort([{ id: "end", dir: "asc" }]) });
  });

  it("hides the column with its key", () => {
    const r = runHeadRow(one, "start", "hide");
    expect(r).toEqual({ prefs: { ...DEFAULT_LIST_PREFS, cols: DEFAULT_LIST_PREFS.cols.filter((c) => c.id !== "start"), sort: [] } });
  });

  it("asks for a fit and for the Columns popover", () => {
    expect(runHeadRow(one, "start", "fit")).toEqual({ fit: true });
    expect(runHeadRow(one, "start", "columns")).toEqual({ columns: true });
  });

  it("resets the columns", () => {
    const wide: ListPrefs = { ...one, cols: [{ id: "name", w: 500 }, { id: "start", w: 100 }] };
    expect(runHeadRow(wide, "start", "reset")).toEqual({ prefs: { ...one, cols: DEFAULT_LIST_PREFS.cols } });
  });

  it("throws for an unknown row", () => {
    expect(() => runHeadRow(one, "start", "nope")).toThrow('List: the header menu has no row "nope"');
  });
});
