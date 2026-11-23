import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IPAD, IPHONE, LINUX, MAC, setPlatform } from "../../test/platform";
import { themed } from "../../test/theme";
import { zoomNative } from "../../theme/apply";
import type { Platform } from "../../platform";
import { toast } from "../common/Toast";
import { DEFAULT_DEVICE, DEVICE_KEY, DEVICE_UNREADABLE, SMALL_TEXT_ZOOM, type DevicePrefs } from "../device";
import { GLOW_HINT, Look, useAppliedLook } from "./Look";

vi.mock("@tauri-apps/api/core", () => import("../../test/tauriMock"));
vi.mock("../common/Toast", async (importOriginal) => ({ ...(await importOriginal<typeof import("../common/Toast")>()), toast: vi.fn() }));

function Applied(): null {
  useAppliedLook();
  return null;
}

const store = (patch: Partial<DevicePrefs>): void => window.localStorage.setItem(DEVICE_KEY, JSON.stringify({ ...DEFAULT_DEVICE, ...patch }));

const mount = (platform: Platform): void => {
  setPlatform(platform);
  render(
    <StrictMode>
      {themed(
        <>
          <Applied />
          <Look />
        </>,
      )}
    </StrictMode>,
  );
};

const zooms = (): unknown[][] => vi.mocked(zoomNative).mock.calls;

const html = (): [string | undefined, string | undefined, string | undefined] => {
  const d = document.documentElement.dataset;
  return [d.density, d.textSize, d.glow];
};

const radios = (field: string): [string | null, string | null][] =>
  Array.from(document.querySelectorAll<HTMLElement>(`[data-general="${field}"] [role="radio"]`)).map((r) => [r.textContent, r.getAttribute("aria-checked")]);

const rows = (): (string | undefined)[] => Array.from(document.querySelectorAll<HTMLElement>("[data-settings-row]")).map((r) => r.dataset.settingsRow);

const stored = (): unknown => JSON.parse(window.localStorage.getItem(DEVICE_KEY) ?? "null");

beforeEach(() => {
  window.localStorage.clear();
  vi.mocked(zoomNative).mockReset();
  vi.mocked(zoomNative).mockResolvedValue(undefined);
  vi.mocked(toast).mockClear();
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  setPlatform(MAC);
});

