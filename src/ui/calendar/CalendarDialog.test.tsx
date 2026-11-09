import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Refused, type Built, type Intent } from "../../actions/intents";
import type { Calendar, Closure, HolidayYear, RegionRef } from "../../domain/calendar";
import type { Registry } from "../../store/registry";
import { fixedClock, type Clock } from "../../services/clock";
import type { HolidayNotice } from "../../services/holidays";
import { AppError } from "../../services/ipc";
import { Registry as RealRegistry } from "../../store/registry";
import type { PlanSession } from "../../store/session";
import { CH_ZH, CH_ZH_2026, holidayDay, holidayYear } from "../../test/fixtures/calendars";
import { fs, testSession, type SeedItem, type TestSession, type TestSessionOpts } from "../../test/session";
import { emptyYear, seededStore, testRegistry } from "../../test/shell";
import { tauri, type Answer } from "../../test/tauriMock";
import { clearToasts } from "../common/Toast";
import { Shell } from "../shell/Shell";
import { useUi, type UiState } from "../state";
import { impactText } from "./impact";

vi.mock("@tauri-apps/api/core", () => import("../../test/tauriMock"));
vi.mock("../state", async (importOriginal) => {
  const m = await importOriginal<typeof import("../state")>();
  return { ...m, useUi: vi.fn(m.useUi) };
});

const ZH: RegionRef = { src: "openholidays", country: "CH", subdivision: "CH-ZH" };
const NOT_LOADED = (y: number): string => `${y} · not loaded — dates use weekdays and closures`;
const CLOSE = "Done items keep their dates, and nothing moves earlier on its own.";
const NONE = "Applying changes no dates in this plan.";

const COUNTRIES = [
  { code: "AT", name: "Austria", src: "openholidays" },
  { code: "CH", name: "Switzerland", src: "openholidays" },
  { code: "GB", name: "United Kingdom", src: "govuk" },
  { code: "US", name: "United States (federal)", src: "opm" },
];

const CH_SUBS = [
  { code: "CH-BE", name: "Bern", children: [] },
  { code: "CH-ZH", name: "Zürich", children: [{ code: "CH-ZH-ZH-ZH", name: "Municipality of Zürich", children: [] }] },
];

const pending: Answer = () => new Promise(() => undefined);

const REGION_ANSWERS: Record<string, Answer> = {
  holidays_countries: () => COUNTRIES,
  holidays_subdivisions: (args) => {
    const country = args !== undefined && !(args instanceof Uint8Array) && !(args instanceof ArrayBuffer) && !Array.isArray(args) ? args.country : undefined;
    return country === "CH" ? CH_SUBS : [];
  },
  holidays_year: emptyYear,
};

const sessions: PlanSession[] = [];
const registries: RealRegistry[] = [];

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(async () => {
  cleanup();
  clearToasts();
  vi.restoreAllMocks();
  vi.mocked(useUi).mockClear();
  await Promise.all(sessions.splice(0).map((s) => s.close()));
  await Promise.all(registries.splice(0).map((r) => r.close()));
  window.localStorage.clear();
});

const settle = async (): Promise<void> => {
  await act(async () => {
    await new Promise<void>((r) => setTimeout(r, 0));
    await new Promise<void>((r) => setTimeout(r, 0));
    await new Promise<void>((r) => setTimeout(r, 0));
  });
};

const lastUi = (): UiState => {
  const results = vi.mocked(useUi).mock.results;
  const r = results[results.length - 1];
  if (r === undefined || r.type !== "return") throw new Error("useUi has not returned");
  return r.value[0];
};

const made = async (seed: readonly SeedItem[], opts: TestSessionOpts = {}): Promise<TestSession> => {
  const t = await testSession(seed, { ...opts, answers: { ...REGION_ANSWERS, ...opts.answers } });
  sessions.push(t.session);
  return t;
};

const shown = async (t: TestSession, over: Partial<Registry> = {}, clock: Clock = t.clock): Promise<Registry> => {
  const registry = testRegistry(t, { setLastRegion: vi.fn(async () => undefined), ...over });
  render(<Shell registry={registry} clock={clock} />);
  await settle();
  return registry;
};

const panelSlot = (): HTMLElement => {
  const el = document.querySelector('[data-slot="panel"]');
  if (!(el instanceof HTMLElement)) throw new Error("no panel");
  return el;
};

const head = (): HTMLElement => {
  const el = document.querySelector(".plan-head");
  if (!(el instanceof HTMLElement)) throw new Error("no plan head");
  return el;
};

const dialog = (): HTMLElement => screen.getByRole("dialog", { name: "Calendar · Plan" });

const openDialog = async (): Promise<HTMLElement> => {
  fireEvent.click(within(panelSlot()).getByRole("button", { name: "Change calendar…" }));
  await settle();
  return dialog();
};

const inDialog = () => within(dialog());

