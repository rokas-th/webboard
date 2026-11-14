import { beforeEach, describe, expect, it } from "vitest";
import { IPAD, IPHONE, LINUX, MAC, setPlatform } from "./platform";
import { getCurrentWindow, invoke, requestWindowClose, resetTauri, takeRefusals, windowState } from "./tauriMock";

beforeEach(() => {
  resetTauri({});
});

describe("the default answers", () => {
  it.each([
    ["appearance_set", { scheme: "dark" }],
    ["haptic", { kind: "selection" }],
  ])("answer %s on iOS and refuse it elsewhere, recording each refusal", async (cmd, args) => {
    setPlatform(IPHONE);
    await expect(invoke(cmd, args)).resolves.toBeNull();
    setPlatform(IPAD);
    await expect(invoke(cmd, args)).resolves.toBeNull();
    expect(takeRefusals()).toEqual([]);
    setPlatform(MAC);
    await expect(invoke(cmd, args)).rejects.toThrow(`${cmd} was called on macos, where only iOS has it`);
    setPlatform(LINUX);
    await expect(invoke(cmd, args)).rejects.toThrow(`${cmd} was called on linux, where only iOS has it`);
    expect(takeRefusals()).toEqual([`${cmd} was called on macos, where only iOS has it`, `${cmd} was called on linux, where only iOS has it`]);
  });

  it.each(["light", "dark", "system"])("answer appearance_set with the scheme %s on iOS", async (scheme) => {
    setPlatform(IPHONE);
    await expect(invoke("appearance_set", { scheme })).resolves.toBeNull();
    expect(takeRefusals()).toEqual([]);
  });

  it.each([
    ["appearance_set", {}, "appearance_set got {}, not a scheme of light, dark, system"],
    ["appearance_set", { style: "dark" }, 'appearance_set got {"style":"dark"}, not a scheme of light, dark, system'],
    ["appearance_set", { scheme: "auto" }, 'appearance_set got {"scheme":"auto"}, not a scheme of light, dark, system'],
    ["haptic", {}, "haptic got {}, not a kind of selection, light, medium, success, warning, error"],
    ["haptic", { kind: "heavy" }, 'haptic got {"kind":"heavy"}, not a kind of selection, light, medium, success, warning, error'],
    ["haptic", { kind: 1 }, 'haptic got {"kind":1}, not a kind of selection, light, medium, success, warning, error'],
  ])("refuse %s with %o on iOS, as the Rust command's serde would", async (cmd, args, text) => {
    setPlatform(IPHONE);
    await expect(invoke(cmd, args)).rejects.toThrow(text);
    expect(takeRefusals()).toEqual([text]);
  });
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