describe("the Look rows", () => {
  it("shows Density, Text size and Reduce glow on the Mac and on Linux", () => {
    [MAC, LINUX].forEach((platform) => {
      mount(platform);
      expect(rows()).toEqual(["theme.density", "theme.text-size", "theme.glow"]);
      expect(radios("density")).toEqual([
        ["Comfortable", "true"],
        ["Compact", "false"],
      ]);
      expect(radios("text-size")).toEqual([
        ["Small", "false"],
        ["Default", "true"],
      ]);
      expect([screen.getByRole("switch", { name: "Reduce glow" }).getAttribute("aria-checked"), screen.getByRole("switch", { name: "Reduce glow" }).className]).toEqual(["false", "switch"]);
      expect(screen.getByText(GLOW_HINT).id).toBe(screen.getByRole("switch", { name: "Reduce glow" }).getAttribute("aria-describedby"));
      cleanup();
    });
  });

  it("shows only Reduce glow on the iPad, and a stored Small or Compact as the defaults", async () => {
    store({ text: "small", density: "compact" });
    mount(IPAD);
    await act(async () => {});
    expect(rows()).toEqual(["theme.glow"]);
    expect(html()).toEqual(["comfortable", "default", "full"]);
    expect(zooms()).toEqual([]);
  });

  it("shows only Reduce glow on the iPhone", () => {
    store({ text: "small" });
    mount(IPHONE);
    expect(rows()).toEqual(["theme.glow"]);
    expect(html()).toEqual(["comfortable", "default", "full"]);
    expect(zooms()).toEqual([]);
  });

  it("stores each choice and stamps it on the page", () => {
    mount(MAC);
    expect(html()).toEqual(["comfortable", "default", "full"]);
    fireEvent.click(screen.getByRole("radio", { name: "Compact" }));
    fireEvent.click(screen.getByRole("switch", { name: "Reduce glow" }));
    expect(html()).toEqual(["compact", "default", "reduced"]);
    expect(stored()).toEqual({ ...DEFAULT_DEVICE, density: "compact", glow: "reduced" });
    expect(screen.getByRole("switch", { name: "Reduce glow" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("switch", { name: "Reduce glow" }));
    expect(html()).toEqual(["compact", "default", "full"]);
  });
});

describe("text size zoom", () => {
  it("does not zoom at boot when the size is Default", async () => {
    mount(MAC);
    await act(async () => {});
    expect(zooms()).toEqual([]);
  });

  it("zooms at boot when the size is Small", async () => {
    store({ text: "small" });
    mount(MAC);
    await act(async () => {});
    expect(zooms()).toEqual([[SMALL_TEXT_ZOOM]]);
    expect(html()[1]).toBe("small");
  });

  it("offers no Large anywhere, and refuses a stored Large with the reset toast instead of showing it as Default", async () => {
    [MAC, LINUX].forEach((platform) => {
      window.localStorage.setItem(DEVICE_KEY, JSON.stringify({ ...DEFAULT_DEVICE, text: "large" }));
      mount(platform);
      expect(radios("text-size")).toEqual([
        ["Small", "false"],
        ["Default", "true"],
      ]);
      expect([html()[1], stored()]).toEqual(["default", null]);
      cleanup();
    });
    await act(async () => {});
    expect(zooms()).toEqual([]);
    expect(vi.mocked(toast).mock.calls).toEqual([
      [DEVICE_UNREADABLE, "bad", 'text is "large", not small or default'],
      [DEVICE_UNREADABLE, "bad", 'text is "large", not small or default'],
    ]);
  });

  it("zooms on each change, back to 1 for Default", async () => {
    mount(MAC);
    fireEvent.click(screen.getByRole("radio", { name: "Small" }));
    await act(async () => {});
    fireEvent.click(screen.getByRole("radio", { name: "Default" }));
    await act(async () => {});
    fireEvent.click(screen.getByRole("radio", { name: "Small" }));
    await act(async () => {});
    expect(zooms()).toEqual([[SMALL_TEXT_ZOOM], [1], [SMALL_TEXT_ZOOM]]);
    expect(html()[1]).toBe("small");
  });

  it("toasts a failure with its details, logs it, and puts the control and the page back on the size that is really shown", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const failure = new Error("not allowed");
    vi.mocked(zoomNative).mockRejectedValueOnce(failure);
    mount(MAC);
    fireEvent.click(screen.getByRole("radio", { name: "Small" }));
    await act(async () => {});
    expect(vi.mocked(toast).mock.calls).toEqual([["Text size could not be set: not allowed. The page stays at Default.", "bad", expect.stringContaining("Error: not allowed")]]);
    expect(logged).toHaveBeenCalledWith(failure);
    expect([radios("text-size"), html()[1], stored()]).toEqual([
      [
        ["Small", "false"],
        ["Default", "true"],
      ],
      "default",
      DEFAULT_DEVICE,
    ]);
    expect(zooms()).toEqual([[SMALL_TEXT_ZOOM]]);
    fireEvent.click(screen.getByRole("radio", { name: "Small" }));
    await act(async () => {});
    expect([zooms(), html()[1]]).toEqual([[[SMALL_TEXT_ZOOM], [SMALL_TEXT_ZOOM]], "small"]);
    logged.mockRestore();
  });

  it("puts a stored Small back to Default when the boot zoom fails, so the next launch does not fail again", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(zoomNative).mockRejectedValueOnce(new Error("not allowed"));
    store({ text: "small" });
    mount(MAC);
    await act(async () => {});
    expect([vi.mocked(toast).mock.calls.map((c) => c[0]), html()[1], stored()]).toEqual([["Text size could not be set: not allowed. The page stays at Default."], "default", DEFAULT_DEVICE]);
    logged.mockRestore();
  });
});