const select = (label: string): HTMLSelectElement => {
  const el = inDialog().getByRole("combobox", { name: label });
  if (!(el instanceof HTMLSelectElement)) throw new Error(`${label} is not a select`);
  return el;
};

const choose = async (label: string, value: string): Promise<void> => {
  fireEvent.change(select(label), { target: { value } });
  await settle();
};

const options = (label: string): string[] => [...select(label).options].map((o) => o.textContent ?? "");

const field = (label: string): HTMLInputElement => {
  const el = inDialog().getByLabelText(label);
  if (!(el instanceof HTMLInputElement)) throw new Error(`${label} is not an input`);
  return el;
};

const type = (label: string, value: string): void => {
  fireEvent.change(field(label), { target: { value } });
};

const applyButton = (): HTMLButtonElement => {
  const b = inDialog().getByRole("button", { name: "Apply" });
  if (!(b instanceof HTMLButtonElement)) throw new Error("Apply is not a button");
  return b;
};

const clickApply = async (): Promise<void> => {
  fireEvent.click(applyButton());
  await settle();
};

const toastTexts = (): (string | null)[] => screen.queryAllByRole("status").map((e) => e.textContent);

const toastNodes = (): HTMLElement[] => screen.queryAllByRole("status");

const impact = (): string | null => dialog().querySelector(".impact")?.textContent ?? null;

const pickZurich = async (): Promise<void> => {
  await choose("Holiday source", "openholidays");
  await choose("Country", "CH");
  await choose("Subdivision", "CH-ZH");
};

const dayRow = (name: string): HTMLElement => {
  const list = inDialog().getByRole("list", { name: "Days off and holidays" });
  const found = [...list.querySelectorAll("li")].find((li) => li.querySelector(".day-name")?.textContent === name);
  if (found === undefined) throw new Error(`no day row ${name}`);
  return found;
};

const missingRow = (y: number): HTMLElement => {
  const el = inDialog().getByText(NOT_LOADED(y)).closest("li");
  if (el === null) throw new Error(`no missing row ${y}`);
  return el;
};

const IMPACT_SEED: readonly SeedItem[] = [
  { id: "A", name: "A", start: "2026-11-16", dur: 3 },
  { id: "B", name: "B", start: "2026-11-19", dur: 2, deps: [fs("A")] },
];

const zhPlan = (o: Partial<Calendar> = {}): Partial<Calendar> => ({ ...CH_ZH, ...o });

const reviewIntent = (t: TestSession, year: number, y: HolidayYear): Extract<Intent, { t: "calendar" }> & { base: Calendar } => {
  const base = t.session.view().plan.calendar;
  return { t: "calendar", next: { ...base, holidays: new Map([...base.holidays, [year, y]]) }, base };
};

describe("region sources", () => {
  it("offers OpenHolidays countries then nested subdivisions, GOV.UK divisions, OPM and a calendar link", async () => {
    const t = await made([]);
    await shown(t);
    await openDialog();
    expect(options("Holiday source")).toEqual(["No holiday region", "OpenHolidays", "GOV.UK", "US federal (OPM)", "Calendar link (ICS)"]);
    expect(dialog().querySelector(".region-now")?.textContent).toBe("No holiday region");
    await choose("Holiday source", "openholidays");
    expect(options("Country")).toEqual(["Choose a country…", "Austria", "Switzerland"]);
    await choose("Country", "CH");
    expect(options("Subdivision")).toEqual(["Choose a region…", "Whole country", "Bern", "Zürich", "  Municipality of Zürich"]);
    expect(tauri.calls.filter((c) => c.cmd === "holidays_year")).toEqual([]);
    await choose("Subdivision", "CH-ZH");
    expect(inDialog().getByText("Region: CH-ZH")).toBeTruthy();
    expect(inDialog().getByText("Holiday data: OpenHolidays API (openholidaysapi.org), ODbL.")).toBeTruthy();
    await choose("Holiday source", "govuk");
    expect(options("Division")).toEqual(["Choose a division…", "England and Wales", "Scotland", "Northern Ireland"]);
    await choose("Division", "scotland");
    expect(inDialog().getByText("Region: Scotland")).toBeTruthy();
    expect(inDialog().queryByText("Holiday data: OpenHolidays API (openholidaysapi.org), ODbL.")).toBeNull();
    await choose("Holiday source", "opm");
    expect(inDialog().getByText("Region: US federal (OPM)")).toBeTruthy();
    await clickApply();
    expect(t.session.view().plan.calendar.region).toEqual({ src: "opm" });
  });

  it("shows an IPC error with its message and Try again", async () => {
    let offline = true;
    const t = await made([], {
      answers: {
        holidays_countries: () => {
          if (offline) throw { code: "holidays.offline", message: "No network connection." };
          return COUNTRIES;
        },
      },
    });
    await shown(t);
    await openDialog();
    await choose("Holiday source", "openholidays");
    expect(inDialog().getByText("No network connection.")).toBeTruthy();
    offline = false;
    fireEvent.click(inDialog().getByRole("button", { name: "Try again" }));
    await settle();
    expect(inDialog().queryByText("No network connection.")).toBeNull();
    expect(options("Country")).toEqual(["Choose a country…", "Austria", "Switzerland"]);
  });

  it.each([
    ["https://calendar.example.com/team.ics", true],
    ["https://calendar.google.com/calendar/ical/x/public/basic.ics", false],
    ["https://p12-caldav.icloud.com/holidays.ics", false],
  ])("loads a calendar link %s with its events ticked: %s, and ticks write tuning", async (url, ticked) => {
    const t = await made([], {
      answers: {
        holidays_ics_preview: () => [
          { date: "2026-12-24", name: "Office closed" },
          { date: "2026-12-31", name: "Year end" },
        ],
      },
    });
    await shown(t);
    await openDialog();
    await choose("Holiday source", "ics");
    type("Calendar link", url);
    type("Calendar name", "Company");
    fireEvent.click(inDialog().getByRole("button", { name: "Load" }));
    await settle();
    expect(tauri.calls.filter((c) => c.cmd === "holidays_ics_preview").map((c) => c.args)).toEqual([{ url }]);
    const events = inDialog().getByRole("list", { name: "Calendar events" });
    const boxes = within(events).getAllByRole("checkbox");
    expect(boxes.map((b) => (b instanceof HTMLInputElement ? b.checked : null))).toEqual([ticked, ticked]);
    expect(inDialog().getByText("Region: “Company”")).toBeTruthy();
    fireEvent.click(boxes[0]);
    await clickApply();
    const cal = t.session.view().plan.calendar;
    expect(cal.region).toEqual({ src: "ics", url, name: "Company" });
    expect(cal.tuning.get("2026-12-24")).toEqual(ticked ? { kind: "work" } : { kind: "off" });
    expect(cal.tuning.has("2026-12-31")).toBe(false);
  });
});

