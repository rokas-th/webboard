import fc from "fast-check";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildAction, initialAction } from "../actions/build";
import type { Intent, Preview } from "../actions/intents";
import type { Calendar, HolidayDay, HolidayYear, RegionRef } from "../domain/calendar";
import { LogState } from "../log/state";
import { projectPlan } from "../plan/project";
import { planRules } from "../plan/rules";
import type { PlanView } from "../store/doc";
import { act } from "../test/act";
import { CH_ZH, CH_ZH_2027, FETCHED_AT, holidayDay } from "../test/fixtures/calendars";
import { ctxOf, PLAN_ID } from "../test/planCtx";
import { commandsSince, commandsWith, hold, resetTauri, tauri, type Answer } from "../test/tauriMock";
import { diffDays, HolidayService, noticeText, type HolidayHost, type HolidayNotice } from "./holidays";
import { AppError } from "./ipc";

vi.mock("@tauri-apps/api/core", () => import("../test/tauriMock"));

const CHZH: RegionRef = { src: "openholidays", country: "CH", subdivision: "CH-ZH" };
const RK = "oh:CH:CH-ZH";
const OTHER: RegionRef = { src: "openholidays", country: "CH", subdivision: "CH-BE" };
const TODAY_NOON = new Date(2026, 10, 9, 12).getTime();
const FETCHED_TODAY = new Date(2026, 10, 9, 11).toISOString();
const LAST_FETCHED = new Date(2026, 10, 1, 9).toISOString();
const TRIED = new Date(2026, 10, 8, 14, 5).getTime();
const PREVIEW: Preview = { itemsChanged: 0, endsChanged: 0, movedLater: 0, stopped: [], conflictsAfter: 0, kept: [] };

const DAYS_2028: readonly HolidayDay[] = [
  holidayDay("2028-01-01", "New Year's Day", "public"),
  holidayDay("2028-04-14", "Good Friday", "public"),
];
const OLD_2027 = CH_ZH_2027.days;
const NEW_2027: readonly HolidayDay[] = [
  ...OLD_2027.map((d) => (d.date === "2027-01-02" ? { ...d, name: "Berchtoldstag" } : d)),
  holidayDay("2027-05-06", "Ascension Day", "public"),
];

const CAL_2027: Calendar = {
  ...CH_ZH,
  holidays: new Map([[2027, { ...CH_ZH_2027, fetchedAt: LAST_FETCHED }]]),
};

const withYear = (cal: Calendar, year: number, days: readonly HolidayDay[], fetchedAt: string): Calendar => ({
  ...cal,
  holidays: new Map([...cal.holidays, [year, { region: RK, year, days, fetchedAt }]]),
});

interface YearArgs {
  region: RegionRef;
  year: number;
  fresh: boolean;
}

const yearAnswer =
  (f: (a: YearArgs) => { days: readonly HolidayDay[]; fetchedAt?: string; fromCache?: boolean; coverage?: [number, number] | null }): Answer =>
  (args) => {
    const r = f(args as unknown as YearArgs);
    return { days: r.days, fetchedAt: r.fetchedAt ?? FETCHED_AT, fromCache: r.fromCache ?? false, coverage: r.coverage === undefined ? [2020, 2030] : r.coverage };
  };

const fail = (code: string, message: string): never => {
  throw { code, message };
};

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

type RejectionListener = (reason: unknown) => void;

declare const process: {
  listeners(event: "unhandledRejection"): RejectionListener[];
  removeAllListeners(event: "unhandledRejection"): void;
  on(event: "unhandledRejection", l: RejectionListener): void;
  once(event: "unhandledRejection", l: RejectionListener): void;
};

const nextUnhandled = (): Promise<unknown> => {
  const saved = process.listeners("unhandledRejection");
  process.removeAllListeners("unhandledRejection");
  return new Promise((resolve) => {
    process.once("unhandledRejection", (reason) => {
      saved.forEach((l) => process.on("unhandledRejection", l));
      resolve(reason);
    });
  });
};

const BAD_SHAPE: Answer = () => ({ days: null, fetchedAt: "x", fromCache: false, coverage: null });

function stub(calendar: Calendar, missing: number[], preview: (i: Intent) => Preview = () => PREVIEW) {
  const state = { calendar, missing };
  const spy = vi.fn(preview);
  const host: HolidayHost = {
    view: () => ({ plan: { calendar: state.calendar }, derived: { missingYears: state.missing } }) as unknown as PlanView,
    preview: spy,
  };
  return { state, host, preview: spy };
}

const yearCalls = (from: number) => commandsSince(from).filter((c) => c === "holidays_year").length;
const freshCalls = (from: number) => commandsWith(from, "holidays_year", { fresh: true });

const only = (ns: readonly HolidayNotice[]): HolidayNotice => {
  expect(ns).toHaveLength(1);
  return ns[0];
};

const intentOf = (n: HolidayNotice): Extract<Intent, { t: "calendar" }> => {
  if ((n.k !== "ready" && n.k !== "changed") || n.intent.t !== "calendar") throw new Error(`no calendar intent on ${n.k}`);
  return n.intent;
};

beforeEach(() => resetTauri({}));

