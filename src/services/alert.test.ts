import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IPAD, IPHONE, LINUX, MAC, setPlatform } from "../test/platform";
import { resetTauri, tauri } from "../test/tauriMock";
import { askNative, usesNativeAlert, type NativeAsk } from "./alert";
import { AppError } from "./ipc";

vi.mock("@tauri-apps/api/core", () => import("../test/tauriMock"));

const ASK: NativeAsk = { title: "Remove iPad?", message: "It stops syncing at once and keeps its plans read-only.", confirm: { label: "Remove device", destructive: true }, cancel: "Cancel" };

beforeEach(() => setPlatform(IPHONE));
afterEach(() => setPlatform(MAC));

describe("askNative", () => {
  it.each(["confirm", "cancel"] as const)("passes the ask to alert_ask and returns %s", async (answer) => {
    resetTauri({ alert_ask: () => answer });
    await expect(askNative(ASK)).resolves.toBe(answer);
    expect(tauri.calls).toEqual([{ cmd: "alert_ask", args: { ask: ASK }, options: undefined }]);
  });

  it.each([["yes"], [null], [undefined], [1], [{ answer: "confirm" }]])("throws on the malformed answer %j, naming it", async (answer) => {
    resetTauri({ alert_ask: () => answer });
    const e = await askNative(ASK).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(AppError);
    expect(e).toMatchObject({ code: "ipc.shape", message: `alert_ask answered ${JSON.stringify(answer) ?? String(answer)} instead of "confirm" or "cancel"` });
  });

  it("names a bigint answer as ipc.shape without throwing", async () => {
    resetTauri({ alert_ask: () => 1n });
    const e = await askNative(ASK).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(AppError);
    expect(e).toMatchObject({ code: "ipc.shape", message: 'alert_ask answered a bigint JSON cannot show instead of "confirm" or "cancel"' });
  });

  it("propagates a rejected call with its code, never as cancel", async () => {
    resetTauri({
      alert_ask: () => {
        throw { code: "alert.busy", message: 'The alert "Remove iPad?" cannot be shown: something else is already presented over the window.' };
      },
    });
    await expect(askNative(ASK)).rejects.toMatchObject({ code: "alert.busy" });
  });

  it("works on the iPad too", async () => {
    setPlatform(IPAD);
    resetTauri({ alert_ask: () => "cancel" });
    await expect(askNative(ASK)).resolves.toBe("cancel");
  });

  it.each([MAC, LINUX])("refuses to run on $os without calling Rust", async (p) => {
    setPlatform(p);
    resetTauri({ alert_ask: () => "confirm" });
    await expect(askNative(ASK)).rejects.toMatchObject({ code: "alert.platform" });
    expect(tauri.calls).toEqual([]);
  });
});

describe("usesNativeAlert", () => {
  it("is true on iOS only", () => {
    setPlatform(IPHONE);
    expect(usesNativeAlert()).toBe(true);
    setPlatform(IPAD);
    expect(usesNativeAlert()).toBe(true);
    setPlatform(MAC);
    expect(usesNativeAlert()).toBe(false);
    setPlatform(LINUX);
    expect(usesNativeAlert()).toBe(false);
  });
});
