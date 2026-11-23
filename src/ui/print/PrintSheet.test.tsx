import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { toDay } from "../../domain/dates";
import type { PlanSession } from "../../store/session";
import { fs, testSession, type SeedItem } from "../../test/session";
import { deviced } from "../../test/theme";
import { fitSpan } from "../timeline/geometry";
import { PrintSheet } from "./PrintSheet";

vi.mock("@tauri-apps/api/core", () => import("../../test/tauriMock"));

const sessions: PlanSession[] = [];

afterEach(async () => {
  cleanup();
  await Promise.all(sessions.splice(0).map((s) => s.close()));
});

const SEED: readonly SeedItem[] = [
  { id: "g1", name: "Kitchen", kind: "group" },
  { id: "a", name: "Fit", parent: "g1", start: "2026-11-10", dur: 3, status: "done", progress: 100 },
  { id: "b", name: "Tile", parent: "g1", start: "2026-11-16", dur: 2, deps: [fs("a", 1)] },
  { id: "m", name: "Gate", kind: "milestone", start: "2026-11-20", deps: [fs("b")] },
  { id: "u", name: "Later" },
];

const made = async (today = "2026-11-09") => {
  const t = await testSession(SEED, { today });
  sessions.push(t.session);
  return t;
};

const sheet = (): HTMLElement => {
  const el = document.body.querySelector(".print-sheet");
  if (!(el instanceof HTMLElement)) throw new Error("no print sheet");
  return el;
};

const row = (id: string): HTMLElement => {
  const el = sheet().querySelector(`[data-prow="${id}"]`);
  if (!(el instanceof HTMLElement)) throw new Error("no print row " + id);
  return el;
};

const cells = (id: string): string[] => Array.from(row(id).querySelectorAll("td")).map((td) => td.textContent ?? "");

describe("PrintSheet (product-8)", () => {
  it("renders into the body, outside the app root, with the plan name, its date range and the print day", async () => {
    const t = await made();
    const { container } = render(deviced(<PrintSheet view={t.session.view()} onDone={() => undefined} />));
    expect(container.querySelector(".print-sheet")).toBeNull();
    expect(sheet().parentElement).toBe(document.body);
    expect(sheet().querySelector("h1")?.textContent).toBe(t.session.view().plan.name);
    expect(sheet().querySelector(".print-sub")?.textContent).toBe("10 Nov → 20 Nov · printed 9 Nov");
  });

  it("counts conflicts in the heading when there are some", async () => {
    const t = await made();
    t.session.apply({ t: "schedule", item: "b", set: { start: "2026-11-11" } });
    render(deviced(<PrintSheet view={t.session.view()} onDone={() => undefined} />));
    expect(sheet().querySelector(".print-sub")?.textContent).toBe("10 Nov → 20 Nov · printed 9 Nov · 1 conflict");
  });

  it("prints one row per item with its columns, groups bold, milestones with a diamond and unscheduled rows bare", async () => {
    const t = await made();
    render(deviced(<PrintSheet view={t.session.view()} onDone={() => undefined} />));
    expect(Array.from(sheet().querySelectorAll("tbody tr")).map((r) => r.getAttribute("data-prow"))).toEqual(["g1", "a", "b", "m", "u"]);
    expect(Array.from(sheet().querySelectorAll("thead th")).map((th) => th.textContent).slice(0, 6)).toEqual(["Item", "Start", "End", "Days", "Status", "Depends on"]);
    expect(row("g1").classList.contains("print-group")).toBe(true);
    expect(cells("a").slice(0, 6)).toEqual(["Fit", "10 Nov", "12 Nov", "3", "done", ""]);
    expect(cells("b").slice(0, 6)).toEqual(["Tile", "16 Nov", "17 Nov", "2", "not started", "Fit FS+1d"]);
    expect(cells("m").slice(0, 6)).toEqual(["◆ Gate", "20 Nov", "", "", "not started", "Tile FS"]);
    expect(cells("u").slice(0, 6)).toEqual(["Later", "", "", "3", "not started", ""]);
    expect(row("u").querySelector(".print-bar, .print-ms")).toBeNull();
    const indent = (id: string): string => {
      const el = row(id).querySelector(".print-name");
      if (!(el instanceof HTMLElement)) throw new Error("no name in " + id);
      return el.style.paddingLeft;
    };
    expect([indent("g1"), indent("a")]).toEqual(["0mm", "4mm"]);
  });

  it("draws a done task's bar lighter even when its incoming link does not hold", async () => {
    const t = await made();
    t.session.apply({ t: "schedule", item: "b", set: { start: "2026-11-11", status: "done" } });
    render(deviced(<PrintSheet view={t.session.view()} onDone={() => undefined} />));
    expect(cells("b")[4]).toBe("conflict");
    expect(row("b").querySelector(".print-bar")?.classList.contains("done")).toBe(true);
  });

  it("places bars by percent of the fit span, the group thin, the done bar lighter", async () => {
    const t = await made();
    const view = t.session.view();
    render(deviced(<PrintSheet view={view} onDone={() => undefined} />));
    const { first, last } = fitSpan(view);
    const days = last - first + 1;
    const at = (iso: string): string => `${((toDay(iso) - first) / days) * 100}%`;
    const bar = (id: string): HTMLElement => {
      const el = row(id).querySelector(".print-bar, .print-ms");
      if (!(el instanceof HTMLElement)) throw new Error("no bar in " + id);
      return el;
    };
    expect([bar("b").style.left, bar("b").style.width]).toEqual([at("2026-11-16"), `${(2 / days) * 100}%`]);
    expect(bar("a").classList.contains("done")).toBe(true);
    expect(bar("b").classList.contains("done")).toBe(false);
    expect(bar("g1").classList.contains("group")).toBe(true);
    expect([bar("m").classList.contains("print-ms"), bar("m").style.left]).toEqual([true, at("2026-11-20")]);
    expect(Array.from(sheet().querySelectorAll("thead .print-tick")).map((x) => x.textContent)).toEqual(["9 Nov 2026", "16 Nov", "23 Nov"]);
  });

  it("draws the today line only when today is inside the span", async () => {
    const t = await made();
    render(deviced(<PrintSheet view={t.session.view()} onDone={() => undefined} />));
    expect(sheet().querySelectorAll("tbody .print-today")).toHaveLength(5);
    cleanup();
    const far = await made("2027-06-01");
    render(deviced(<PrintSheet view={far.session.view()} onDone={() => undefined} />));
    expect(sheet().querySelectorAll(".print-today")).toHaveLength(0);
  });

  it("ends printing on afterprint and stops listening once unmounted", async () => {
    const t = await made();
    const onDone = vi.fn();
    const { unmount } = render(deviced(<PrintSheet view={t.session.view()} onDone={onDone} />));
    act(() => {
      window.dispatchEvent(new Event("afterprint"));
    });
    expect(onDone).toHaveBeenCalledTimes(1);
    unmount();
    window.dispatchEvent(new Event("afterprint"));
    expect(onDone).toHaveBeenCalledTimes(1);
  });
});
