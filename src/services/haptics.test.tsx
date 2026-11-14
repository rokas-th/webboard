import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IPAD, IPHONE, LINUX, MAC, setPlatform } from "../test/platform";
import { resetTauri, tauri } from "../test/tauriMock";
import { clearToasts, COPY_DETAILS, toast, Toasts } from "../ui/common/Toast";
import { HAPTICS_OFF, haptic, playHaptic, sendHaptic, takeHapticFault, type HapticKind } from "./haptics";
import { AppError } from "./ipc";

vi.mock("@tauri-apps/api/core", () => import("../test/tauriMock"));

const KINDS: readonly HapticKind[] = ["selection", "light", "medium", "success", "warning", "error"];

const flush = async (): Promise<void> => {
  await act(async () => {
    await new Promise<void>((r) => setTimeout(r, 0));
    await new Promise<void>((r) => setTimeout(r, 0));
  });
};

const sent = (): unknown[] => tauri.calls.filter((c) => c.cmd === "haptic").map((c) => c.args);
const badToasts = (): (string | null)[] => Array.from(document.querySelectorAll(".toasts .toast.bad")).map((e) => e.textContent);

const failWith = (code: string, message: string): void =>
  resetTauri({
    haptic: () => {
      throw { code, message };
    },
  });

beforeEach(() => {
  setPlatform(IPHONE);
  resetTauri({});
  clearToasts();
  render(<Toasts />);
});

afterEach(() => {
  cleanup();
  clearToasts();
  setPlatform(MAC);
});

describe("sendHaptic", () => {
  it.each(KINDS)("sends %s to the haptic command", async (kind) => {
    await expect(sendHaptic(kind)).resolves.toBeUndefined();
    expect(tauri.calls).toEqual([{ cmd: "haptic", args: { kind }, options: undefined }]);
  });

  it("takes only the six kinds at the call site", async () => {
    resetTauri({ haptic: () => null });
    // @ts-expect-error heavy is not a HapticKind
    await sendHaptic("heavy");
    // @ts-expect-error a number is not a HapticKind
    haptic(1);
  });

  it("propagates a rejected call with its code", async () => {
    failWith("haptic.no_view", "The light haptic cannot be played: the view controller has no view to attach it to.");
    await expect(sendHaptic("light")).rejects.toMatchObject({ code: "haptic.no_view" });
  });

  it.each([undefined, "ok", true, {}])("refuses the answer %o, which is not the command's null", async (out) => {
    resetTauri({ haptic: () => out });
    await expect(sendHaptic("light")).rejects.toMatchObject({ code: "ipc.shape", message: `haptic answered ${JSON.stringify(out)} instead of null` });
  });

  it.each([MAC, LINUX])("refuses on $os without calling Rust", async (p) => {
    setPlatform(p);
    await expect(sendHaptic("selection")).rejects.toMatchObject({ code: "haptic.platform", message: `The selection haptic was asked for on ${p.os}, where only iOS plays one` });
    expect(tauri.calls).toEqual([]);
  });
});

describe("haptic", () => {
  it("sends on the iPhone and the iPad without making the caller wait", () => {
    expect(haptic("medium")).toBeUndefined();
    setPlatform(IPAD);
    haptic("success");
    expect(sent()).toEqual([{ kind: "medium" }, { kind: "success" }]);
  });

  it.each([MAC, LINUX])("returns at once on $os without any IPC", async (p) => {
    setPlatform(p);
    KINDS.forEach((k) => haptic(k));
    await flush();
    expect(tauri.calls).toEqual([]);
    expect(badToasts()).toEqual([]);
  });

  it("shows a failed haptic as one bad toast that asks for no haptic", async () => {
    const message = "The medium haptic cannot be played: the window has no view controller.";
    failWith("haptic.no_controller", message);
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    haptic("medium");
    await flush();
    expect(sent()).toEqual([{ kind: "medium" }]);
    expect(badToasts()).toEqual([`${message}${HAPTICS_OFF}`]);
    expect(document.querySelectorAll(".toasts .toast-actions button")[0]?.textContent).toBe(COPY_DETAILS);
    expect(logged.mock.calls).toEqual([[expect.objectContaining({ code: "haptic.no_controller", message })]]);
    logged.mockRestore();
  });

  it("turns haptics off after the first failure: a second haptic sends nothing and shows nothing", async () => {
    const message = "The medium haptic cannot be played: the window has no view controller.";
    failWith("haptic.no_controller", message);
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    haptic("medium");
    await flush();
    haptic("medium");
    await flush();
    expect(sent()).toEqual([{ kind: "medium" }]);
    expect(badToasts()).toEqual([`${message}${HAPTICS_OFF}`]);
    expect(logged).toHaveBeenCalledTimes(1);
    logged.mockRestore();
  });

  it("sends no haptic of another kind once haptics are off", async () => {
    failWith("haptic.no_view", "The light haptic cannot be played: the view controller has no view to attach it to.");
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    haptic("light");
    await flush();
    resetTauri({});
    haptic("selection");
    haptic("success");
    await flush();
    expect(tauri.calls).toEqual([]);
    logged.mockRestore();
  });

  it("starts each test with haptics on, whatever the test before did", async () => {
    haptic("selection");
    await flush();
    expect(sent()).toEqual([{ kind: "selection" }]);
  });
});

describe("playHaptic", () => {
  it("rethrows a fault that is not an AppError, sends nothing and toasts nothing, and marks it once as a haptic's own", async () => {
    Object.defineProperty(window, "__WEBBOARD_PLATFORM__", { configurable: true, writable: true, value: undefined });
    const e = await playHaptic("error").catch((x: unknown) => x);
    setPlatform(IPHONE);
    expect(e).toBeInstanceOf(Error);
    expect(e).not.toBeInstanceOf(AppError);
    expect(sent()).toEqual([]);
    expect(badToasts()).toEqual([]);
    expect(takeHapticFault(e)).toBe(true);
    expect(takeHapticFault(e)).toBe(false);
    expect(takeHapticFault(new Error("elsewhere"))).toBe(false);
  });
});

describe("toast", () => {
  it("a bad toast plays the error haptic once on iOS", async () => {
    toast("Import failed: bad file", "bad");
    await flush();
    expect(sent()).toEqual([{ kind: "error" }]);
  });

  it("an ok or plain toast plays nothing", async () => {
    toast("Saved", "ok");
    toast("Moved");
    await flush();
    expect(sent()).toEqual([]);
  });

  it("a bad toast plays nothing on macOS", async () => {
    setPlatform(MAC);
    toast("Import failed: bad file", "bad");
    await flush();
    expect(tauri.calls).toEqual([]);
    expect(badToasts()).toEqual(["Import failed: bad file"]);
  });

  it("a failed error haptic shows one more bad toast and sends no second haptic", async () => {
    failWith("haptic.stopped", "haptic stopped: the main thread dropped it without a result");
    toast("Import failed: bad file", "bad");
    await flush();
    await flush();
    expect(sent()).toEqual([{ kind: "error" }]);
    expect(badToasts()).toEqual(["Import failed: bad file", `haptic stopped: the main thread dropped it without a result${HAPTICS_OFF}`]);
  });
});