describe("missing years", () => {
  it("cached own edit", async () => {
    resetTauri({ holidays_year: yearAnswer(() => ({ days: DAYS_2028 })) });
    const svc = new HolidayService();
    await svc.warm(CHZH, [2028]);
    const from = tauri.calls.length;
    const { host } = stub(CH_ZH, [2028]);
    svc.onMissing(PLAN_ID, host, [2028], "own");
    await flush();
    expect(commandsSince(from)).toEqual([]);
    expect(svc.notices(PLAN_ID)).toEqual([]);
  });

  it("uncached own edit", async () => {
    resetTauri({ holidays_year: yearAnswer(() => ({ days: DAYS_2028 })) });
    const svc = new HolidayService();
    const { host, state, preview } = stub(CH_ZH, [2028]);
    svc.onMissing(PLAN_ID, host, [2028], "own");
    expect(svc.notices(PLAN_ID)).toEqual([{ k: "loading", year: 2028 }]);
    expect(noticeText(svc.notices(PLAN_ID)[0])).toEqual({ text: "Holidays for 2028 loading", action: null, detail: null });
    await flush();
    const n = only(svc.notices(PLAN_ID));
    expect(n.k).toBe("ready");
    expect(intentOf(n).next.holidays.get(2028)?.days).toEqual(DAYS_2028);
    expect(preview).toHaveBeenCalledTimes(1);
    expect(preview).toHaveBeenCalledWith(intentOf(n));
    expect(n.k === "ready" && n.preview).toBe(PREVIEW);
    expect(noticeText(n)).toEqual({ text: "Holidays for 2028 ready — review", action: "review", detail: null });
    expect(state.calendar).toBe(CH_ZH);
    expect(state.calendar.holidays.has(2028)).toBe(false);
  });

  it("merge waits", async () => {
    resetTauri({ holidays_year: yearAnswer(() => ({ days: DAYS_2028 })) });
    const svc = new HolidayService();
    const { host } = stub(CH_ZH, [2028]);
    svc.onMissing(PLAN_ID, host, [2028], "merge");
    await flush();
    expect(yearCalls(0)).toBe(0);
    const n = only(svc.notices(PLAN_ID));
    expect(n).toEqual({ k: "notLoaded", year: 2028 });
    expect(noticeText(n)).toEqual({ text: "Holidays for 2028 not loaded — load", action: "load", detail: null });
    await svc.load(PLAN_ID, host, 2028);
    expect(yearCalls(0)).toBe(1);
    expect(only(svc.notices(PLAN_ID)).k).toBe("ready");
  });

  it("failure retries", async () => {
    resetTauri({ holidays_year: () => fail("holidays.offline", "This device is offline.") });
    const svc = new HolidayService(() => new Date(2026, 10, 8, 14, 5).getTime());
    const { host, state } = stub(CH_ZH, [2028]);
    svc.onMissing(PLAN_ID, host, [2028], "own");
    await flush();
    const n = only(svc.notices(PLAN_ID));
    expect(n.k).toBe("failed");
    const t = noticeText(n);
    expect(t.text).toBe("Holidays for 2028 not loaded — retry");
    expect(t.action).toBe("retry");
    expect(t.detail).toBe("This device is offline. Tried 2026-11-08 14:05.");
    expect(state.calendar).toBe(CH_ZH);
    expect(yearCalls(0)).toBe(1);
    await svc.load(PLAN_ID, host, 2028);
    expect(yearCalls(0)).toBe(2);
    expect(only(svc.notices(PLAN_ID)).k).toBe("failed");
  });

  it("a warm failure shows at the next onMissing", async () => {
    resetTauri({ holidays_year: () => fail("holidays.offline", "Offline.") });
    const svc = new HolidayService(() => new Date(2026, 10, 8, 14, 5).getTime());
    await expect(svc.warm(CHZH, [2028])).resolves.toBeUndefined();
    const from = tauri.calls.length;
    const { host } = stub(CH_ZH, [2028]);
    svc.onMissing(PLAN_ID, host, [2028], "merge");
    expect(commandsSince(from)).toEqual([]);
    expect(noticeText(only(svc.notices(PLAN_ID)))).toEqual({
      text: "Holidays for 2028 not loaded — retry",
      action: "retry",
      detail: "Offline. Tried 2026-11-08 14:05.",
    });
  });

  it("warm skips cached", async () => {
    resetTauri({ holidays_year: yearAnswer(() => ({ days: OLD_2027 })) });
    const svc = new HolidayService();
    await svc.warm(CHZH, [2027]);
    expect(yearCalls(0)).toBe(1);
    await svc.warm(CHZH, [2027]);
    expect(yearCalls(0)).toBe(1);
    expect(svc.cached(RK, 2027)?.days).toEqual(OLD_2027);
  });

  it("already applied on arrival", async () => {
    const h = hold("holidays_year");
    const svc = new HolidayService();
    const { host, state, preview } = stub(CH_ZH, [2028]);
    svc.onMissing(PLAN_ID, host, [2028], "own");
    expect(svc.notices(PLAN_ID)).toEqual([{ k: "loading", year: 2028 }]);
    const sub = vi.fn();
    svc.subscribe(sub);
    state.calendar = withYear(CH_ZH, 2028, DAYS_2028, "2026-10-01T00:00:00Z");
    h.resolve({ days: DAYS_2028, fetchedAt: FETCHED_AT, fromCache: false, coverage: [2020, 2030] });
    await flush();
    expect(svc.notices(PLAN_ID)).toEqual([]);
    expect(preview).not.toHaveBeenCalled();
    expect(sub).toHaveBeenCalledTimes(1);
  });

  it("preview throws", async () => {
    resetTauri({ holidays_year: yearAnswer(() => ({ days: DAYS_2028 })) });
    const svc = new HolidayService();
    const { host } = stub(CH_ZH, [2028], () => {
      throw new Error("boom");
    });
    const sub = vi.fn();
    svc.subscribe(sub);
    await expect(svc.load(PLAN_ID, host, 2028)).rejects.toThrow("boom");
    expect(svc.notices(PLAN_ID)).toEqual([]);
    expect(sub).toHaveBeenCalledTimes(2);
  });

  it("preview throws on a cached merge", async () => {
    resetTauri({ holidays_year: yearAnswer(() => ({ days: DAYS_2028 })) });
    const svc = new HolidayService();
    const { host } = stub(CH_ZH, [2028], () => {
      throw new Error("boom");
    });
    svc.onMissing(PLAN_ID, host, [2028], "merge");
    expect(svc.notices(PLAN_ID)).toEqual([{ k: "notLoaded", year: 2028 }]);
    await svc.warm(CHZH, [2028]);
    const sub = vi.fn();
    svc.subscribe(sub);
    expect(() => svc.onMissing(PLAN_ID, host, [2028], "merge")).toThrow("boom");
    expect(svc.notices(PLAN_ID)).toEqual([]);
    expect(sub).toHaveBeenCalledTimes(1);
  });

  it("an unexpected answer shape rejects and leaves no loading notice", async () => {
    resetTauri({ holidays_year: BAD_SHAPE });
    const svc = new HolidayService();
    await expect(svc.draftYears(CHZH, [2028])).rejects.toMatchObject({ code: "ipc.shape", message: "holidays_year answered an unexpected shape for oh:CH:CH-ZH 2028" });
    expect(svc.cached(RK, 2028)).toBeNull();
    const { host } = stub(CH_ZH, [2028]);
    const sub = vi.fn();
    svc.subscribe(sub);
    const rejected = nextUnhandled();
    svc.onMissing(PLAN_ID, host, [2028], "own");
    expect(svc.notices(PLAN_ID)).toEqual([{ k: "loading", year: 2028 }]);
    expect(await rejected).toMatchObject({ code: "ipc.shape" });
    expect(svc.notices(PLAN_ID)).toEqual([]);
    expect(sub).toHaveBeenCalledTimes(2);
    expect(svc.cached(RK, 2028)).toBeNull();
  });

  it("no region and no missing years records nothing", () => {
    const svc = new HolidayService();
    const sub = vi.fn();
    svc.subscribe(sub);
    const { host } = stub({ ...CH_ZH, region: null }, []);
    svc.onMissing(PLAN_ID, host, [], "own");
    expect(svc.notices(PLAN_ID)).toEqual([]);
    expect(sub).not.toHaveBeenCalled();
  });

  it("missing years without a region throw", () => {
    const svc = new HolidayService();
    const { host } = stub({ ...CH_ZH, region: null }, [2028, 2029]);
    expect(() => svc.onMissing(PLAN_ID, host, [2028, 2029], "merge")).toThrow(`Plan ${PLAN_ID} has no holiday region but 2028, 2029 are missing`);
    expect(svc.notices(PLAN_ID)).toEqual([]);
  });

  it("a repeated onMissing for a failed year changes nothing", async () => {
    resetTauri({ holidays_year: () => fail("holidays.offline", "Offline.") });
    const svc = new HolidayService(() => TRIED);
    const { host } = stub(CH_ZH, [2028]);
    svc.onMissing(PLAN_ID, host, [2028], "own");
    await flush();
    const list = svc.notices(PLAN_ID);
    expect(only(list).k).toBe("failed");
    const sub = vi.fn();
    svc.subscribe(sub);
    svc.onMissing(PLAN_ID, host, [2028], "own");
    svc.onMissing(PLAN_ID, host, [2028], "merge");
    expect(sub).not.toHaveBeenCalled();
    expect(svc.notices(PLAN_ID)).toBe(list);
    expect(yearCalls(0)).toBe(1);
  });

  it("a repeated merge onMissing for a notLoaded year changes nothing", () => {
    const svc = new HolidayService();
    const { host } = stub(CH_ZH, [2028]);
    svc.onMissing(PLAN_ID, host, [2028], "merge");
    const list = svc.notices(PLAN_ID);
    expect(list).toEqual([{ k: "notLoaded", year: 2028 }]);
    const sub = vi.fn();
    svc.subscribe(sub);
    svc.onMissing(PLAN_ID, host, [2028], "merge");
    expect(sub).not.toHaveBeenCalled();
    expect(svc.notices(PLAN_ID)).toBe(list);
  });
});

