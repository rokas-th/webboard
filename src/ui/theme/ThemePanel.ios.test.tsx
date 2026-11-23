import { act, cleanup, fireEvent, render, within } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fixedClock } from "../../services/clock";
import { setSystemDark } from "../../test/matchMedia";
import { IPHONE, MAC, setPlatform } from "../../test/platform";
import { resetTauri, tauri } from "../../test/tauriMock";
import { deviced } from "../../test/theme";
import { DEFAULT_STORE, type ThemeStore } from "../../theme/store";
import { ThemeProvider, useNativeScheme } from "../../theme/ThemeContext";
import { SettingsView } from "../settings/Settings";

vi.mock("@tauri-apps/api/core", () => import("../../test/tauriMock"));
vi.mock("../common/Toast", () => ({ toast: vi.fn() }));

function NativeScheme(): null {
  useNativeScheme();
  return null;
}

const NIGHT = { id: "mine-1", name: "Night", note: "Yours", group: "mine" as const, seeds: { ground: "#0B1630", text: "#C9D6EA", accent: "#7CC4FF", highlight: "#FFD166", danger: "#FF6B88" } };

const STORE: ThemeStore = { ...DEFAULT_STORE, mode: "system", dark: NIGHT.id, light: "paper", mine: [NIGHT] };

const settled = async (): Promise<void> => {
  await act(async () => {
    await new Promise<void>((r) => setTimeout(r, 0));
  });
};

const panel = (): HTMLElement =>
  render(
    <ThemeProvider storage={window.localStorage} initial={{ store: STORE, unreadable: null }}>
      <NativeScheme />
      {deviced(
        <SettingsView
          frame="modal"
          section="theme"
          row={null}
          onRowShown={vi.fn()}
          session={null}
          readOnly={false}
          device="iPhone"
          renameDevice={vi.fn()}
          backup={vi.fn()}
          clock={fixedClock("2026-11-09")}
          hover
          closer={createRef()}
          files={{ creating: false, importing: false, newPlan: () => undefined, newExample: () => undefined, importPlan: () => undefined }}
          onSection={() => undefined}
          onClose={() => undefined}
          syncPane={null}
          onSyncPane={() => undefined}
          onTrashPlan={() => undefined}
          sync={{ kind: "off" }}
          syncName={() => null}
          updates={null}
          syncPanes={null}
          planLocked={false}
        />,
      )}
    </ThemeProvider>,
  ).getByRole("region", { name: "Theme" });

const background = (region: HTMLElement): string => {
  const el = within(region).getByRole("textbox", { name: "Background hex" });
  if (!(el instanceof HTMLInputElement)) throw new Error("not an input");
  return el.value;
};

const schemes = (): unknown[] => tauri.calls.filter((c) => c.cmd === "appearance_set").map((c) => c.args);

beforeEach(() => {
  setPlatform(IPHONE);
  resetTauri({});
});

afterEach(() => {
  cleanup();
  setPlatform(MAC);
  act(() => setSystemDark(true));
});

describe("the Theme tab on a light iPhone that follows the system", () => {
  it("keeps editing the light slot while a dark theme is previewed and WebKit reports the override as dark", async () => {
    setSystemDark(false);
    const region = panel();
    await settled();
    expect(background(region)).toBe("#FFFFFF");
    expect(within(region).queryByRole("button", { name: "Delete" })).toBeNull();
    fireEvent.pointerEnter(within(within(region).getByRole("group", { name: "Themes" })).getByRole("button", { name: /^Night/ }));
    await settled();
    expect(schemes()).toEqual([{ scheme: "system" }, { scheme: "dark" }]);
    act(() => setSystemDark(true));
    await settled();
    expect(within(region).queryByRole("button", { name: "Delete" })).toBeNull();
    expect(background(region)).toBe("#FFFFFF");
  });
});
