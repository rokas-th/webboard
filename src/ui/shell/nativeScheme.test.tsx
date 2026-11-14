import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Registry } from "../../store/registry";
import type { PlanSession } from "../../store/session";
import { IPAD, IPHONE, setPlatform } from "../../test/platform";
import { MESA_SEED, testSession } from "../../test/session";
import { setScreen } from "../../test/setup";
import { shellFor } from "../../test/shell";
import { resetTauri, tauri } from "../../test/tauriMock";
import { withSync } from "../../test/withSync";
import { clearToasts } from "../common/Toast";

vi.mock("@tauri-apps/api/core", () => import("../../test/tauriMock"));

const sessions: PlanSession[] = [];

beforeEach(() => {
  window.localStorage.clear();
  resetTauri({});
});

afterEach(async () => {
  cleanup();
  clearToasts();
  await Promise.all(sessions.splice(0).map((s) => s.close()));
  window.localStorage.clear();
});

const settle = async (): Promise<void> => {
  await act(async () => {
    await new Promise<void>((r) => setTimeout(r, 0));
    await new Promise<void>((r) => setTimeout(r, 0));
  });
};

const shown = async (over: Partial<Registry>): Promise<void> => {
  const t = await testSession(MESA_SEED);
  sessions.push(t.session);
  render(withSync(shellFor(t, over).ui));
  await settle();
};

const schemes = (): unknown[] => tauri.calls.filter((c) => c.cmd === "appearance_set").map((c) => c.args);

describe("the shell tells UIKit the theme's scheme", () => {
  it("in the wide shell on the iPad", async () => {
    setPlatform(IPAD);
    setScreen(834, 1194);
    await shown({ device: { deviceId: "ipad", name: "iPad", platform: "ios" } });
    expect(document.querySelector("header.toolbar")).not.toBeNull();
    expect(schemes()).toEqual([{ scheme: "dark" }]);
  });

  it("in the phone shell on the iPhone", async () => {
    setPlatform(IPHONE);
    setScreen(390, 844);
    await shown({ device: { deviceId: "iphone", name: "iPhone", platform: "ios" } });
    expect(document.querySelector(".phone-head")).not.toBeNull();
    expect(schemes()).toEqual([{ scheme: "dark" }]);
  });

  it("not at all on the Mac", async () => {
    await shown({});
    expect(document.querySelector("header.toolbar")).not.toBeNull();
    expect(tauri.calls.filter((c) => c.cmd === "appearance_set" || c.cmd === "haptic")).toEqual([]);
    expect(document.querySelectorAll(".toasts .toast.bad")).toHaveLength(0);
    expect(document.querySelectorAll(".toasts")).toHaveLength(1);
  });
});
