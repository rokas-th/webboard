import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createClock } from "./clock";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("createClock", () => {
  it("rolls over at local midnight", () => {
    vi.setSystemTime(new Date(2026, 10, 9, 23, 59, 30));
    const clock = createClock();
    const spy = vi.fn();
    const off = clock.subscribe(spy);
    expect(clock.today()).toBe("2026-11-09");
    vi.advanceTimersByTime(60_000);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(clock.today()).toBe("2026-11-10");
    off();
  });

  it("follows a time-zone change", () => {
    const instant = new Date("2026-11-09T12:00:00Z");
    vi.stubEnv("TZ", "Europe/Zurich");
    expect(instant.getTimezoneOffset()).toBe(-60);
    vi.stubEnv("TZ", "Pacific/Auckland");
    expect(instant.getTimezoneOffset()).toBe(-780);
    vi.stubEnv("TZ", "Europe/Zurich");
    vi.setSystemTime(instant);
    const clock = createClock();
    const spy = vi.fn();
    const off = clock.subscribe(spy);
    expect(clock.today()).toBe("2026-11-09");
    vi.stubEnv("TZ", "Pacific/Auckland");
    vi.advanceTimersByTime(30_000);
    expect(clock.today()).toBe("2026-11-10");
    expect(spy).toHaveBeenCalledTimes(1);
    off();
  });

  it("catches up on wake", () => {
    vi.setSystemTime(new Date(2026, 10, 9, 20, 0));
    const clock = createClock();
    const spy = vi.fn();
    const off = clock.subscribe(spy);
    vi.setSystemTime(new Date(2026, 10, 10, 5, 0));
    document.dispatchEvent(new Event("visibilitychange"));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(clock.today()).toBe("2026-11-10");
    off();
  });

  it("stops without subscribers", () => {
    vi.setSystemTime(new Date(2026, 10, 9, 20, 0));
    const clock = createClock();
    const a = clock.subscribe(vi.fn());
    const b = clock.subscribe(vi.fn());
    expect(vi.getTimerCount()).toBe(1);
    a();
    expect(vi.getTimerCount()).toBe(1);
    b();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("listens to the window only while subscribed", () => {
    vi.setSystemTime(new Date(2026, 10, 9, 20, 0));
    const clock = createClock();
    const spy = vi.fn();
    const off = clock.subscribe(spy);
    off();
    vi.setSystemTime(new Date(2026, 10, 10, 5, 0));
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("focus"));
    window.dispatchEvent(new Event("online"));
    expect(spy).not.toHaveBeenCalled();
  });

  it("checks on focus and online", () => {
    vi.setSystemTime(new Date(2026, 10, 9, 20, 0));
    const clock = createClock();
    const spy = vi.fn();
    const off = clock.subscribe(spy);
    vi.setSystemTime(new Date(2026, 10, 10, 5, 0));
    window.dispatchEvent(new Event("focus"));
    expect(spy).toHaveBeenCalledTimes(1);
    vi.setSystemTime(new Date(2026, 10, 11, 5, 0));
    window.dispatchEvent(new Event("online"));
    expect(spy).toHaveBeenCalledTimes(2);
    window.dispatchEvent(new Event("online"));
    expect(spy).toHaveBeenCalledTimes(2);
    off();
  });

  it("reads the injected now", () => {
    let t = new Date(2026, 10, 9, 12, 0);
    const clock = createClock({ now: () => t, tickMs: 1000 });
    const spy = vi.fn();
    const off = clock.subscribe(spy);
    expect(clock.now()).toBe(t.getTime());
    t = new Date(2026, 10, 10, 12, 0);
    vi.advanceTimersByTime(1000);
    expect(spy).toHaveBeenCalledTimes(1);
    off();
  });
});
