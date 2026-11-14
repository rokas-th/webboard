import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IPAD, IPHONE, LINUX, MAC, setPlatform } from "../test/platform";
import { resetTauri, tauri } from "../test/tauriMock";
import { setNativeScheme } from "./appearance";
import { AppError } from "./ipc";

vi.mock("@tauri-apps/api/core", () => import("../test/tauriMock"));

beforeEach(() => {
  setPlatform(IPHONE);
  resetTauri({});
});

afterEach(() => setPlatform(MAC));

describe("setNativeScheme", () => {
  it.each(["light", "dark", "system"] as const)("sends %s to appearance_set and resolves once it answers", async (scheme) => {
    await expect(setNativeScheme(scheme)).resolves.toBeUndefined();
    expect(tauri.calls).toEqual([{ cmd: "appearance_set", args: { scheme }, options: undefined }]);
  });

  it("works on the iPad too", async () => {
    setPlatform(IPAD);
    await setNativeScheme("dark");
    expect(tauri.calls.map((c) => c.cmd)).toEqual(["appearance_set"]);
  });

  it("takes only light, dark or system at the call site", async () => {
    resetTauri({ appearance_set: () => null });
    // @ts-expect-error auto is not a NativeScheme
    await setNativeScheme("auto");
  });

  it("propagates a rejected call with its code and message", async () => {
    const message = "The dark appearance cannot be set on the window: its view is in no window.";
    resetTauri({
      appearance_set: () => {
        throw { code: "appearance.no_window", message };
      },
    });
    const e = await setNativeScheme("dark").catch((x: unknown) => x);
    expect(e).toBeInstanceOf(AppError);
    expect(e).toMatchObject({ code: "appearance.no_window", message });
  });

  it.each([undefined, "ok", true, {}])("refuses the answer %o, which is not the command's null", async (out) => {
    resetTauri({ appearance_set: () => out });
    await expect(setNativeScheme("dark")).rejects.toMatchObject({ code: "ipc.shape", message: `appearance_set answered ${JSON.stringify(out)} instead of null` });
  });

  it.each([MAC, LINUX])("refuses on $os without calling Rust", async (p) => {
    setPlatform(p);
    await expect(setNativeScheme("light")).rejects.toMatchObject({ code: "appearance.platform", message: `The native appearance was set to light on ${p.os}, where only iOS has one` });
    expect(tauri.calls).toEqual([]);
  });
});