describe("beyond coverage", () => {
  const answers = (code: string, message: string): Answer =>
    yearAnswer((a) => (a.year === 2030 ? { days: [holidayDay("2030-01-01", "New Year's Day", "public")], coverage: [2020, 2030] } : fail(code, message)));

  it("out_of_range after a covered year opens the calendar", async () => {
    resetTauri({ holidays_year: answers("holidays.out_of_range", "OpenHolidays has holidays for 2020–2030, not 2031.") });
    const svc = new HolidayService();
    await svc.warm(CHZH, [2030]);
    const { host } = stub(CH_ZH, [2031]);
    svc.onMissing(PLAN_ID, host, [2031], "own");
    await flush();
    const n = only(svc.notices(PLAN_ID));
    expect(n.k === "failed" && n.coverage).toEqual({ from: 2020, to: 2030 });
    const t = noticeText(n);
    expect(t.text).toBe("Holidays for 2031 not available — open calendar");
    expect(t.action).toBe("calendar");
    expect(t.detail).toContain("2020–2030");
    expect(`${t.text} ${t.detail}`).not.toMatch(/no holidays|0 days/);
  });

  it("unsupported with no earlier success has no coverage", async () => {
    resetTauri({ holidays_year: () => fail("holidays.unsupported", "OpenHolidays does not list XX.") });
    const svc = new HolidayService();
    const { host } = stub(CH_ZH, [2031]);
    svc.onMissing(PLAN_ID, host, [2031], "own");
    await flush();
    const n = only(svc.notices(PLAN_ID));
    expect(n.k === "failed" && n.coverage).toBeNull();
    const t = noticeText(n);
    expect(t.text).toBe("Holidays for 2031 not available — open calendar");
    expect(t.action).toBe("calendar");
    expect(`${t.text} ${t.detail}`).not.toMatch(/no holidays|0 days/);
  });

  it.each([
    ["holidays.io", "The holiday cache could not be written."],
    ["holidays.http", "OpenHolidays answered 500."],
    ["holidays.parse", "OpenHolidays answered something unreadable."],
    ["ipc.failed", "holidays_year: kaput"],
  ])("%s opens the calendar", async (code, message) => {
    resetTauri({ holidays_year: () => fail(code, message) });
    const svc = new HolidayService(() => TRIED);
    const { host } = stub(CH_ZH, [2031]);
    svc.onMissing(PLAN_ID, host, [2031], "own");
    await flush();
    expect(noticeText(only(svc.notices(PLAN_ID)))).toEqual({
      text: "Holidays for 2031 not loaded — open calendar",
      action: "calendar",
      detail: `${message} Tried 2026-11-08 14:05.`,
    });
  });

  it.each([
    ["holidays.offline", "Offline."],
    ["holidays.rate_limited", "OpenHolidays asks to wait. Try again in 2 minutes."],
  ])("%s retries", async (code, message) => {
    resetTauri({ holidays_year: answers(code, message) });
    const svc = new HolidayService();
    await svc.warm(CHZH, [2030]);
    const { host } = stub(CH_ZH, [2031]);
    svc.onMissing(PLAN_ID, host, [2031], "own");
    await flush();
    const t = noticeText(only(svc.notices(PLAN_ID)));
    expect(t.text).toBe("Holidays for 2031 not loaded — retry");
    expect(t.action).toBe("retry");
    expect(t.detail).toContain(message);
  });
});