describe("weekdays, days off and closures", () => {
  it("toggles Mon … Sun and refuses to remove the last working day", async () => {
    const t = await made([], { calendar: { workdays: [1] } });
    await shown(t);
    await openDialog();
    const group = inDialog().getByRole("group", { name: "Working days" });
    expect(within(group).getAllByRole("button").map((b) => b.textContent)).toEqual(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]);
    fireEvent.click(within(group).getByRole("button", { name: "Mon" }));
    expect(toastNodes().map((n) => [n.textContent, n.className])).toEqual([["A calendar needs at least one working day.", "toast bad"]]);
    expect(within(group).getByRole("button", { name: "Mon" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(within(group).getByRole("button", { name: "Wed" }));
    expect(within(group).getByRole("button", { name: "Wed" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(within(group).getByRole("button", { name: "Mon" }));
    await clickApply();
    expect(t.session.view().plan.calendar.workdays).toEqual([3]);
  });

  it("adds one date as an added day off and a range as a closure that × removes", async () => {
    const t = await made([]);
    await shown(t);
    await openDialog();
    type("Day off name", "Away");
    type("First day", "2026-11-17");
    fireEvent.click(inDialog().getByRole("button", { name: "Add a day off" }));
    await settle();
    expect(within(dayRow("Away")).getByText("Added by you")).toBeTruthy();
    expect(within(dayRow("Away")).getByRole("button", { name: "Remove" })).toBeTruthy();
    type("Day off name", "Offsite");
    type("First day", "2026-11-18");
    type("Last day", "2026-11-19");
    fireEvent.click(inDialog().getByRole("button", { name: "Add a day off" }));
    await settle();
    expect(inDialog().getByText("2026-11-18 – 2026-11-19")).toBeTruthy();
    fireEvent.click(inDialog().getByRole("button", { name: "Remove Offsite" }));
    expect(inDialog().queryByText("2026-11-18 – 2026-11-19")).toBeNull();
    type("Day off name", "Offsite");
    type("First day", "2026-11-18");
    type("Last day", "2026-11-19");
    fireEvent.click(inDialog().getByRole("button", { name: "Add a day off" }));
    await clickApply();
    const cal = t.session.view().plan.calendar;
    expect(cal.tuning.get("2026-11-17")).toEqual({ kind: "add", name: "Away" });
    expect([...cal.closures.values()].map((c) => [c.from, c.to, c.name])).toEqual([["2026-11-18", "2026-11-19", "Offsite"]]);
  });

  it("refuses a day off without a name or first day, and a range that ends first", async () => {
    const t = await made([]);
    await shown(t);
    await openDialog();
    type("First day", "2026-11-17");
    fireEvent.click(inDialog().getByRole("button", { name: "Add a day off" }));
    type("Day off name", "Away");
    type("First day", "");
    fireEvent.click(inDialog().getByRole("button", { name: "Add a day off" }));
    type("First day", "2026-11-17");
    type("Last day", "2026-11-16");
    fireEvent.click(inDialog().getByRole("button", { name: "Add a day off" }));
    expect(toastTexts()).toEqual(["A day off needs a name and a first day.", "A day off needs a name and a first day.", "The last day is before the first day."]);
    expect(applyButton().disabled).toBe(true);
  });
});

describe("day list", () => {
  it("lists every day in the plan's span with its origin and the button that changes it", async () => {
    const t = await made([{ name: "Long", start: "2027-03-22", dur: 10 }], { calendar: zhPlan(), answers: { holidays_year: pending } });
    await shown(t);
    await openDialog();
    expect(inDialog().getByText("Days off and holidays, 9 Nov 2026 – 6 Apr 2027")).toBeTruthy();
    const row = (name: string): string[] => {
      const r = dayRow(name);
      return [r.querySelector(".day-origin")?.textContent ?? "", r.querySelector("button")?.textContent ?? ""];
    };
    expect(row("Christmas Eve")).toEqual(["Half day", "Count as a day off"]);
    expect(row("Christmas Day")).toEqual(["Official · OpenHolidays", "Work this day"]);
    expect(row("Berchtold's Day")).toEqual(["Optional", "Count as a day off"]);
    expect(row("Easter Monday")).toEqual(["Official · OpenHolidays", "Work this day"]);
    fireEvent.click(within(dayRow("Christmas Day")).getByRole("button", { name: "Work this day" }));
    fireEvent.click(within(dayRow("Christmas Eve")).getByRole("button", { name: "Count as a day off" }));
    expect(row("Christmas Day")).toEqual(["Official · OpenHolidays — you work this day", "Count as a day off"]);
    expect(row("Christmas Eve")).toEqual(["Half day, turned on", "Work this day"]);
    fireEvent.click(within(dayRow("Christmas Day")).getByRole("button", { name: "Count as a day off" }));
    await clickApply();
    expect([...t.session.view().plan.calendar.tuning]).toEqual([["2026-12-24", { kind: "off" }]]);
  });

  it("covers a year from today on an empty plan", async () => {
    const t = await made([]);
    await shown(t);
    await openDialog();
    expect(inDialog().getByText("Days off and holidays, 9 Nov 2026 – 9 Nov 2027")).toBeTruthy();
    expect(inDialog().getByText("Nothing listed in this span.")).toBeTruthy();
  });
});

describe("impact and Apply", () => {
  it("previews the draft on the real session and disables Apply while nothing changes", async () => {
    const t = await made(IMPACT_SEED);
    await shown(t);
    await openDialog();
    expect(impact()).toBe(NONE);
    expect(applyButton().disabled).toBe(true);
    type("Day off name", "Offsite");
    type("First day", "2026-11-17");
    type("Last day", "2026-11-18");
    fireEvent.click(inDialog().getByRole("button", { name: "Add a day off" }));
    await settle();
    const closure: Closure = { id: "c-same", from: "2026-11-17", to: "2026-11-18", name: "Offsite" };
    const next: Calendar = { ...t.session.view().plan.calendar, closures: new Map([[closure.id, closure]]) };
    expect(impact()).toBe(impactText(t.session.preview({ t: "calendar", next })));
    expect(impact()).toBe(`Applying changes the end date of 2 items; 1 moves later to keep its dependencies. ${CLOSE}`);
    expect(applyButton().disabled).toBe(false);
    fireEvent.click(inDialog().getByRole("button", { name: "Remove Offsite" }));
    expect(impact()).toBe(NONE);
    expect(applyButton().disabled).toBe(true);
    const group = inDialog().getByRole("group", { name: "Working days" });
    fireEvent.click(within(group).getByRole("button", { name: "Fri" }));
    expect(applyButton().disabled).toBe(false);
    fireEvent.click(within(group).getByRole("button", { name: "Fri" }));
    expect(applyButton().disabled).toBe(true);
    expect(impact()).toBe(NONE);
  });

  it("applies once with the draft and the calendar read at open, toasts the built toast and closes", async () => {
    const t = await made(IMPACT_SEED);
    await shown(t);
    const atOpen = t.session.view().plan.calendar;
    await openDialog();
    const apply = vi.spyOn(t.session, "apply");
    fireEvent.click(within(inDialog().getByRole("group", { name: "Working days" })).getByRole("button", { name: "Fri" }));
    await clickApply();
    expect(apply).toHaveBeenCalledTimes(1);
    const intent = apply.mock.calls[0][0];
    if (intent.t !== "calendar") throw new Error("not a calendar intent");
    expect(intent.base).toBe(atOpen);
    expect(intent.next.workdays).toEqual([1, 2, 3, 4]);
    const result = apply.mock.results[0];
    if (result.type !== "return") throw new Error("apply threw");
    const built: Built = result.value;
    expect(toastTexts()).toEqual([built.toast]);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(lastUi().dialog).toBeNull();
  });

  it("keeps draft and base through another device's change and writes only what the owner changed (refinement 34)", async () => {
    const t = await made(IMPACT_SEED);
    await shown(t);
    const atOpen = t.session.view().plan.calendar;
    await openDialog();
    const p = await t.peer("iphone");
    const yearEnd: Closure = { id: "c1", from: "2026-12-28", to: "2026-12-31", name: "Year-end" };
    const theirs = p.session.view().plan.calendar;
    act(() => {
      p.session.apply({ t: "calendar", next: { ...theirs, closures: new Map([["c1", yearEnd]]) } });
      p.sync();
    });
    await settle();
    expect(t.session.view().plan.calendar.closures.get("c1")).toEqual(yearEnd);
    expect(inDialog().queryByText("Year-end")).toBeNull();
    expect(impact()).toBe(NONE);
    expect(applyButton().disabled).toBe(true);
    const apply = vi.spyOn(t.session, "apply");
    fireEvent.click(within(inDialog().getByRole("group", { name: "Working days" })).getByRole("button", { name: "Fri" }));
    await clickApply();
    const intent = apply.mock.calls[0][0];
    if (intent.t !== "calendar") throw new Error("not a calendar intent");
    expect(intent.base).toBe(atOpen);
    expect(intent.next.closures.has("c1")).toBe(false);
    const cal = t.session.view().plan.calendar;
    expect(cal.closures.get("c1")).toEqual(yearEnd);
    expect(cal.workdays).toEqual([1, 2, 3, 4]);
  });
});

describe("last region", () => {
  const realShell = async (): Promise<{ registry: RealRegistry; session: PlanSession }> => {
    const s = await seededStore(["Plan"]);
    Object.assign(tauri.answers, REGION_ANSWERS);
    const clock = fixedClock("2026-11-09");
    const registry = await RealRegistry.open({ clock });
    registries.push(registry);
    render(<Shell registry={registry} clock={clock} />);
    await settle();
    const session = await registry.session(s.ids[0]);
    return { registry, session };
  };

  it("saves the picked region after the apply, and the next new plan takes it", async () => {
    const { registry, session } = await realShell();
    await openDialog();
    await pickZurich();
    const apply = vi.spyOn(session, "apply");
    const save = vi.spyOn(registry, "setLastRegion");
    await clickApply();
    expect(apply).toHaveBeenCalledTimes(1);
    expect(save.mock.calls).toEqual([[ZH]]);
    expect(apply.mock.invocationCallOrder[0]).toBeLessThan(save.mock.invocationCallOrder[0]);
    expect(screen.queryByRole("dialog")).toBeNull();
    let id = "";
    await act(async () => {
      id = await registry.createPlan("Next");
    });
    expect((await registry.session(id)).view().plan.calendar.region).toEqual(ZH);
  });

  it("keeps the dialog open with the settings error and Try again, which saves again only", async () => {
    const { registry, session } = await realShell();
    await openDialog();
    await pickZurich();
    const apply = vi.spyOn(session, "apply");
    const save = vi.spyOn(registry, "setLastRegion").mockRejectedValueOnce(new AppError("settings.io", "Could not save settings: disk full."));
    await clickApply();
    expect(apply).toHaveBeenCalledTimes(1);
    expect(session.view().plan.calendar.region).toEqual(ZH);
    expect(inDialog().getByText("Could not save settings: disk full.")).toBeTruthy();
    fireEvent.click(inDialog().getByRole("button", { name: "Try again" }));
    await settle();
    expect(save.mock.calls).toEqual([[ZH], [ZH]]);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Could not save settings: disk full.")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("does not save a region when the draft region is null", async () => {
    const { registry } = await realShell();
    await openDialog();
    const save = vi.spyOn(registry, "setLastRegion");
    fireEvent.click(within(inDialog().getByRole("group", { name: "Working days" })).getByRole("button", { name: "Fri" }));
    await clickApply();
    expect(save).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("does not save an unchanged region", async () => {
    const t = await made([], { calendar: zhPlan(), answers: { holidays_year: pending } });
    const save = vi.fn(async () => undefined);
    await shown(t, { setLastRegion: save });
    await openDialog();
    fireEvent.click(within(inDialog().getByRole("group", { name: "Working days" })).getByRole("button", { name: "Fri" }));
    await clickApply();
    expect(save).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("does not save the region of a refused apply and stays open", async () => {
    const t = await made([], { calendar: zhPlan(), answers: { holidays_year: pending } });
    const save = vi.fn(async () => undefined);
    await shown(t, { setLastRegion: save });
    await openDialog();
    await choose("Holiday source", "govuk");
    await choose("Division", "scotland");
    vi.spyOn(t.session, "apply").mockImplementation(() => {
      throw new Refused("A calendar needs at least one working day.");
    });
    await clickApply();
    expect(save).not.toHaveBeenCalled();
    expect(dialog()).toBeTruthy();
    expect(toastNodes().map((n) => [n.textContent, n.className])).toEqual([["A calendar needs at least one working day.", "toast bad"]]);
  });
});

describe("holiday state in the plan head", () => {
  it("shows the no-region line with Choose region, absent on a CH-ZH plan", async () => {
    const t = await made([]);
    await shown(t);
    const line = head().querySelector(".head-line.warn");
    expect(line?.textContent).toBe("No holiday region — dates use weekdays and closures · Choose region");
    fireEvent.click(within(head()).getByRole("button", { name: "Choose region" }));
    await settle();
    expect(lastUi().dialog).toEqual({ t: "calendar" });
    expect(dialog()).toBeTruthy();
    cleanup();
    const zh = await made([], { calendar: zhPlan(), answers: { holidays_year: pending } });
    await shown(zh);
    expect(head().textContent).not.toContain("No holiday region");
  });

  it("renders each notice with its button and detail", async () => {
    const t = await made([], { calendar: zhPlan(), answers: { holidays_year: pending } });
    const y2028 = holidayYear("oh:CH:CH-ZH", 2028, [holidayDay("2028-01-01", "New Year's Day", "public")]);
    const intent = reviewIntent(t, 2028, y2028);
    const preview = t.session.preview(intent);
    const list: HolidayNotice[] = [
      { k: "loading", year: 2028 },
      { k: "notLoaded", year: 2028 },
      { k: "ready", year: 2028, count: 1, intent, preview },
      { k: "changed", year: 2027, count: 2, intent, preview },
    ];
    vi.spyOn(t.holidays, "notices").mockReturnValue(list);
    const load = vi.spyOn(t.holidays, "load").mockResolvedValue(undefined);
    await shown(t);
    const line = (text: string): HTMLElement => {
      const el = within(head()).getByText(text).closest(".notice");
      if (!(el instanceof HTMLElement)) throw new Error(`no notice ${text}`);
      return el;
    };
    expect(within(line("Holidays for 2028 loading")).queryAllByRole("button")).toEqual([]);
    expect(within(line("Holidays for 2028 ready — review")).getByRole("button").textContent).toBe("Review");
    expect(within(line("2 days changed in the official calendar for 2027")).getByRole("button").textContent).toBe("Review");
    fireEvent.click(within(line("Holidays for 2028 not loaded — load")).getByRole("button", { name: "Load" }));
    expect(load.mock.calls).toEqual([[t.session.view().plan.id, t.session, 2028]]);
  });

  it("shows a year a source has no data for, with Change calendar… and no retry (Review Focus 2)", async () => {
    const t = await made([{ name: "Far", start: "2031-03-03", dur: 3 }], { calendar: zhPlan(), answers: { holidays_year: pending } });
    const n: HolidayNotice = {
      k: "failed",
      year: 2031,
      error: new AppError("holidays.out_of_range", "OpenHolidays has CH holidays for 2020–2030, not 2031"),
      coverage: { from: 2020, to: 2030 },
      at: new Date(2026, 10, 8, 14, 5).getTime(),
    };
    vi.spyOn(t.holidays, "notices").mockReturnValue([n]);
    const load = vi.spyOn(t.holidays, "load").mockResolvedValue(undefined);
    await shown(t);
    const line = within(head()).getByText("Holidays for 2031 not available — open calendar").closest(".notice");
    if (!(line instanceof HTMLElement)) throw new Error("no notice line");
    const detail = line.querySelector(".notice-detail")?.textContent ?? "";
    expect(detail).toContain("OpenHolidays has CH holidays for 2020–2030, not 2031");
    expect(detail.endsWith("Tried 2026-11-08 14:05.")).toBe(true);
    expect(within(line).getAllByRole("button").map((b) => b.textContent)).toEqual(["Change calendar…"]);
    fireEvent.click(within(line).getByRole("button", { name: "Change calendar…" }));
    await settle();
    expect(lastUi().dialog).toEqual({ t: "calendar" });
    expect(within(missingRow(2031)).queryByRole("button", { name: "Try again" })).toBeNull();
    expect(within(missingRow(2031)).getByText(detail)).toBeTruthy();
    expect(load).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toMatch(/no days off|no holidays/i);
  });

  it("loads again from a refreshFailed notice without changing the plan", async () => {
    const t = await made([], { calendar: zhPlan(), answers: { holidays_year: pending } });
    vi.spyOn(t.holidays, "notices").mockReturnValue([
      { k: "refreshFailed", year: 2027, error: new AppError("holidays.offline", "No network connection."), at: new Date(2026, 10, 8, 14, 5).getTime(), fetchedAt: "2026-10-01T08:00:00Z" },
    ]);
    const load = vi.spyOn(t.holidays, "load").mockResolvedValue(undefined);
    const apply = vi.spyOn(t.session, "apply");
    const before = t.session.view().plan.calendar;
    await shown(t);
    const line = within(head()).getByText("Holidays for 2027 not checked — retry").closest(".notice");
    if (!(line instanceof HTMLElement)) throw new Error("no notice line");
    expect(line.querySelector(".notice-detail")?.textContent?.endsWith("Last fetched 2026-10-01.")).toBe(true);
    fireEvent.click(within(line).getByRole("button", { name: "Try again" }));
    await settle();
    expect(load.mock.calls).toEqual([[t.session.view().plan.id, t.session, 2027]]);
    expect(apply).not.toHaveBeenCalled();
    expect(t.session.view().plan.calendar).toBe(before);
  });
});

describe("review notices", () => {
  const reviewOn = async (o: { year?: number; readOnly?: boolean } = {}) => {
    const t = await made([], { calendar: zhPlan(), answers: { holidays_year: pending } });
    const year = o.year ?? 2028;
    const intent = reviewIntent(t, year, holidayYear("oh:CH:CH-ZH", year, [holidayDay(`${year}-01-03`, "Test Day", "public")]));
    const n: HolidayNotice = { k: "ready", year, count: 1, intent, preview: t.session.preview(intent) };
    vi.spyOn(t.holidays, "notices").mockReturnValue([n]);
    const dismiss = vi.spyOn(t.holidays, "dismiss");
    const save = vi.fn(async () => undefined);
    await shown(t, { setLastRegion: save });
    if (o.readOnly === true) act(() => t.session.setReadOnly(true));
    fireEvent.click(within(head()).getByRole("button", { name: "Review" }));
    await settle();
    return { t, n, intent, dismiss, save };
  };

  it("applies the notice's intent as is when the draft is untouched, then dismisses", async () => {
    const { t, intent, dismiss, save } = await reviewOn();
    const apply = vi.spyOn(t.session, "apply");
    await clickApply();
    expect(apply.mock.calls.length).toBe(1);
    expect(apply.mock.calls[0][0]).toBe(intent);
    expect(dismiss.mock.calls).toEqual([[t.session.view().plan.id, 2028]]);
    expect(apply.mock.invocationCallOrder[0]).toBeLessThan(dismiss.mock.invocationCallOrder[0]);
    expect(save).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(t.session.view().plan.calendar.holidays.get(2028)?.days.map((d) => d.name)).toEqual(["Test Day"]);
  });

  it("applies the edited draft against the notice's base", async () => {
    const { t, intent } = await reviewOn();
    const apply = vi.spyOn(t.session, "apply");
    fireEvent.click(within(inDialog().getByRole("group", { name: "Working days" })).getByRole("button", { name: "Fri" }));
    await clickApply();
    const got = apply.mock.calls[0][0];
    if (got.t !== "calendar") throw new Error("not a calendar intent");
    expect(got.base).toBe(intent.base);
    expect(got.next.workdays).toEqual([1, 2, 3, 4]);
    expect(got.next.holidays.get(2028)).toBe(intent.next.holidays.get(2028));
  });

  it("dismisses without a toast when another device already applied it", async () => {
    const { t, dismiss } = await reviewOn();
    const apply = vi.spyOn(t.session, "apply").mockImplementation(() => {
      throw new Refused("Nothing to change.");
    });
    await clickApply();
    expect(apply).toHaveBeenCalledTimes(1);
    expect(dismiss.mock.calls).toEqual([[t.session.view().plan.id, 2028]]);
    expect(toastNodes()).toEqual([]);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("toasts any other refusal and keeps the notice and the dialog", async () => {
    const { t, dismiss } = await reviewOn();
    vi.spyOn(t.session, "apply").mockImplementation(() => {
      throw new Refused("A calendar needs at least one working day.");
    });
    await clickApply();
    expect(dismiss).not.toHaveBeenCalled();
    expect(toastNodes().map((n) => [n.textContent, n.className])).toEqual([["A calendar needs at least one working day.", "toast bad"]]);
    expect(dialog()).toBeTruthy();
  });
});

describe("failed years in the day list", () => {
  it.each([
    ["holidays.rate_limited", "openholidaysapi.org asked WebBoard to wait 120 s before asking again (HTTP 429)."],
    ["holidays.offline", "No network connection."],
    ["holidays.http", "openholidaysapi.org answered HTTP 500."],
  ])("lists the plan region's %s year as not loaded with its detail and Try again → load", async (code, message) => {
    const t = await made([{ id: "N", name: "Next year", start: "2027-02-01", dur: 3 }], {
      calendar: zhPlan({ holidays: new Map([[2026, CH_ZH_2026]]) }),
      answers: { holidays_year: pending },
    });
    vi.spyOn(t.holidays, "notices").mockReturnValue([{ k: "failed", year: 2027, error: new AppError(code, message), coverage: null, at: new Date(2026, 10, 8, 14, 5).getTime() }]);
    const load = vi.spyOn(t.holidays, "load").mockResolvedValue(undefined);
    const apply = vi.spyOn(t.session, "apply");
    await shown(t);
    await openDialog();
    const row = missingRow(2027);
    expect(within(row).getByText(`${message} Tried 2026-11-08 14:05.`)).toBeTruthy();
    fireEvent.click(within(row).getByRole("button", { name: "Try again" }));
    await settle();
    expect(load.mock.calls).toEqual([[t.session.view().plan.id, t.session, 2027]]);
    expect(apply).not.toHaveBeenCalled();
  });

  it("lists a missing year of the plan's region with no notice as not loaded, never empty", async () => {
    const t = await made([{ id: "N", name: "Next year", start: "2027-02-01", dur: 3 }], {
      calendar: zhPlan({ holidays: new Map([[2026, CH_ZH_2026]]) }),
      answers: { holidays_year: pending },
    });
    vi.spyOn(t.holidays, "notices").mockReturnValue([]);
    await shown(t);
    await openDialog();
    expect(within(missingRow(2027)).queryByRole("button")).toBeNull();
    expect(inDialog().queryByText("Nothing listed in this span.")).toBeNull();
  });

  it("shows why a picked region's year did not load and loads it again in the dialog (refinement 43)", async () => {
    const t = await made([{ id: "N", name: "Next year", start: "2027-12-27", dur: 3 }]);
    const nine = holidayYear(
      "oh:CH:CH-ZH",
      2027,
      ["01-01", "01-02", "03-26", "03-29", "05-06", "05-17", "08-01", "12-25", "12-26"].map((d, i) => holidayDay(`2027-${d}`, `Holiday ${i + 1}`, "public")),
    );
    const draftYears = vi
      .spyOn(t.holidays, "draftYears")
      .mockResolvedValueOnce(
        new Map<number, HolidayYear | AppError>([
          [2026, CH_ZH_2026],
          [2027, new AppError("holidays.offline", "No network connection.")],
        ]),
      )
      .mockResolvedValueOnce(new Map<number, HolidayYear | AppError>([[2027, nine]]));
    const load = vi.spyOn(t.holidays, "load");
    const apply = vi.spyOn(t.session, "apply");
    const notices = t.holidays.notices(t.session.view().plan.id);
    await shown(t, {}, fixedClock("2026-11-09", new Date(2026, 10, 9, 14, 5).getTime()));
    await openDialog();
    await pickZurich();
    expect(draftYears.mock.calls).toEqual([[ZH, [2026, 2027]]]);
    const row = missingRow(2027);
    expect(within(row).getByText("No network connection.")).toBeTruthy();
    expect(within(row).getByText("Tried 14:05")).toBeTruthy();
    expect(t.holidays.notices(t.session.view().plan.id)).toBe(notices);
    expect(load).not.toHaveBeenCalled();
    fireEvent.click(within(row).getByRole("button", { name: "Try again" }));
    await settle();
    expect(draftYears.mock.calls).toEqual([
      [ZH, [2026, 2027]],
      [ZH, [2027]],
    ]);
    nine.days.forEach((d) => expect(dayRow(d.name)).toBeTruthy());
    expect(inDialog().queryByText(NOT_LOADED(2027))).toBeNull();
    expect(inDialog().queryByRole("button", { name: "Try again" })).toBeNull();
    expect(apply).not.toHaveBeenCalled();
    expect(load).not.toHaveBeenCalled();
  });
});

describe("read-only", () => {
  it("disables Apply in the calendar dialog while the draft still previews", async () => {
    const t = await made(IMPACT_SEED);
    const save = vi.fn(async () => undefined);
    await shown(t, { setLastRegion: save });
    await openDialog();
    act(() => t.session.setReadOnly(true));
    const apply = vi.spyOn(t.session, "apply");
    fireEvent.click(within(inDialog().getByRole("group", { name: "Working days" })).getByRole("button", { name: "Fri" }));
    expect(impact()).toBe(`Applying changes the end date of 1 item. ${CLOSE}`);
    expect(applyButton().disabled).toBe(true);
    fireEvent.click(applyButton());
    await settle();
    expect(apply).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    expect(dialog()).toBeTruthy();
  });

  it("disables Apply in a review notice's dialog", async () => {
    const t = await made([], { calendar: zhPlan(), answers: { holidays_year: pending } });
    const intent = reviewIntent(t, 2028, holidayYear("oh:CH:CH-ZH", 2028, []));
    vi.spyOn(t.holidays, "notices").mockReturnValue([{ k: "ready", year: 2028, count: 0, intent, preview: t.session.preview(intent) }]);
    const dismiss = vi.spyOn(t.holidays, "dismiss");
    await shown(t);
    act(() => t.session.setReadOnly(true));
    fireEvent.click(within(head()).getByRole("button", { name: "Review" }));
    await settle();
    const apply = vi.spyOn(t.session, "apply");
    expect(applyButton().disabled).toBe(true);
    fireEvent.click(applyButton());
    expect(apply).not.toHaveBeenCalled();
    expect(dismiss).not.toHaveBeenCalled();
  });
});
