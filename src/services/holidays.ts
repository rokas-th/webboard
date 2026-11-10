import type { Intent, Preview } from "../actions/intents";
import { regionKey, type Calendar, type HolidayDay, type HolidayYear, type RegionRef } from "../domain/calendar";
import { localToday, type IsoDate } from "../domain/dates";
import type { PlanId } from "../domain/model";
import { planRules } from "../plan/rules";
import { key } from "../plan/units";
import type { PlanView } from "../store/doc";
import { notifyEach } from "./clock";
import { AppError, call } from "./ipc";

export type HolidayNotice =
  | { k: "loading" | "notLoaded"; year: number }
  | { k: "ready" | "changed"; year: number; count: number; intent: Intent; preview: Preview }
  | { k: "failed"; year: number; error: AppError; coverage: { from: number; to: number } | null; at: number }
  | { k: "refreshFailed"; year: number; error: AppError; at: number; fetchedAt: string };

export interface HolidayHost {
  view(): PlanView;
  preview(i: Intent): Preview;
}

interface YearAnswer {
  days: HolidayDay[];
  fetchedAt: string;
  fromCache: boolean;
  coverage: [number, number] | null;
}

type Fetched = { ok: true; year: HolidayYear } | { ok: false; error: AppError; at: number };

interface Entry {
  notice: HolidayNotice;
}

const TRANSIENT: ReadonlySet<string> = new Set(["holidays.offline", "holidays.rate_limited"]);

export const NOT_AVAILABLE: ReadonlySet<string> = new Set(["holidays.unsupported", "holidays.out_of_range"]);

const NO_NOTICES: readonly HolidayNotice[] = Object.freeze([]);

const pad = (n: number): string => String(n).padStart(2, "0");