describe("refresh", () => {
  it("refresh failure shows", async () => {
    resetTauri({ holidays_year: yearAnswer((a) => (a.fresh ? fail("holidays.offline", "Offline.") : { days: OLD_2027 })) });
    const svc = new HolidayService(() => TODAY_NOON);
    const { host } = stub(CAL_2027, []);
    await expect(svc.refresh(PLAN_ID, host)).resolves.toBeUndefined();
    expect(freshCalls(0)).toBe(1);
    const n = only(svc.notices(PLAN_ID));
    expect(n.k).toBe("refreshFailed");
    const t = noticeText(n);
    expect(t.text).toBe("Holidays for 2027 not checked — retry");
    expect(t.action).toBe("retry");
    expect(t.detail).toBe("Offline. Last fetched 2026-11-01.");
    await svc.load(PLAN_ID, host, 2027);
    expect(freshCalls(0)).toBe(2);
    expect(only(svc.notices(PLAN_ID)).k).toBe("refreshFailed");
  });

  it("refresh diff", async () => {
    resetTauri({ holidays_year: yearAnswer(() => ({ days: NEW_2027 })) });
    const svc = new HolidayService(() => TODAY_NOON);
    const { host, preview } = stub(CAL_2027, []);
    await svc.refresh(PLAN_ID, host);
    const n = only(svc.notices(PLAN_ID));
    expect(n.k === "changed" && n.count).toBe(2);
    expect(intentOf(n).next.holidays.get(2027)?.days).toEqual(NEW_2027);
    expect(preview).toHaveBeenCalledWith(intentOf(n));
    expect(noticeText(n)).toEqual({ text: "2 days changed in the official calendar for 2027", action: "review", detail: null });
    expect(noticeText({ ...n, count: 1 } as HolidayNotice).text).toBe("1 day changed in the official calendar for 2027");
  });

  it("refresh with only a new fetchedAt records nothing", async () => {
    resetTauri({ holidays_year: yearAnswer(() => ({ days: OLD_2027, fetchedAt: FETCHED_TODAY })) });
    const svc = new HolidayService(() => TODAY_NOON);
    const { host } = stub(CAL_2027, []);
    await svc.refresh(PLAN_ID, host);
    expect(freshCalls(0)).toBe(1);
    expect(svc.notices(PLAN_ID)).toEqual([]);
  });

  it("refresh once a day", async () => {
    let now = TODAY_NOON;
    let fetchedAt = FETCHED_TODAY;
    resetTauri({ holidays_year: yearAnswer((a) => ({ days: OLD_2027, fetchedAt, fromCache: !a.fresh })) });
    const { host } = stub(CAL_2027, []);
    await new HolidayService(() => now).refresh(PLAN_ID, host);
    expect(freshCalls(0)).toBe(1);

    const svc = new HolidayService(() => now);
    await svc.warm(CHZH, [2027]);
    const from = tauri.calls.length;
    await svc.refresh(PLAN_ID, host);
    expect(freshCalls(from)).toBe(0);

    now += 24 * 3600 * 1000;
    fetchedAt = new Date(2026, 10, 10, 11).toISOString();
    await svc.refresh(PLAN_ID, host);
    expect(freshCalls(from)).toBe(1);
    await svc.refresh(PLAN_ID, host);
    expect(freshCalls(from)).toBe(1);
  });

  it("load on refreshFailed calls the same day", async () => {
    resetTauri({ holidays_year: yearAnswer((a) => (a.fresh ? fail("holidays.offline", "Offline.") : { days: OLD_2027 })) });
    const svc = new HolidayService(() => TODAY_NOON);
    const { host } = stub(CAL_2027, []);
    await svc.refresh(PLAN_ID, host);
    await svc.refresh(PLAN_ID, host);
    expect(freshCalls(0)).toBe(1);
    resetTauri({ holidays_year: yearAnswer(() => ({ days: NEW_2027, fetchedAt: FETCHED_TODAY })) });
    await svc.load(PLAN_ID, host, 2027);
    expect(freshCalls(0)).toBe(1);
    const n = only(svc.notices(PLAN_ID));
    expect(n.k === "changed" && n.count).toBe(2);
  });

  const refreshFailedNotice = async (preview?: (i: Intent) => Preview) => {
    resetTauri({ holidays_year: yearAnswer((a) => (a.fresh ? fail("holidays.offline", "Offline.") : { days: OLD_2027 })) });
    const svc = new HolidayService(() => TODAY_NOON);
    const s = stub(CAL_2027, [], preview);
    await svc.refresh(PLAN_ID, s.host);
    const n = only(svc.notices(PLAN_ID));
    expect(n.k).toBe("refreshFailed");
    const sub = vi.fn();
    svc.subscribe(sub);
    return { svc, ...s, n, sub };
  };

  const NEW_ANSWER = { days: NEW_2027, fetchedAt: FETCHED_TODAY, fromCache: false, coverage: [2020, 2030] };

  it("a forced retry after a region change drops its notice", async () => {
    const { svc, host, state, sub } = await refreshFailedNotice();
    const h = hold("holidays_year");
    const p = svc.load(PLAN_ID, host, 2027);
    state.calendar = { ...state.calendar, region: OTHER };
    h.resolve(NEW_ANSWER);
    await p;
    expect(svc.notices(PLAN_ID).some((n) => n.year === 2027)).toBe(false);
    expect(sub).toHaveBeenCalledTimes(1);
  });

  it("a forced retry dismissed in flight records nothing", async () => {
    const { svc, host, sub } = await refreshFailedNotice();
    const h = hold("holidays_year");
    const p = svc.load(PLAN_ID, host, 2027);
    svc.dismiss(PLAN_ID, 2027);
    expect(sub).toHaveBeenCalledTimes(1);
    h.resolve(NEW_ANSWER);
    await p;
    expect(svc.notices(PLAN_ID)).toEqual([]);
    expect(sub).toHaveBeenCalledTimes(1);
  });

  it("preview throws on a forced retry", async () => {
    const { svc, host, sub } = await refreshFailedNotice(() => {
      throw new Error("boom");
    });
    resetTauri({ holidays_year: yearAnswer(() => ({ days: NEW_2027, fetchedAt: FETCHED_TODAY })) });
    await expect(svc.load(PLAN_ID, host, 2027)).rejects.toThrow("boom");
    expect(svc.notices(PLAN_ID)).toEqual([]);
    expect(sub).toHaveBeenCalledTimes(1);
  });

  it("a slow cache answer does not replace a fresher year", async () => {
    const svc = new HolidayService(() => TODAY_NOON);
    const h = hold("holidays_year");
    const draft = svc.draftYears(CHZH, [2027]);
    tauri.answers.holidays_year = yearAnswer(() => ({ days: NEW_2027, fetchedAt: FETCHED_TODAY }));
    const { host } = stub(CAL_2027, []);
    await svc.refresh(PLAN_ID, host);
    expect(freshCalls(0)).toBe(1);
    expect(svc.cached(RK, 2027)?.fetchedAt).toBe(FETCHED_TODAY);
    h.resolve({ days: OLD_2027, fetchedAt: new Date(2026, 10, 9, 8).toISOString(), fromCache: true, coverage: [2020, 2030] });
    const got = await draft;
    expect(svc.cached(RK, 2027)?.fetchedAt).toBe(FETCHED_TODAY);
    expect(svc.cached(RK, 2027)?.days).toEqual(NEW_2027);
    expect(got.get(2027)).toBe(svc.cached(RK, 2027));
  });

  it("second plan same day", async () => {
    resetTauri({ holidays_year: yearAnswer(() => ({ days: NEW_2027, fetchedAt: FETCHED_TODAY })) });
    const svc = new HolidayService(() => TODAY_NOON);
    const a = stub(CAL_2027, []);
    const b = stub(CAL_2027, []);
    await svc.refresh("A", a.host);
    expect(freshCalls(0)).toBe(1);
    const na = only(svc.notices("A"));
    expect(na.k === "changed" && na.count).toBe(2);
    const from = tauri.calls.length;
    await svc.refresh("B", b.host);
    expect(yearCalls(from)).toBe(0);
    const nb = only(svc.notices("B"));
    expect(nb.k === "changed" && nb.count).toBe(2);
    expect(intentOf(nb).base).toBe(b.host.view().plan.calendar);
    const c = stub(withYear(CH_ZH, 2027, NEW_2027, "2026-11-02T00:00:00Z"), []);
    c.state.calendar = { ...c.state.calendar, holidays: new Map([[2027, c.state.calendar.holidays.get(2027) as HolidayYear]]) };
    await svc.refresh("C", c.host);
    expect(yearCalls(from)).toBe(0);
    expect(svc.notices("C")).toEqual([]);
  });

  it("new service same day", async () => {
    resetTauri({ holidays_year: yearAnswer(() => ({ days: NEW_2027, fetchedAt: FETCHED_TODAY, fromCache: true })) });
    const svc = new HolidayService(() => TODAY_NOON);
    await svc.warm(CHZH, [2027]);
    const from = tauri.calls.length;
    const b = stub(CAL_2027, []);
    await svc.refresh("B", b.host);
    expect(freshCalls(from)).toBe(0);
    const nb = only(svc.notices("B"));
    expect(nb.k === "changed" && nb.count).toBe(2);
  });

  it("held failure for every plan", async () => {
    resetTauri({ holidays_year: () => fail("holidays.offline", "Offline.") });
    const svc = new HolidayService(() => TODAY_NOON);
    const a = stub(CAL_2027, []);
    const b = stub(CAL_2027, []);
    await svc.refresh("A", a.host);
    const na = only(svc.notices("A"));
    expect(na.k).toBe("refreshFailed");
    const from = tauri.calls.length;
    await svc.refresh("B", b.host);
    expect(yearCalls(from)).toBe(0);
    const nb = only(svc.notices("B"));
    if (na.k !== "refreshFailed" || nb.k !== "refreshFailed") throw new Error("expected refreshFailed");
    expect(nb.error).toBe(na.error);
    expect(nb.at).toBe(na.at);
  });
});

