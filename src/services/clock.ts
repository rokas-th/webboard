import { localToday, toDay, type IsoDate } from "../domain/dates";

export interface Clock {
  today(): IsoDate;
  now(): number;
  subscribe(cb: () => void): () => void;
}

export const CLOCK_CHECK_MS = 30_000;

const notifyAll = (subscribers: ReadonlySet<() => void>): void => [...subscribers].forEach((cb) => cb());

function makeSystemClock(): Clock {
  const subscribers = new Set<() => void>();
  let timer: ReturnType<typeof setInterval> | null = null;
  let last = localToday();
  const tick = (): void => {
    const t = localToday();
    if (t === last) return;
    last = t;
    notifyAll(subscribers);
  };
  return {
    today: () => localToday(),
    now: () => Date.now(),
    subscribe(cb) {
      subscribers.add(cb);
      if (timer === null) {
        last = localToday();
        timer = setInterval(tick, CLOCK_CHECK_MS);
      }
      return () => {
        subscribers.delete(cb);
        if (subscribers.size === 0 && timer !== null) {
          clearInterval(timer);
          timer = null;
        }
      };
    },
  };
}

export const systemClock: Clock = makeSystemClock();

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
      notifyAll(subscribers);
    },
  };
}
