import { localToday, toDay, type IsoDate } from "../domain/dates";

export interface Clock {
  today(): IsoDate;
  now(): number;
  subscribe(cb: () => void): () => void;
}

export const CLOCK_CHECK_MS = 30_000;

export function notifyEach(subscribers: Iterable<() => void>): void {
  const thrown = [...subscribers].flatMap((cb): unknown[] => {
    try {
      cb();
      return [];
    } catch (e) {
      return [e];
    }
  });
  if (thrown.length > 0) throw collected(thrown, "subscribers threw");
}

export function collected(thrown: readonly unknown[], what: string): unknown {
  if (thrown.length === 1) return thrown[0];
  const first = thrown[0];
  return Object.assign(new Error(`${thrown.length} ${what}; the first: ${first instanceof Error ? first.message : String(first)}`), { cause: first });
}

export function createClock(opts?: { now?: () => Date; tickMs?: number; target?: Window }): Clock {
  const read = opts?.now ?? (() => new Date());
  const tickMs = opts?.tickMs ?? CLOCK_CHECK_MS;
  const target = opts?.target ?? window;
  const subscribers = new Set<() => void>();
  let timer: ReturnType<typeof setInterval> | null = null;
  let last = localToday(read());
  const check = (): void => {
    const t = localToday(read());
    if (t === last) return;
    last = t;
    notifyEach(subscribers);
  };
  const start = (): void => {
    last = localToday(read());
    timer = setInterval(check, tickMs);
    target.document.addEventListener("visibilitychange", check);
    target.addEventListener("focus", check);
    target.addEventListener("online", check);
  };
  const stop = (): void => {
    if (timer !== null) clearInterval(timer);
    timer = null;
    target.document.removeEventListener("visibilitychange", check);
    target.removeEventListener("focus", check);
    target.removeEventListener("online", check);
  };
  return {
    today: () => localToday(read()),
    now: () => read().getTime(),
    subscribe(cb) {
      subscribers.add(cb);
      if (timer === null) start();
      return () => {
        subscribers.delete(cb);
        if (subscribers.size === 0 && timer !== null) stop();
      };
    },
  };
}

export const systemClock: Clock = createClock();

const noonOf = (d: IsoDate): number => new Date(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10)), 12).getTime();

export function fixedClock(today: IsoDate, now?: number): Clock & { set(today: IsoDate): void } {
  toDay(today);
  const subscribers = new Set<() => void>();
  let current = today;
  return {
    today: () => current,
    now: () => now ?? noonOf(current),
    subscribe(cb) {
      subscribers.add(cb);
      return () => {
        subscribers.delete(cb);
      };
    },
    set(next) {
      toDay(next);
      if (next === current) return;
      current = next;
      notifyEach(subscribers);
    },
  };
}