describe("diffDays", () => {
  const arbDay = fc.record({
    date: fc.constantFrom("2027-01-01", "2027-01-02", "2027-03-26", "2027-05-06"),
    name: fc.constantFrom("A", "B"),
    kind: fc.constantFrom<HolidayDay["kind"]>("public", "optional", "half"),
    sourceId: fc.constantFrom("x", "y"),
    scope: fc.constantFrom<string | null>(null, "Municipality of Zürich"),
  });

  it("is zero on equal input and symmetric", () => {
    fc.assert(
      fc.property(fc.array(arbDay, { maxLength: 6 }), fc.array(arbDay, { maxLength: 6 }), (a, b) => {
        expect(diffDays(a, a)).toBe(0);
        expect(diffDays(a, [...a].reverse())).toBe(0);
        expect(diffDays(a, b)).toBe(diffDays(b, a));
      }),
    );
  });

  it("counts renamed, added and removed dates", () => {
    expect(diffDays(OLD_2027, NEW_2027)).toBe(2);
    expect(diffDays(OLD_2027, OLD_2027.slice(1))).toBe(1);
    expect(diffDays(OLD_2027, OLD_2027.map((d) => ({ ...d, sourceId: "other", scope: "x" })))).toBe(0);
    expect(diffDays(OLD_2027, OLD_2027.map((d) => (d.date === "2027-01-01" ? { ...d, kind: "optional" as const } : d)))).toBe(1);
  });
});

