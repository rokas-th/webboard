import { beforeEach, describe, expect, it, vi } from "vitest";
import { closeListenerCount, requestWindowClose, resetTauri, windowState } from "../test/tauriMock";
import { AppError } from "./ipc";
import { closeGuard, guardWindowClose } from "./window";

vi.mock("@tauri-apps/api/window", () => import("../test/tauriMock"));

beforeEach(() => {
  resetTauri({});
});

const event = () => {
  const preventDefault = vi.fn<() => void>();
  return { preventDefault };
};

describe("closeGuard", () => {
  it("lets the window close once the target has closed", async () => {
    const order: string[] = [];
    const target = {
      close: vi.fn(async () => {
        await Promise.resolve();
        order.push("closed");
      }),
    };
    const onFailure = vi.fn<(e: unknown) => void>();
    const e = event();
    await closeGuard(target, onFailure)(e).then(() => order.push("handler done"));
    expect(order).toEqual(["closed", "handler done"]);
    expect(target.close).toHaveBeenCalledTimes(1);
    expect(e.preventDefault).not.toHaveBeenCalled();
    expect(onFailure).not.toHaveBeenCalled();
  });

  it("keeps the window open and reports the failure when closing rejects", async () => {
    const failure = new AppError("store.io", "Could not save “Alpha”: disk full.");
    const target = { close: vi.fn(() => Promise.reject(failure)) };
    const onFailure = vi.fn<(e: unknown) => void>();
    const e = event();
    await closeGuard(target, onFailure)(e);
    expect(e.preventDefault).toHaveBeenCalledTimes(1);
    expect(onFailure.mock.calls).toEqual([[failure]]);
  });
});

describe("guardWindowClose", () => {
  it("closes the target before the window goes, and unlistens", async () => {
    const target = { close: vi.fn(() => Promise.resolve()) };
    const off = await guardWindowClose(target, () => {
      throw new Error("no failure expected");
    });
    expect(closeListenerCount()).toBe(1);
    expect(await requestWindowClose()).toEqual({ prevented: false });
    expect(target.close).toHaveBeenCalledTimes(1);
    expect(windowState.destroyed).toBe(1);
    off();
    expect(closeListenerCount()).toBe(0);
  });

  it("does not let the window go over a failed close", async () => {
    const failure = new Error("2 documents failed to close; the first: disk full");
    const target = { close: vi.fn(() => Promise.reject(failure)) };
    const failures: unknown[] = [];
    await guardWindowClose(target, (e) => failures.push(e));
    expect(await requestWindowClose()).toEqual({ prevented: true });
    expect(windowState.destroyed).toBe(0);
    expect(failures).toEqual([failure]);
  });
});
