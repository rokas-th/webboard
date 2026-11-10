import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PlanSession } from "../../store/session";
import { testSession, fs, type SeedItem, type TestSession } from "../../test/session";
import { PhoneList } from "./PhoneList";

vi.mock("@tauri-apps/api/core", () => import("../../test/tauriMock"));

const sessions: PlanSession[] = [];

afterEach(async () => {
  cleanup();
  await Promise.all(sessions.splice(0).map((s) => s.close()));
});

const made = async (...a: Parameters<typeof testSession>): Promise<TestSession> => {
  const t = await testSession(...a);
  sessions.push(t.session);
  return t;
};

const SPRINT: readonly SeedItem[] = [
  { id: "S4", name: "Sprint 4", kind: "group" },
  { name: "Review", parent: "S4", start: "2026-11-10" },
  { name: "Ship", parent: "S4", start: "2026-12-14" },
  { name: "Old", parent: "S4", start: "2026-11-02", status: "done", progress: 100 },
  { name: "Idea", parent: "S4", status: "done", progress: 100 },
  { name: "QA", kind: "group", parent: "S4" },
  { name: "Test", parent: "QA", start: "2026-11-12" },
  { name: "Notes", start: "2026-11-11" },
];

const CLASH = [{ unit: "s:Review", mac: ["2026-11-10", 2, "todo", 0, "now"], iphone: ["2026-11-12", 2, "todo", 0, "now"] }];

const tab = (name: string): HTMLElement => screen.getByRole("tab", { name });

const sections = (): [string, string[]][] =>
  [...document.querySelectorAll(".psec")].map((s) => [
    s.querySelector(".psec-title")?.textContent ?? "",
    [...s.querySelectorAll(".prow-name")].map((n) => n.textContent ?? ""),
  ]);

const row = (name: string): HTMLElement => {
  const hit = [...document.querySelectorAll<HTMLElement>(".prow")].find((r) => r.querySelector(".prow-name")?.textContent === name);
  if (hit === undefined) throw new Error("no row " + name);
  return hit;
};

const dims = (): string[] => [...document.querySelectorAll('.phone-list [role="tabpanel"] > p.dim')].map((p) => p.textContent ?? "");