describe("notice keeps later edits (refinement 34)", () => {
  const TODAY = "2026-11-09";
  const closure = { u: "cc:k1", v: ["2026-12-24", "2026-12-31", "Office closed"], c: "own" as const };

  const planLog = (): LogState => {
    const log = new LogState(planRules);
    log.add([initialAction({ dev: "d1", ses: "s-d1", now: 0, name: "Plan", calendar: CAL_2027 })]);
    return log;
  };

  const hostOf = (log: LogState): HolidayHost => ({
    view: () => ctxOf(log, "d1", TODAY).view,
    preview: (i) => buildAction(ctxOf(log, "d1", TODAY), i).preview,
  });

  it("a ready notice writes only its year", async () => {
    const log = planLog();
    const host = hostOf(log);
    expect(host.view().plan.calendar.holidays.has(2028)).toBe(false);
    const h = hold("holidays_year");
    const svc = new HolidayService();
    svc.onMissing(PLAN_ID, host, [2028], "own");
    const seen = host.view().plan.calendar;
    h.resolve({ days: DAYS_2028, fetchedAt: FETCHED_AT, fromCache: false, coverage: [2020, 2030] });
    await flush();
    const n = only(svc.notices(PLAN_ID));
    expect(n.k).toBe("ready");
    const intent = intentOf(n);
    expect(intent.base).toEqual(seen);
    expect({ ...intent.next, holidays: new Map([...intent.next.holidays].filter(([y]) => y !== 2028)) }).toEqual(seen);
    log.add([act("c1", log.heads, [closure])]);
    const built = buildAction(ctxOf(log, "d1", TODAY), intent);
    expect(built.action.w.map((w) => w.u)).toEqual(["ch:2028"]);
    log.add([built.action]);
    const cal = projectPlan(PLAN_ID, log).calendar;
    expect(cal.closures.get("k1")).toEqual({ id: "k1", from: "2026-12-24", to: "2026-12-31", name: "Office closed" });
    expect(cal.holidays.get(2028)?.days).toEqual(DAYS_2028);
  });

  it("a changed notice writes only its year", async () => {
    resetTauri({ holidays_year: yearAnswer(() => ({ days: NEW_2027 })) });
    const log = planLog();
    const host = hostOf(log);
    const svc = new HolidayService(() => TODAY_NOON);
    await svc.refresh(PLAN_ID, host);
    const n = only(svc.notices(PLAN_ID));
    expect(n.k).toBe("changed");
    const intent = intentOf(n);
    expect(intent.base).toEqual(host.view().plan.calendar);
    log.add([act("c1", log.heads, [closure])]);
    const built = buildAction(ctxOf(log, "d1", TODAY), intent);
    expect(built.action.w.map((w) => w.u)).toEqual(["ch:2027"]);
    log.add([built.action]);
    const cal = projectPlan(PLAN_ID, log).calendar;
    expect(cal.closures.get("k1")).toEqual({ id: "k1", from: "2026-12-24", to: "2026-12-31", name: "Office closed" });
    expect(cal.holidays.get(2027)?.days).toEqual(NEW_2027);
  });
});

