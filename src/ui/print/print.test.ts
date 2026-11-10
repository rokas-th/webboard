import { afterEach, describe, expect, it, vi } from "vitest";
import { AppError } from "../../services/ipc";
import { commandsSince, resetTauri, tauri } from "../../test/tauriMock";
import { printNow } from "./print";

vi.mock("@tauri-apps/api/core", () => import("../../test/tauriMock"));

afterEach(() => {
  vi.restoreAllMocks();
});

describe("printNow (product-8)", () => {
  it("asks Rust to open the print panel on macOS, without window.print", async () => {
    resetTauri({ print_window: () => null });
    const print = vi.spyOn(window, "print").mockImplementation(() => undefined);
    const from = tauri.calls.length;
    await printNow("macos");
    expect(commandsSince(from)).toEqual(["print_window"]);
    expect(print).not.toHaveBeenCalled();
  });

  it("passes on the Rust refusal as an AppError", async () => {
    resetTauri({
      print_window: () => {
        throw { code: "print.failed", message: "Could not open the print dialog: the window did not answer." };
      },
    });
    const failed = printNow("macos");
    await expect(failed).rejects.toBeInstanceOf(AppError);
    await expect(failed).rejects.toThrow("Could not open the print dialog: the window did not answer.");
  });

  it("prints through the webview on Linux, without a command", async () => {
    resetTauri({});
    const print = vi.spyOn(window, "print").mockImplementation(() => undefined);
    const from = tauri.calls.length;
    await printNow("linux");
    expect(print).toHaveBeenCalledTimes(1);
    expect(commandsSince(from)).toEqual([]);
  });

  it("refuses iOS", async () => {
    resetTauri({});
    const print = vi.spyOn(window, "print").mockImplementation(() => undefined);
    await expect(printNow("ios")).rejects.toThrow("Print is not offered on iOS");
    expect(print).not.toHaveBeenCalled();
  });
});
