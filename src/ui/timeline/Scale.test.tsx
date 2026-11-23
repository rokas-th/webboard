import { render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { toDay, weekday, type WeekStart } from "../../domain/dates";
import type { PlanSession } from "../../store/session";
import { testSession } from "../../test/session";
import { geometry } from "./geometry";
import { isoWeek, Scale } from "./Scale";

vi.mock("@tauri-apps/api/core", () => import("../../test/tauriMock"));

const sessions: PlanSession[] = [];

afterEach(async () => {
  await Promise.all(sessions.splice(0).map((s) => s.close()));
});

const ticksOf = async (week: WeekStart): Promise<{ day: string | undefined; text: string | null }[]> => {
  const t = await testSession([{ name: "A", start: "2027-03-17", dur: 3 }], { today: "2027-03-10" });
  sessions.push(t.session);
  const geo = geometry(t.session.view(), "M", week);
  const { container, unmount } = render(<Scale geo={geo} today={toDay("2027-03-10")} missing={[]} onHide={null} />);
  const ticks = Array.from(container.querySelectorAll<HTMLElement>(".tl-tick")).map((e) => ({ day: e.dataset.day, text: e.textContent }));
  unmount();
  return ticks;
};

describe("Scale week ticks", () => {
  it("a Monday week ticks on Mondays with their ISO week", async () => {
    const ticks = await ticksOf(1);
    expect(ticks.slice(0, 3)).toEqual([
      { day: "2027-03-01", text: "W9 · 1" },
      { day: "2027-03-08", text: "W10 · 8" },
      { day: "2027-03-15", text: "W11 · 15" },
    ]);
  });

  it("a Sunday week starts on Sunday and keeps the ISO number of its Monday", async () => {
    const ticks = await ticksOf(7);
    expect(ticks.every((x) => x.day !== undefined && weekday(toDay(x.day)) === 7)).toBe(true);
    expect(ticks.slice(0, 3)).toEqual([
      { day: "2027-02-28", text: "W9 · 28" },
      { day: "2027-03-07", text: "W10 · 7" },
      { day: "2027-03-14", text: "W11 · 14" },
    ]);
    expect(isoWeek(toDay("2027-03-15"))).toBe(11);
  });
});