describe("reconcile (refinement 42)", () => {
  it("reconcile drops settled notices", () => {
    const svc = new HolidayService();
    const { host, state } = stub(CH_ZH, [2028]);
    svc.onMissing(PLAN_ID, host, [2028], "merge");
    expect(svc.notices(PLAN_ID)).toEqual([{ k: "notLoaded", year: 2028 }]);
    const sub = vi.fn();
    svc.subscribe(sub);
    state.missing = [];
    svc.reconcile(PLAN_ID, host);
    expect(svc.notices(PLAN_ID).some((n) => n.year === 2028)).toBe(false);
    expect(sub).toHaveBeenCalledTimes(1);
    svc.reconcile(PLAN_ID, host);
    expect(sub).toHaveBeenCalledTimes(1);
  });

  it("reconcile drops a failed notice once the year is no longer missing", async () => {
    resetTauri({ holidays_year: () => fail("holidays.offline", "Offline.") });
    const svc = new HolidayService();
    const { host, state } = stub(CH_ZH, [2028]);
    svc.onMissing(PLAN_ID, host, [2028], "own");
    await flush();
    expect(only(svc.notices(PLAN_ID)).k).toBe("failed");
    state.missing = [];
    svc.reconcile(PLAN_ID, host);
    expect(svc.notices(PLAN_ID)).toEqual([]);
  });

  const readyNotice = async () => {
    resetTauri({ holidays_year: yearAnswer(() => ({ days: DAYS_2028 })) });
    const svc = new HolidayService();
    const s = stub(CH_ZH, [2028]);
    svc.onMissing(PLAN_ID, s.host, [2028], "own");
    await flush();
    const n = only(svc.notices(PLAN_ID));
    expect(n.k).toBe("ready");
    const sub = vi.fn();
    svc.subscribe(sub);
    return { svc, ...s, n, sub };
  };

  it("reconcile drops an applied ready", async () => {
    const { svc, host, state, n, sub } = await readyNotice();
    state.calendar = withYear(CH_ZH, 2028, intentOf(n).next.holidays.get(2028)?.days ?? [], "2026-12-01T00:00:00Z");
    state.missing = [];
    svc.reconcile(PLAN_ID, host);
    expect(svc.notices(PLAN_ID)).toEqual([]);
    expect(sub).toHaveBeenCalledTimes(1);
  });

  it("reconcile drops a ready whose year moved on", async () => {
    const { svc, host, state, sub } = await readyNotice();
    state.calendar = withYear(CH_ZH, 2028, DAYS_2028.map((d, i) => (i === 0 ? { ...d, name: "Neujahr" } : d)), "2026-12-01T00:00:00Z");
    state.missing = [];
    svc.reconcile(PLAN_ID, host);
    expect(svc.notices(PLAN_ID)).toEqual([]);
    expect(sub).toHaveBeenCalledTimes(1);
  });

  it("a ready notice whose year is untouched stays", async () => {
    const { svc, host, n, sub } = await readyNotice();
    svc.reconcile(PLAN_ID, host);
    expect(svc.notices(PLAN_ID)).toEqual([n]);
    expect(sub).not.toHaveBeenCalled();
  });

  it("reconcile drops a ready when the plan's region changes", async () => {
    const { svc, host, state, sub } = await readyNotice();
    state.calendar = { ...state.calendar, region: OTHER };
    svc.reconcile(PLAN_ID, host);
    expect(svc.notices(PLAN_ID)).toEqual([]);
    expect(sub).toHaveBeenCalledTimes(1);
  });

  const changedNotice = async () => {
    resetTauri({ holidays_year: yearAnswer(() => ({ days: NEW_2027 })) });
    const svc = new HolidayService(() => TODAY_NOON);
    const s = stub(CAL_2027, []);
    await svc.refresh(PLAN_ID, s.host);
    const n = only(svc.notices(PLAN_ID));
    expect(n.k).toBe("changed");
    const sub = vi.fn();
    svc.subscribe(sub);
    return { svc, ...s, n, sub };
  };

  it("reconcile drops an applied changed", async () => {
    const { svc, host, state, sub } = await changedNotice();
    state.calendar = withYear(CAL_2027, 2027, NEW_2027, "2026-12-01T00:00:00Z");
    svc.reconcile(PLAN_ID, host);
    expect(svc.notices(PLAN_ID)).toEqual([]);
    expect(sub).toHaveBeenCalledTimes(1);
  });

  it("reconcile drops a changed whose year moved on", async () => {
    const { svc, host, state, sub } = await changedNotice();
    state.calendar = withYear(CAL_2027, 2027, NEW_2027.map((d, i) => (i === 0 ? { ...d, name: "Neujahr" } : d)), "2026-12-01T00:00:00Z");
    svc.reconcile(PLAN_ID, host);
    expect(svc.notices(PLAN_ID)).toEqual([]);
    expect(sub).toHaveBeenCalledTimes(1);
  });

  it("a changed notice whose year is untouched stays", async () => {
    const { svc, host, state, n, sub } = await changedNotice();
    state.calendar = withYear(CAL_2027, 2027, OLD_2027, "2026-12-01T00:00:00Z");
    svc.reconcile(PLAN_ID, host);
    expect(svc.notices(PLAN_ID)).toEqual([n]);
    expect(sub).not.toHaveBeenCalled();
  });

  it("reconcile drops a changed when the plan loses its region", async () => {
    const { svc, host, state, sub } = await changedNotice();
    state.calendar = { ...state.calendar, region: null };
    svc.reconcile(PLAN_ID, host);
    expect(svc.notices(PLAN_ID)).toEqual([]);
    expect(sub).toHaveBeenCalledTimes(1);
  });

  it("reconcile drops a changed when the plan's region changes", async () => {
    const { svc, host, state, sub } = await changedNotice();
    state.calendar = { ...state.calendar, region: OTHER };
    svc.reconcile(PLAN_ID, host);
    expect(svc.notices(PLAN_ID)).toEqual([]);
    expect(sub).toHaveBeenCalledTimes(1);
  });

  const refreshFailed = async () => {
    resetTauri({ holidays_year: () => fail("holidays.offline", "Offline.") });
    const svc = new HolidayService(() => TODAY_NOON);
    const s = stub(CAL_2027, []);
    await svc.refresh(PLAN_ID, s.host);
    const n = only(svc.notices(PLAN_ID));
    expect(n.k).toBe("refreshFailed");
    const sub = vi.fn();
    svc.subscribe(sub);
    return { svc, ...s, n, sub };
  };

  it("a refreshFailed notice whose year is untouched stays", async () => {
    const { svc, host, n, sub } = await refreshFailed();
    svc.reconcile(PLAN_ID, host);
    expect(svc.notices(PLAN_ID)).toEqual([n]);
    expect(sub).not.toHaveBeenCalled();
  });

  it.each<[string, (cal: Calendar) => Calendar]>([
    ["the plan loses its region", (cal) => ({ ...cal, region: null })],
    ["the plan's region changes", (cal) => ({ ...cal, region: OTHER })],
    ["its year is removed", (cal) => ({ ...cal, holidays: new Map() })],
    ["its year comes from another region", (cal) => ({ ...cal, holidays: new Map([[2027, { ...CH_ZH_2027, region: "oh:CH:CH-BE", fetchedAt: LAST_FETCHED }]]) })],
    ["its year carries another fetchedAt", (cal) => withYear(cal, 2027, OLD_2027, FETCHED_TODAY)],
  ])("reconcile drops a refreshFailed when %s", async (_, change) => {
    const { svc, host, state, sub } = await refreshFailed();
    state.calendar = change(state.calendar);
    svc.reconcile(PLAN_ID, host);
    expect(svc.notices(PLAN_ID)).toEqual([]);
    expect(sub).toHaveBeenCalledTimes(1);
  });

  it("late fetch after drop", async () => {
    const h = hold("holidays_year");
    const svc = new HolidayService();
    const { host, state, preview } = stub(CH_ZH, [2028]);
    svc.onMissing(PLAN_ID, host, [2028], "own");
    expect(svc.notices(PLAN_ID)).toEqual([{ k: "loading", year: 2028 }]);
    state.missing = [];
    svc.reconcile(PLAN_ID, host);
    expect(svc.notices(PLAN_ID)).toEqual([]);
    h.resolve({ days: DAYS_2028, fetchedAt: FETCHED_AT, fromCache: false, coverage: [2020, 2030] });
    await flush();
    expect(svc.notices(PLAN_ID)).toEqual([]);
    expect(preview).not.toHaveBeenCalled();
  });

  it("a dismissed notice is gone and its late fetch records nothing", async () => {
    const h = hold("holidays_year");
    const svc = new HolidayService();
    const { host } = stub(CH_ZH, [2028]);
    svc.onMissing(PLAN_ID, host, [2028], "own");
    const sub = vi.fn();
    svc.subscribe(sub);
    svc.dismiss(PLAN_ID, 2028);
    expect(svc.notices(PLAN_ID)).toEqual([]);
    expect(sub).toHaveBeenCalledTimes(1);
    h.reject({ code: "holidays.offline", message: "Offline." });
    await flush();
    expect(svc.notices(PLAN_ID)).toEqual([]);
    expect(sub).toHaveBeenCalledTimes(1);
  });
});