const timeOf = (at: number): string => {
  const d = new Date(at);
  return `${localToday(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

const dayOf = (stamp: string): IsoDate => {
  if (/^\d{4}-\d{2}-\d{2}$/.test(stamp)) return stamp;
  const d = new Date(stamp);
  if (Number.isNaN(d.getTime())) throw new Error(`fetchedAt is not a time: ${stamp}`);
  return localToday(d);
};

export function noticeText(n: HolidayNotice): { text: string; action: "review" | "load" | "retry" | "calendar" | null; detail: string | null } {
  switch (n.k) {
    case "loading":
      return { text: `Holidays for ${n.year} loading`, action: null, detail: null };
    case "notLoaded":
      return { text: `Holidays for ${n.year} not loaded — load`, action: "load", detail: null };
    case "ready":
      return { text: `Holidays for ${n.year} ready — review`, action: "review", detail: null };
    case "changed":
      return { text: `${n.count} ${n.count === 1 ? "day" : "days"} changed in the official calendar for ${n.year}`, action: "review", detail: null };
    case "failed": {
      const detail = `${n.error.message} Tried ${timeOf(n.at)}.`;
      if (TRANSIENT.has(n.error.code)) return { text: `Holidays for ${n.year} not loaded — retry`, action: "retry", detail };
      if (NOT_AVAILABLE.has(n.error.code)) return { text: `Holidays for ${n.year} not available — open calendar`, action: "calendar", detail };
      return { text: `Holidays for ${n.year} not loaded — open calendar`, action: "calendar", detail };
    }
    case "refreshFailed":
      return { text: `Holidays for ${n.year} not checked — retry`, action: "retry", detail: `${n.error.message} Last fetched ${dayOf(n.fetchedAt)}.` };
  }
}

const dayKeys = (days: readonly HolidayDay[]): Map<IsoDate, string> => {
  const grouped = days.reduce((m, d) => m.set(d.date, [...(m.get(d.date) ?? []), `${d.kind}\u0000${d.name}`]), new Map<IsoDate, string[]>());
  return new Map([...grouped].map(([date, ks]) => [date, [...ks].sort().join("\u0001")]));
};

export function diffDays(a: readonly HolidayDay[], b: readonly HolidayDay[]): number {
  const ka = dayKeys(a);
  const kb = dayKeys(b);
  return new Set([...ka.keys(), ...kb.keys()]).size - [...ka].filter(([date, k]) => kb.get(date) === k).length;
}

const slot = (region: string, year: number): string => `${region}\u0000${year}`;

const sameYear = (year: number, a: HolidayYear | null, b: HolidayYear | null): boolean => planRules.same(key.ch(year), a, b);

const unchanged = (a: HolidayNotice | undefined, b: HolidayNotice): boolean => {
  if (a === undefined || a.k !== b.k || a.year !== b.year) return false;
  if (a.k === "failed" && b.k === "failed") return a.error === b.error && a.at === b.at;
  if (a.k === "refreshFailed" && b.k === "refreshFailed") return a.error === b.error && a.at === b.at && a.fetchedAt === b.fetchedAt;
  return a.k === "loading" || a.k === "notLoaded";
};

const isYearAnswer = (a: unknown): a is YearAnswer =>
  typeof a === "object" &&
  a !== null &&
  "days" in a &&
  Array.isArray(a.days) &&
  "fetchedAt" in a &&
  typeof a.fetchedAt === "string" &&
  !Number.isNaN(Date.parse(a.fetchedAt)) &&
  "fromCache" in a &&
  typeof a.fromCache === "boolean" &&
  "coverage" in a &&
  (a.coverage === null || (Array.isArray(a.coverage) && a.coverage.length === 2 && a.coverage.every(Number.isInteger)));

export class HolidayService {
  private readonly now: () => number;
  private readonly cache = new Map<string, HolidayYear>();
  private readonly coverage = new Map<string, { from: number; to: number }>();
  private readonly failures = new Map<string, { error: AppError; at: number }>();
  private readonly refreshFailures = new Map<string, { error: AppError; at: number }>();
  private readonly inflight = new Map<string, Promise<Fetched>>();
  private readonly entries = new Map<PlanId, Map<number, Entry>>();
  private readonly lists = new Map<PlanId, readonly HolidayNotice[]>();
  private readonly withdrawn = new WeakSet<HolidayHost>();
  private readonly subscribers = new Set<() => void>();

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  cached(region: string, year: number): HolidayYear | null {
    return this.cache.get(slot(region, year)) ?? null;
  }

  async warm(region: RegionRef, years: readonly number[]): Promise<void> {
    const rk = regionKey(region);
    await Promise.all(
      [...new Set(years)]
        .filter((y) => this.cached(rk, y) === null)
        .map(async (y) => {
          const r = await this.fetch(region, y, false);
          if (!r.ok) this.failures.set(slot(rk, y), { error: r.error, at: r.at });
        }),
    );
  }

  notices(plan: PlanId): readonly HolidayNotice[] {
    return this.lists.get(plan) ?? NO_NOTICES;
  }

  subscribe(cb: () => void): () => void {
    this.subscribers.add(cb);
    return () => {
      this.subscribers.delete(cb);
    };
  }

  onMissing(plan: PlanId, host: HolidayHost, years: readonly number[], cause: "own" | "merge"): void {
    this.hosting(plan, host);
    const region = host.view().plan.calendar.region;
    if (region === null) {
      if (years.length === 0) return;
      throw new Error(`Plan ${plan} has no holiday region but ${years.join(", ")} are missing`);
    }
    const todo = [...new Set(years)].filter((y) => {
      const k = this.entry(plan, y)?.notice.k;
      return k !== "loading" && k !== "ready";
    });
    const started: number[] = [];
    let changed: boolean[];
    try {
      changed = todo.map((y) => this.missingYear(plan, host, region, y, cause, started));
    } catch (e) {
      started.forEach((y) => this.drop(plan, y));
      this.notify();
      throw e;
    }
    if (changed.some((c) => c)) this.notify();
    started.forEach((y) => {
      void this.fetchMissing(plan, host, region, y);
    });
  }

  async load(plan: PlanId, host: HolidayHost, year: number): Promise<void> {
    this.hosting(plan, host);
    const region = host.view().plan.calendar.region;
    if (region === null) throw new Error(`Plan ${plan} has no holiday region to load ${year} for`);
    const current = this.entry(plan, year);
    if (current?.notice.k === "refreshFailed") {
      await this.refreshYear(plan, host, region, year, true);
      return;
    }
    this.failures.delete(slot(regionKey(region), year));
    this.put(plan, { k: "loading", year });
    this.notify();
    await this.fetchMissing(plan, host, region, year);
  }

  async refresh(plan: PlanId, host: HolidayHost): Promise<void> {
    const cal = host.view().plan.calendar;
    const region = cal.region;
    if (region === null) return;
    const rk = regionKey(region);
    await Promise.all(
      [...cal.holidays]
        .filter(([, h]) => h.region === rk)
        .map(([y]) => this.refreshYear(plan, host, region, y, false)),
    );
  }

  dismiss(plan: PlanId, year: number): void {
    if (this.drop(plan, year)) this.notify();
  }

  forget(plan: PlanId, host: HolidayHost): void {
    this.withdrawn.add(host);
    if (!this.entries.delete(plan)) return;
    this.relist(plan);
    this.notify();
  }

  private hosting(plan: PlanId, host: HolidayHost): void {
    if (this.withdrawn.has(host)) throw new Error(`Plan ${plan} was closed; its holidays are no longer tracked`);
  }

  reconcile(plan: PlanId, host: HolidayHost): void {
    const m = this.entries.get(plan);
    if (m === undefined) return;
    const view = host.view();
    const missing = new Set(view.derived.missingYears);
    const region = view.plan.calendar.region;
    const rk = region === null ? null : regionKey(region);
    const settled = [...m.values()]
      .map((e) => e.notice)
      .filter((n) => {
        const planYear = view.plan.calendar.holidays.get(n.year) ?? null;
        switch (n.k) {
          case "loading":
          case "notLoaded":
          case "failed":
            return !missing.has(n.year);
          case "ready":
          case "changed": {
            if (n.intent.t !== "calendar" || n.intent.base === undefined) throw new Error(`Holiday notice for ${n.year} carries no calendar intent with a base`);
            const next = n.intent.next.holidays.get(n.year) ?? null;
            const before = n.intent.base.holidays.get(n.year) ?? null;
            return sameYear(n.year, next, planYear) || !sameYear(n.year, before, planYear) || rk === null || next === null || next.region !== rk;
          }
          case "refreshFailed":
            return rk === null || planYear === null || planYear.region !== rk || planYear.fetchedAt !== n.fetchedAt;
        }
      });
    settled.forEach((n) => this.drop(plan, n.year));
    if (settled.length > 0) this.notify();
  }

  async draftYears(region: RegionRef, years: readonly number[]): Promise<ReadonlyMap<number, HolidayYear | AppError>> {
    const rk = regionKey(region);
    const answers = await Promise.all(
      [...new Set(years)].map(async (y): Promise<[number, HolidayYear | AppError]> => {
        const c = this.cached(rk, y);
        if (c !== null) return [y, c];
        const r = await this.fetch(region, y, false);
        return [y, r.ok ? r.year : r.error];
      }),
    );
    return new Map(answers);
  }

  private missingYear(plan: PlanId, host: HolidayHost, region: RegionRef, year: number, cause: "own" | "merge", started: number[]): boolean {
    const rk = regionKey(region);
    const cachedYear = this.cached(rk, year);
    if (cachedYear !== null) {
      if (cause === "own") return false;
      const before = this.entry(plan, year);
      try {
        return this.arrive(plan, host, region, year, null, cachedYear);
      } catch (e) {
        if (before !== undefined && this.entry(plan, year) === before) this.drop(plan, year);
        throw e;
      }
    }
    const failure = this.failures.get(slot(rk, year));
    if (failure !== undefined) return this.write(plan, { k: "failed", year, error: failure.error, coverage: this.coverage.get(rk) ?? null, at: failure.at });
    if (cause === "merge") return this.write(plan, { k: "notLoaded", year });
    this.put(plan, { k: "loading", year });
    started.push(year);
    return true;
  }

  private async fetchMissing(plan: PlanId, host: HolidayHost, region: RegionRef, year: number): Promise<void> {
    const token = this.entry(plan, year);
    try {
      const rk = regionKey(region);
      const cachedYear = this.cached(rk, year);
      const r: Fetched = cachedYear !== null ? { ok: true, year: cachedYear } : await this.fetch(region, year, false);
      if (token === undefined || this.entry(plan, year) !== token) return;
      if (r.ok) {
        if (this.arrive(plan, host, region, year, token, r.year)) this.notify();
        return;
      }
      this.failures.set(slot(rk, year), { error: r.error, at: r.at });
      this.put(plan, { k: "failed", year, error: r.error, coverage: this.coverage.get(rk) ?? null, at: r.at });
      this.notify();
    } catch (e) {
      this.abandon(plan, year, token);
      throw e;
    }
  }

  private arrive(plan: PlanId, host: HolidayHost, region: RegionRef, year: number, token: Entry | null, fetched: HolidayYear): boolean {
    const base = host.view().plan.calendar;
    if (base.region === null || regionKey(base.region) !== regionKey(region) || sameYear(year, fetched, base.holidays.get(year) ?? null)) {
      return token !== null && this.drop(plan, year);
    }
    const intent = this.intentFor(base, year, fetched);
    const preview = host.preview(intent);
    this.put(plan, { k: "ready", year, count: fetched.days.length, intent, preview });
    return true;
  }

  private async refreshYear(plan: PlanId, host: HolidayHost, region: RegionRef, year: number, forced: boolean): Promise<void> {
    const token = this.entry(plan, year);
    try {
      const rk = regionKey(region);
      const s = slot(rk, year);
      const today = localToday(new Date(this.now()));
      const held = this.refreshFailures.get(s);
      const c = this.cached(rk, year);
      const r: Fetched = forced
        ? await this.fetch(region, year, true)
        : held !== undefined && localToday(new Date(held.at)) === today
          ? { ok: false, error: held.error, at: held.at }
          : c !== null && dayOf(c.fetchedAt) === today
            ? { ok: true, year: c }
            : await this.fetch(region, year, true);
      if (this.withdrawn.has(host) || this.entry(plan, year) !== token) return;
      const base = host.view().plan.calendar;
      const planYear = base.holidays.get(year) ?? null;
      if (base.region === null || regionKey(base.region) !== rk || planYear === null || planYear.region !== rk) {
        if (this.drop(plan, year)) this.notify();
        return;
      }
      if (!r.ok) {
        if (this.write(plan, { k: "refreshFailed", year, error: r.error, at: r.at, fetchedAt: planYear.fetchedAt })) this.notify();
        return;
      }
      if (sameYear(year, r.year, planYear)) {
        if (this.drop(plan, year)) this.notify();
        return;
      }
      const intent = this.intentFor(base, year, r.year);
      const preview = host.preview(intent);
      this.put(plan, { k: "changed", year, count: diffDays(planYear.days, r.year.days), intent, preview });
      this.notify();
    } catch (e) {
      this.abandon(plan, year, token);
      throw e;
    }
  }

  private intentFor(base: Calendar, year: number, fetched: HolidayYear): Intent {
    const holidays = new Map(base.holidays);
    holidays.set(year, fetched);
    return { t: "calendar", next: { ...base, holidays }, base };
  }

  private fetch(region: RegionRef, year: number, fresh: boolean): Promise<Fetched> {
    const rk = regionKey(region);
    const id = `${fresh ? "fresh" : "cache"}\u0000${slot(rk, year)}`;
    const running = this.inflight.get(id);
    if (running !== undefined) return running;
    const p = this.request(region, year, fresh).finally(() => this.inflight.delete(id));
    this.inflight.set(id, p);
    return p;
  }

  private async request(region: RegionRef, year: number, fresh: boolean): Promise<Fetched> {
    const rk = regionKey(region);
    const s = slot(rk, year);
    const answer = await call<unknown>("holidays_year", { region, year, fresh }).then(
      (a): unknown => a,
      (e: unknown): AppError => {
        if (e instanceof AppError) return e;
        throw e;
      },
    );
    if (answer instanceof AppError) {
      const failure = { error: answer, at: this.now() };
      if (fresh) this.refreshFailures.set(s, failure);
      return { ok: false, ...failure };
    }
    if (!isYearAnswer(answer)) throw new AppError("ipc.shape", `holidays_year answered an unexpected shape for ${rk} ${year}`);
    const got: HolidayYear = { region: rk, year, days: answer.days, fetchedAt: answer.fetchedAt };
    const prev = this.cache.get(s);
    const kept = prev !== undefined && Date.parse(prev.fetchedAt) > Date.parse(got.fetchedAt) ? prev : got;
    this.cache.set(s, kept);
    if (answer.coverage !== null) this.coverage.set(rk, { from: answer.coverage[0], to: answer.coverage[1] });
    this.failures.delete(s);
    if (fresh) this.refreshFailures.delete(s);
    return { ok: true, year: kept };
  }

  private entry(plan: PlanId, year: number): Entry | undefined {
    return this.entries.get(plan)?.get(year);
  }

  private write(plan: PlanId, notice: HolidayNotice): boolean {
    if (unchanged(this.entry(plan, notice.year)?.notice, notice)) return false;
    this.put(plan, notice);
    return true;
  }

  private abandon(plan: PlanId, year: number, token: Entry | undefined): void {
    if (token !== undefined && this.entry(plan, year) === token && this.drop(plan, year)) this.notify();
  }

  private put(plan: PlanId, notice: HolidayNotice): void {
    const m = this.entries.get(plan) ?? new Map<number, Entry>();
    this.entries.set(plan, m.set(notice.year, { notice }));
    this.relist(plan);
  }

  private drop(plan: PlanId, year: number): boolean {
    const m = this.entries.get(plan);
    if (m === undefined || !m.delete(year)) return false;
    this.relist(plan);
    return true;
  }

  private relist(plan: PlanId): void {
    const m = this.entries.get(plan);
    if (m === undefined || m.size === 0) {
      this.entries.delete(plan);
      this.lists.delete(plan);
      return;
    }
    this.lists.set(
      plan,
      [...m.values()].map((e) => e.notice).sort((a, b) => a.year - b.year),
    );
  }

  private notify(): void {
    notifyEach(this.subscribers);
  }
}