describe("PhoneList", () => {
  it("each horizon tab controls the list panel, which the selected tab labels", async () => {
    const t = await made(SPRINT, { clashes: CLASH });
    render(<PhoneList session={t.session} onOpen={vi.fn()} />);
    const panel = screen.getByRole("tabpanel", { name: "Now" });
    expect(["All", "Now", "Next", "Later"].map((n) => tab(n).getAttribute("aria-controls"))).toEqual(["All", "Now", "Next", "Later"].map(() => panel.id));
    expect(panel.querySelectorAll(".psec").length).toBeGreaterThan(0);
    fireEvent.click(tab("Next"));
    expect(screen.getByRole("tabpanel", { name: "Next" }).getAttribute("aria-labelledby")).toBe(tab("Next").id);
  });

  it("starts on Now and shows each horizon in tree order", async () => {
    const t = await made(SPRINT, { clashes: CLASH });
    const onOpen = vi.fn();
    render(<PhoneList session={t.session} onOpen={onOpen} />);
    expect(["All", "Now", "Next", "Later"].map((n) => tab(n).getAttribute("aria-selected"))).toEqual(["false", "true", "false", "false"]);
    expect(sections()).toEqual([
      ["Sprint 4", ["Review"]],
      ["Sprint 4 › QA", ["Test"]],
      ["Not in a group", ["Notes"]],
    ]);
    expect(row("Review").querySelector(".held")).not.toBeNull();
    fireEvent.click(tab("Next"));
    expect(sections()).toEqual([["Sprint 4", ["Ship"]]]);
    fireEvent.click(tab("Later"));
    expect(sections()).toEqual([]);
    expect(document.querySelectorAll(".prow-name")).toHaveLength(0);
  });

  it("lists every untrashed item under All, done ones included, and opens them", async () => {
    const t = await made(SPRINT, { clashes: CLASH });
    const onOpen = vi.fn();
    render(<PhoneList session={t.session} onOpen={onOpen} />);
    fireEvent.click(tab("All"));
    expect(sections()).toEqual([
      ["Sprint 4", ["Review", "Ship", "Old", "Idea"]],
      ["Sprint 4 › QA", ["Test"]],
      ["Not in a group", ["Notes"]],
    ]);
    fireEvent.click(row("Old"));
    expect(onOpen.mock.calls).toEqual([["Old"]]);
    fireEvent.click(screen.getByRole("button", { name: "Sprint 4 › QA" }));
    expect(onOpen.mock.calls).toEqual([["Old"], ["QA"]]);
    expect(screen.queryByRole("button", { name: "Not in a group" })).toBeNull();
  });

  it("empty plan: one dim line under every bucket", async () => {
    const t = await made([]);
    render(<PhoneList session={t.session} onOpen={vi.fn()} />);
    ["Now", "Next", "Later", "All"].forEach((b) => {
      fireEvent.click(tab(b));
      expect([b, dims(), sections()]).toEqual([b, ["No items yet. Add one with +."], []]);
    });
  });

  it("empty bucket: names the next bucket that has items", async () => {
    const t = await made([
      { name: "A", start: "2026-12-14" },
      { name: "B", start: "2026-12-21" },
      { name: "C", start: "2026-12-28" },
    ]);
    render(<PhoneList session={t.session} onOpen={vi.fn()} />);
    expect(dims()).toEqual(["Nothing in Now. 3 items in Next."]);
    expect(sections()).toEqual([]);
    fireEvent.click(tab("Later"));
    expect(dims()).toEqual(["Nothing in Later. 3 items in Next."]);
    fireEvent.click(tab("Next"));
    expect(dims()).toEqual([]);
  });

  it("empty bucket: one item reads 1 item, and All counts when no horizon has items", async () => {
    const one = await made([{ name: "A", start: "2026-12-14" }]);
    render(<PhoneList session={one.session} onOpen={vi.fn()} />);
    expect(dims()).toEqual(["Nothing in Now. 1 item in Next."]);
    cleanup();
    const done = await made([{ name: "D", start: "2026-11-02", status: "done", progress: 100 }]);
    render(<PhoneList session={done.session} onOpen={vi.fn()} />);
    expect(dims()).toEqual(["Nothing in Now. 1 item in All."]);
  });

  it("empty group: its header renders alone under All and opens the group", async () => {
    const t = await made([...SPRINT, { name: "Empty", kind: "group" }], { clashes: CLASH });
    const onOpen = vi.fn();
    render(<PhoneList session={t.session} onOpen={onOpen} />);
    expect(sections().map(([n]) => n)).not.toContain("Empty");
    fireEvent.click(tab("All"));
    expect(sections()).toContainEqual(["Empty", []]);
    fireEvent.click(screen.getByRole("button", { name: "Empty" }));
    expect(onOpen.mock.calls).toEqual([["Empty"]]);
  });

  it("ghost rows: a trashed item of an open delete choice lists only under All", async () => {
    const t = await made(SPRINT, { clashes: CLASH });
    const peer = await t.peer("iphone");
    sessions.push(peer.session);
    t.session.apply({ t: "trash", items: ["Notes"] });
    peer.session.apply({ t: "move", items: ["Notes"], days: 1 });
    peer.sync();
    expect(t.session.view().choices.filter((c) => c.kind === "delete")).toHaveLength(1);
    const onOpen = vi.fn();
    render(<PhoneList session={t.session} onOpen={onOpen} />);
    expect(sections()).toEqual([
      ["Sprint 4", ["Review"]],
      ["Sprint 4 › QA", ["Test"]],
    ]);
    fireEvent.click(tab("All"));
    expect(row("Notes").classList.contains("ghost-row")).toBe(true);
    expect(row("Notes").querySelector(".prow-start")).toBeNull();
    expect(row("Test").querySelector(".prow-start")?.textContent).toBe("12 Nov");
    fireEvent.click(row("Notes"));
    expect(onOpen.mock.calls).toEqual([["Notes"]]);
  });

  it("day off marker", async () => {
    const t = await made([...SPRINT, { name: "Sat", start: "2026-11-14", dur: 1 }], { clashes: CLASH });
    render(<PhoneList session={t.session} onOpen={vi.fn()} />);
    expect(row("Sat").classList.contains("dayoff")).toBe(true);
    expect(row("Review").classList.contains("dayoff")).toBe(false);
  });

  it("row status: start and one status label", async () => {
    const t = await made([
      { name: "L", start: "2026-11-02", dur: 2 },
      { name: "P", start: "2026-11-16", dur: 3 },
      { name: "E", start: "2026-11-17", dur: 1, deps: [fs("P")] },
      { name: "D", start: "2026-11-02", dur: 1, status: "done", progress: 100 },
    ]);
    render(<PhoneList session={t.session} onOpen={vi.fn()} />);
    fireEvent.click(tab("All"));
    const read = (n: string): [string, string, string] => {
      const r = row(n);
      const st = r.querySelector(".st");
      if (st === null) throw new Error("no status on " + n);
      return [r.querySelector(".prow-start")?.textContent ?? "", st.textContent ?? "", st.className];
    };
    expect(read("L")).toEqual(["2 Nov", "late", "st late"]);
    expect(read("E")).toEqual(["17 Nov", "conflict", "st conflict"]);
    expect(read("P")).toEqual(["16 Nov", "not started", "st"]);
    expect(read("D")).toEqual(["2 Nov", "done", "st dim"]);
  });

  it("re-renders when the plan changes", async () => {
    const t = await made(SPRINT, { clashes: CLASH });
    render(<PhoneList session={t.session} onOpen={vi.fn()} />);
    act(() => {
      t.session.apply({ t: "move", items: ["Ship"], days: -20 });
    });
    expect(sections()[0]).toEqual(["Sprint 4", ["Review", "Ship"]]);
  });
});