describe("draftYears (refinement 43)", () => {
  it("answers from the cache first", async () => {
    resetTauri({ holidays_year: yearAnswer(() => ({ days: OLD_2027 })) });
    const svc = new HolidayService();
    await svc.warm(CHZH, [2027]);
    const from = tauri.calls.length;
    const got = await svc.draftYears(CHZH, [2027]);
    expect(got.get(2027)).toEqual(svc.cached(RK, 2027));
    expect(yearCalls(from)).toBe(0);
  });

  it("returns each year's error and records no notice", async () => {
    resetTauri({ holidays_year: yearAnswer((a) => (a.year === 2028 ? fail("holidays.offline", "Offline.") : { days: OLD_2027 })) });
    const svc = new HolidayService();
    await svc.warm(CHZH, [2027]);
    const { host: other } = stub(CH_ZH, [2029]);
    svc.onMissing("Q", other, [2029], "merge");
    const before = svc.notices("Q");
    const sub = vi.fn();
    svc.subscribe(sub);
    const got = await svc.draftYears(CHZH, [2027, 2028]);
    expect(got.get(2027)).toEqual(svc.cached(RK, 2027));
    const e = got.get(2028);
    expect(e).toBeInstanceOf(AppError);
    expect(e).toMatchObject({ code: "holidays.offline", message: "Offline." });
    expect(svc.notices(PLAN_ID)).toEqual([]);
    expect(svc.notices("Q")).toBe(before);
    expect(sub).not.toHaveBeenCalled();
    const { host } = stub(CH_ZH, [2028]);
    svc.onMissing(PLAN_ID, host, [2028], "merge");
    expect(noticeText(only(svc.notices(PLAN_ID))).text).toBe("Holidays for 2028 not loaded — load");
  });

  it("a successful draft year enters the cache", async () => {
    resetTauri({ holidays_year: yearAnswer(() => ({ days: DAYS_2028 })) });
    const svc = new HolidayService();
    await svc.draftYears(CHZH, [2028]);
    expect(svc.cached(RK, 2028)?.days).toEqual(DAYS_2028);
    expect(commandsWith(0, "holidays_year", { fresh: false })).toBe(1);
  });

  it("a throw that is not a CommandError still resolves", async () => {
    resetTauri({
      holidays_year: () => {
        throw new Error("kaput");
      },
    });
    const svc = new HolidayService();
    const got = await svc.draftYears(CHZH, [2027]);
    const e = got.get(2027);
    expect(e).toBeInstanceOf(AppError);
    expect(e).toMatchObject({ code: "ipc.failed", message: "holidays_year: kaput" });
  });
});
