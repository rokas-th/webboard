import { act, cleanup, render } from "@testing-library/react";
import { StrictMode, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "../ui/common/Toast";
import { darkListenerCount, setSystemDark } from "../test/matchMedia";
import { paintNative } from "./apply";
import { derive, type Seeds } from "./derive";
import { DEFAULT_STORE, THEME_KEY, THEME_UNREADABLE, type ThemeStore } from "./store";
import { ThemeProvider, useNativeBackground, useTheme, type ThemeApi } from "./ThemeContext";

vi.mock("../ui/common/Toast", () => ({ toast: vi.fn() }));
vi.mock("./apply", async (importOriginal) => {
  const real = await importOriginal<typeof import("./apply")>();
  return { ...real, paintNative: vi.fn(async () => undefined) };
});

const SEEDS: Seeds = { ground: "#0B1630", text: "#C9D6EA", accent: "#7CC4FF", highlight: "#FFD166", danger: "#FF6B88" };

const lastPaint = (): unknown => vi.mocked(paintNative).mock.lastCall;

const voidNow = (): string => document.documentElement.style.getPropertyValue("--void");

let api: ThemeApi | null = null;
const theme = (): ThemeApi => {
  if (api === null) throw new Error("provider not mounted");
  return api;
};

function Grab(): null {
  api = useTheme();
  return null;
}

function Native({ platform }: { platform: "macos" | "linux" | "ios" }): null {
  useNativeBackground(platform);
  return null;
}

const mount = (store: ThemeStore = DEFAULT_STORE, unreadable = false, extra: ReactNode = null) =>
  render(
    <StrictMode>
      <ThemeProvider storage={window.localStorage} initial={{ store, unreadable }}>
        <Grab />
        {extra}
      </ThemeProvider>
    </StrictMode>,
  );

beforeEach(() => {
  api = null;
});

afterEach(() => {
  cleanup();
  vi.mocked(toast).mockClear();
  vi.mocked(paintNative).mockReset();
  vi.mocked(paintNative).mockResolvedValue(undefined);
});

describe("ThemeProvider", () => {
  it("applies the shown theme on mount", () => {
    mount();
    expect(voidNow()).toBe("#0A0A14");
    expect(document.documentElement.dataset.scheme).toBe("dark");
  });

  it("choosing a preset changes --void and writes the store", () => {
    mount();
    act(() => theme().choose("paper"));
    expect(voidNow()).toBe("#FFFFFF");
    expect(document.documentElement.dataset.scheme).toBe("light");
    expect(JSON.parse(window.localStorage.getItem(THEME_KEY) ?? "").active).toBe("paper");
    expect(theme().shown.id).toBe("paper");
  });

  it("preview changes tokens but not storage, and preview(null) restores", () => {
    mount();
    act(() => theme().preview("paper"));
    expect(voidNow()).toBe("#FFFFFF");
    expect(window.localStorage.getItem(THEME_KEY)).toBeNull();
    act(() => theme().preview(null));
    expect(voidNow()).toBe("#0A0A14");
  });

  it("a draft applies derive(seeds) and setDraft(null) restores", () => {
    mount();
    act(() => theme().setDraft(SEEDS));
    expect(voidNow()).toBe(derive(SEEDS).void);
    expect(document.documentElement.style.getPropertyValue("--panel")).toBe(derive(SEEDS).panel);
    expect(theme().draft).toEqual(SEEDS);
    expect(window.localStorage.getItem(THEME_KEY)).toBeNull();
    act(() => theme().setDraft(null));
    expect(voidNow()).toBe("#0A0A14");
  });

  it("follows the OS into the light slot, keeping a preview on screen until it ends", () => {
    mount({ ...DEFAULT_STORE, mode: "system", dark: "phosphor", light: "paper" });
    expect(voidNow()).toBe("#060C09");
    act(() => theme().preview("blueprint"));
    act(() => setSystemDark(false));
    expect(theme().systemDark).toBe(false);
    expect(voidNow()).toBe("#0B1630");
    act(() => theme().preview(null));
    expect(voidNow()).toBe("#FFFFFF");
    act(() => setSystemDark(true));
    expect(voidNow()).toBe("#060C09");
  });

  it("keeps a draft on screen across an OS flip", () => {
    mount({ ...DEFAULT_STORE, mode: "system", dark: "phosphor", light: "paper" });
    act(() => theme().setDraft(SEEDS));
    act(() => setSystemDark(false));
    expect(voidNow()).toBe(SEEDS.ground);
    act(() => theme().setDraft(null));
    expect(voidNow()).toBe("#FFFFFF");
  });

  it("toasts THEME_UNREADABLE once for an unreadable initial store", () => {
    mount(DEFAULT_STORE, true);
    expect(vi.mocked(toast).mock.calls).toEqual([[THEME_UNREADABLE, "bad"]]);
  });

  it("does not toast for a readable store", () => {
    mount();
    expect(toast).not.toHaveBeenCalled();
  });

  it("unmounting leaves the tokens on the root and removes the OS listener", () => {
    const { unmount } = mount();
    act(() => theme().choose("paper"));
    expect(darkListenerCount()).toBe(1);
    unmount();
    expect(voidNow()).toBe("#FFFFFF");
    expect(darkListenerCount()).toBe(0);
  });

  it("commits save, setSlot, setMode, remove and useCyberdeck to storage", () => {
    mount();
    const stored = (): ThemeStore => JSON.parse(window.localStorage.getItem(THEME_KEY) ?? "");
    let id = "";
    act(() => {
      id = theme().save("Night", SEEDS, null);
    });
    expect(id).toBe("mine-1");
    expect(stored().mine).toEqual([{ id: "mine-1", name: "Night", seeds: SEEDS }]);
    act(() => theme().setMode("system"));
    expect(stored().mode).toBe("system");
    act(() => theme().setSlot("dark", "mine-1"));
    expect(stored().dark).toBe("mine-1");
    expect(voidNow()).toBe("#0B1630");
    act(() => theme().remove("mine-1"));
    expect(stored().dark).toBe("cyberdeck");
    act(() => theme().preview("paper"));
    act(() => theme().setDraft(SEEDS));
    act(() => theme().useCyberdeck());
    expect(stored()).toMatchObject({ mode: "fixed", active: "cyberdeck" });
    expect(theme().draft).toBeNull();
    expect(voidNow()).toBe("#0A0A14");
  });

  it("save throws its message and writes nothing", () => {
    mount();
    expect(() => theme().save("  ", SEEDS, null)).toThrow("Name the theme first.");
    expect(window.localStorage.getItem(THEME_KEY)).toBeNull();
  });

  it("useTheme throws outside a provider", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => render(<Grab />)).toThrow("useTheme needs a ThemeProvider");
    vi.mocked(console.error).mockRestore();
  });
});

describe("useNativeBackground", () => {
  it("never paints on ios", () => {
    mount(DEFAULT_STORE, false, <Native platform="ios" />);
    act(() => theme().choose("paper"));
    expect(paintNative).not.toHaveBeenCalled();
  });

  it("paints the shown ground on macos and on each committed change", () => {
    mount(DEFAULT_STORE, false, <Native platform="macos" />);
    expect(lastPaint()).toEqual(["#0A0A14"]);
    act(() => theme().preview("phosphor"));
    expect(lastPaint()).toEqual(["#0A0A14"]);
    act(() => theme().choose("paper"));
    expect(lastPaint()).toEqual(["#FFFFFF"]);
  });

  it("toasts a rejection", async () => {
    vi.mocked(paintNative).mockRejectedValue(new Error("not allowed"));
    mount(DEFAULT_STORE, false, <Native platform="linux" />);
    await act(async () => {});
    expect(vi.mocked(toast)).toHaveBeenCalledWith("Window colour could not be set: not allowed", "bad");
  });
});
