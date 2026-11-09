import { beforeEach, describe, expect, it, vi } from "vitest";
import { closeListenerCount, requestWindowClose, resetTauri, windowState } from "../test/tauriMock";
import { AppError } from "./ipc";
import { closeGuard, guardWindowClose, type Closable } from "./window";

vi.mock("@tauri-apps/api/window", () => import("../test/tauriMock"));

beforeEach(() => {
  resetTauri({});
});

const event = () => {
  const preventDefault = vi.fn<() => void>();
  return { preventDefault };
};

const noFailure = (e: unknown): void => {
  throw new Error(`no failure expected, got ${String(e)}`);
};

describe("closeGuard", () => {
  it("holds the default close, closes the target, then destroys the window", async () => {
    const order: string[] = [];
    const target = {
      close: vi.fn(async () => {
        await Promise.resolve();
        order.push("closed");
      }),
    };
    const win = {
      destroy: vi.fn(async () => {
        order.push("destroyed");
      }),
    };
    const onFailure = vi.fn<(e: unknown) => void>();
    const e = event();
    await closeGuard(() => target, win, onFailure)(e);
    expect(order).toEqual(["closed", "destroyed"]);
    expect(e.preventDefault).toHaveBeenCalledTimes(1);
    expect(onFailure).not.toHaveBeenCalled();
  });

  it("keeps the window and reports the failure when closing rejects", async () => {
    const failure = new AppError("store.io", "Could not save “Alpha”: disk full.");
    const target = { close: vi.fn(() => Promise.reject(failure)) };
    const win = { destroy: vi.fn(() => Promise.resolve()) };
    const onFailure = vi.fn<(e: unknown) => void>();
    const e = event();
    await closeGuard(() => target, win, onFailure)(e);
    expect(e.preventDefault).toHaveBeenCalledTimes(1);
    expect(win.destroy).not.toHaveBeenCalled();
    expect(onFailure.mock.calls).toEqual([[failure]]);
  });

  it("reports a destroy that rejects", async () => {
    const failure = new Error("window not found");
    const target = { close: vi.fn(() => Promise.resolve()) };
    const win = { destroy: vi.fn(() => Promise.reject(failure)) };
    const onFailure = vi.fn<(e: unknown) => void>();
    const e = event();
    await closeGuard(() => target, win, onFailure)(e);
    expect(e.preventDefault).toHaveBeenCalledTimes(1);
    expect(onFailure.mock.calls).toEqual([[failure]]);
  });

  it("lets the close through when there is nothing to close", async () => {
    const win = { destroy: vi.fn(() => Promise.resolve()) };
    const e = event();
    await closeGuard(() => null, win, noFailure)(e);
    expect(e.preventDefault).not.toHaveBeenCalled();
    expect(win.destroy).not.toHaveBeenCalled();
  });

  it("destroys once when a second request arrives while the first is closing", async () => {
    let finish: () => void = () => {
      throw new Error("close was not called");
    };
    const target = {
      close: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      ),
    };
    const win = { destroy: vi.fn(() => Promise.resolve()) };
    const guard = closeGuard(() => target, win, noFailure);
    const first = event();
    const second = event();
    const running = guard(first);
    await guard(second);
    expect(second.preventDefault).toHaveBeenCalledTimes(1);
    finish();
    await running;
    expect(target.close).toHaveBeenCalledTimes(1);
    expect(win.destroy).toHaveBeenCalledTimes(1);
  });
});

describe("guardWindowClose", () => {
  it("closes the target, destroys the window once, and unlistens", async () => {
    const target = { close: vi.fn(() => Promise.resolve()) };
    const off = await guardWindowClose(() => target, noFailure);
    expect(closeListenerCount()).toBe(1);
    await requestWindowClose();
    expect(target.close).toHaveBeenCalledTimes(1);
    expect(windowState.destroyed).toBe(1);
    off();
    expect(closeListenerCount()).toBe(0);
  });

  it("does not let the window go over a failed close", async () => {
    const failure = new Error("2 documents failed to close; the first: disk full");
    const target = { close: vi.fn(() => Promise.reject(failure)) };
    const failures: unknown[] = [];
    await guardWindowClose(() => target, (e) => failures.push(e));
    expect(await requestWindowClose()).toEqual({ prevented: true });
    expect(windowState.destroyed).toBe(0);
    expect(failures).toEqual([failure]);
  });

  it("reports a destroy that rejects instead of leaving it unhandled", async () => {
    const failure = new Error("window not found");
    windowState.destroyFailure = failure;
    const target = { close: vi.fn(() => Promise.resolve()) };
    const failures: unknown[] = [];
    await guardWindowClose(() => target, (e) => failures.push(e));
    expect(await requestWindowClose()).toEqual({ prevented: true });
    expect(failures).toEqual([failure]);
  });

  it("lets the window go when there is nothing to close", async () => {
    const current = (): Closable | null => null;
    await guardWindowClose(current, noFailure);
    expect(await requestWindowClose()).toEqual({ prevented: false });
    expect(windowState.destroyed).toBe(1);
  });
});
