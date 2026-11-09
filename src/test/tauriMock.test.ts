import { beforeEach, describe, expect, it } from "vitest";
import { getCurrentWindow, requestWindowClose, resetTauri, windowState } from "./tauriMock";

beforeEach(() => {
  resetTauri({});
});

describe("requestWindowClose", () => {
  it("destroys once for each listener whose own event was not prevented", async () => {
    const win = getCurrentWindow();
    await win.onCloseRequested((e) => e.preventDefault());
    await win.onCloseRequested(() => undefined);
    await win.onCloseRequested(() => undefined);
    await requestWindowClose();
    expect(windowState.destroyed).toBe(2);
  });

  it("destroys nothing when every listener prevents", async () => {
    const win = getCurrentWindow();
    await win.onCloseRequested((e) => e.preventDefault());
    await win.onCloseRequested((e) => e.preventDefault());
    await requestWindowClose();
    expect(windowState.destroyed).toBe(0);
  });
});
