import { act, cleanup, render } from "@testing-library/react";
import { StrictMode, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "../ui/common/Toast";
import { darkListenerCount, setSystemDark, setSystemDarkSilently } from "../test/matchMedia";
import { paintNative } from "./apply";
import { derive, type Seeds } from "./derive";
import { DEFAULT_STORE, THEME_KEY, THEME_UNREADABLE, type ThemeStore } from "./store";
import { hold, resetTauri, tauri } from "../test/tauriMock";
import { IPHONE, LINUX, MAC, setPlatform } from "../test/platform";
import { setNativeScheme } from "../services/appearance";
import { SYSTEM_KEPT, ThemeProvider, useNativeBackground, useNativeScheme, useTheme, type ThemeApi } from "./ThemeContext";

vi.mock("@tauri-apps/api/core", () => import("../test/tauriMock"));
vi.mock("../services/appearance", async (importOriginal) => {
  const real = await importOriginal<typeof import("../services/appearance")>();
  return { ...real, setNativeScheme: vi.fn(real.setNativeScheme) };
});
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

function NativeScheme(): null {
  useNativeScheme();
  return null;
}

type RejectionListener = (reason: unknown) => void;

declare const process: {
  listeners(event: "unhandledRejection"): RejectionListener[];
  removeAllListeners(event: "unhandledRejection"): void;
  on(event: "unhandledRejection", l: RejectionListener): void;
  once(event: "unhandledRejection", l: RejectionListener): void;
};

const nextUnhandled = (): Promise<unknown> => {
  const saved = process.listeners("unhandledRejection");
  process.removeAllListeners("unhandledRejection");
  return new Promise((resolve) => {
    process.once("unhandledRejection", (reason) => {
      saved.forEach((l) => process.on("unhandledRejection", l));
      resolve(reason);
    });
  });
};

const mount = (store: ThemeStore = DEFAULT_STORE, unreadable: string | null = null, extra: ReactNode = null) =>
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
    act(() => theme().setDraft({ seeds: SEEDS, base: "blueprint" }));
    expect(voidNow()).toBe(derive(SEEDS).void);
    expect(document.documentElement.style.getPropertyValue("--panel")).toBe(derive(SEEDS).panel);
    expect(theme().draft).toEqual({ seeds: SEEDS, base: "blueprint" });
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
    act(() => theme().setDraft({ seeds: SEEDS, base: null }));
    act(() => setSystemDark(false));
    expect(voidNow()).toBe(SEEDS.ground);
    act(() => theme().setDraft(null));
    expect(voidNow()).toBe("#FFFFFF");
  });

  it("toasts THEME_UNREADABLE once for an unreadable initial store, with the reason and the backup key as details", () => {
    mount(DEFAULT_STORE, "saved theme 2 is invalid");
    expect(vi.mocked(toast).mock.calls).toEqual([
      [THEME_UNREADABLE, "bad", "saved theme 2 is invalid. The unreadable settings are kept in local storage under webboard.theme.unreadable."],
    ]);
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
    let saved: { id: string; reset: readonly string[] } | null = null;
    act(() => {
      saved = theme().save("Night", SEEDS, null);
    });
    expect(saved).toEqual({ id: "mine-1", reset: [] });
    expect(stored().mine).toEqual([{ id: "mine-1", name: "Night", seeds: SEEDS }]);
    act(() => theme().setMode("system"));
    expect(stored().mode).toBe("system");
    act(() => theme().setSlot("dark", "mine-1"));
    expect(stored().dark).toBe("mine-1");
    expect(voidNow()).toBe("#0B1630");
    let reset: readonly string[] = [];
    act(() => {
      reset = theme().remove("mine-1");
    });
    expect(reset).toEqual(["dark"]);
    expect(stored().dark).toBe("cyberdeck");
    act(() => theme().preview("paper"));
    act(() => theme().setDraft({ seeds: SEEDS, base: null }));
    act(() => theme().useCyberdeck());
    expect(stored()).toMatchObject({ mode: "fixed", active: "cyberdeck" });
    expect(theme().draft).toBeNull();
    expect(voidNow()).toBe("#0A0A14");
    expect(vi.mocked(toast).mock.calls).toEqual([["Unsaved colours discarded."]]);
  });

  it("useCyberdeck without a draft does not toast", () => {
    mount();
    act(() => theme().choose("paper"));
    act(() => theme().useCyberdeck());
    expect(toast).not.toHaveBeenCalled();
  });

  it("save reports a slot reset when a saved theme changes scheme", () => {
    mount({ ...DEFAULT_STORE, mode: "system" });
    act(() => {
      theme().save("Night", SEEDS, null);
    });
    act(() => theme().setSlot("dark", "mine-1"));
    let saved: { id: string; reset: readonly string[] } | null = null;
    act(() => {
      saved = theme().save("Night", { ground: "#FFFFFF", text: "#111418", accent: "#1F5FD1", highlight: "#A35400", danger: "#CC1F3D" }, "mine-1");
    });
    expect(saved).toEqual({ id: "mine-1", reset: ["dark"] });
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
    mount(DEFAULT_STORE, null, <Native platform="ios" />);
    act(() => theme().choose("paper"));
    expect(paintNative).not.toHaveBeenCalled();
  });

  it("paints the shown ground on macos and on each committed change", () => {
    mount(DEFAULT_STORE, null, <Native platform="macos" />);
    expect(lastPaint()).toEqual(["#0A0A14"]);
    act(() => theme().preview("phosphor"));
    expect(lastPaint()).toEqual(["#0A0A14"]);
    act(() => theme().choose("paper"));
    expect(lastPaint()).toEqual(["#FFFFFF"]);
  });

  it("toasts a rejection with details and logs it, once while it keeps failing", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const failure = new Error("not allowed");
    vi.mocked(paintNative).mockRejectedValue(failure);
    mount(DEFAULT_STORE, null, <Native platform="linux" />);
    await act(async () => {});
    act(() => theme().choose("paper"));
    await act(async () => {});
    expect(vi.mocked(paintNative).mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(vi.mocked(toast).mock.calls).toEqual([["Window colour could not be set: not allowed", "bad", expect.stringContaining("Error: not allowed")]]);
    expect(logged).toHaveBeenCalledWith(failure);
    logged.mockRestore();
  });
});

describe("useNativeScheme", () => {
  const schemes = (): unknown[] => tauri.calls.filter((c) => c.cmd === "appearance_set").map((c) => c.args);
  const settled = async (): Promise<void> => {
    await act(async () => {
      await new Promise<void>((r) => setTimeout(r, 0));
    });
  };

  beforeEach(() => {
    setPlatform(IPHONE);
    resetTauri({});
  });

  afterEach(() => {
    setPlatform(MAC);
    act(() => setSystemDark(true));
  });

  it("sends the shown scheme once on mount, even under StrictMode", async () => {
    mount(DEFAULT_STORE, null, <NativeScheme />);
    await settled();
    expect(tauri.calls).toEqual([{ cmd: "appearance_set", args: { scheme: "dark" }, options: undefined }]);
  });

  it("sends again on a theme switch, a preview and a draft, and nothing when only the tokens change", async () => {
    mount(DEFAULT_STORE, null, <NativeScheme />);
    await settled();
    act(() => theme().choose("phosphor"));
    await settled();
    expect(schemes()).toEqual([{ scheme: "dark" }]);
    act(() => theme().choose("paper"));
    await settled();
    expect(schemes()).toEqual([{ scheme: "dark" }, { scheme: "light" }]);
    act(() => theme().preview("blueprint"));
    await settled();
    act(() => theme().preview(null));
    await settled();
    expect(schemes()).toEqual([{ scheme: "dark" }, { scheme: "light" }, { scheme: "dark" }, { scheme: "light" }]);
    act(() => theme().setDraft({ seeds: SEEDS, base: null }));
    await settled();
    act(() => theme().setDraft({ seeds: { ...SEEDS, accent: "#FFD166" }, base: null }));
    await settled();
    expect(schemes()).toEqual([{ scheme: "dark" }, { scheme: "light" }, { scheme: "dark" }, { scheme: "light" }, { scheme: "dark" }]);
    expect(document.documentElement.dataset.scheme).toBe("dark");
  });

  const FOLLOWING: ThemeStore = { ...DEFAULT_STORE, mode: "system", dark: "phosphor", light: "paper" };
  const LIGHT_SEEDS: Seeds = { ground: "#FFFFFF", text: "#111418", accent: "#1F5FD1", highlight: "#A35400", danger: "#CC1F3D" };

  it("sends system once on mount while following the system", async () => {
    mount(FOLLOWING, null, <NativeScheme />);
    await settled();
    expect(tauri.calls).toEqual([{ cmd: "appearance_set", args: { scheme: "system" }, options: undefined }]);
  });

  it("sends nothing when the system flips while following the system", async () => {
    mount(FOLLOWING, null, <NativeScheme />);
    await settled();
    act(() => setSystemDark(false));
    await settled();
    expect(document.documentElement.dataset.scheme).toBe("light");
    act(() => setSystemDark(true));
    await settled();
    expect(document.documentElement.dataset.scheme).toBe("dark");
    expect(schemes()).toEqual([{ scheme: "system" }]);
  });

  it("sends dark for an explicit dark theme and system again on going back to following the system", async () => {
    mount(FOLLOWING, null, <NativeScheme />);
    await settled();
    act(() => theme().setMode("fixed"));
    act(() => theme().choose("blueprint"));
    await settled();
    expect(schemes()).toEqual([{ scheme: "system" }, { scheme: "dark" }]);
    act(() => theme().setMode("system"));
    await settled();
    expect(schemes()).toEqual([{ scheme: "system" }, { scheme: "dark" }, { scheme: "system" }]);
  });

  it("sends light for a preview of a light theme while following a dark system, and system when it ends", async () => {
    mount(FOLLOWING, null, <NativeScheme />);
    await settled();
    act(() => theme().preview("paper"));
    await settled();
    expect(schemes()).toEqual([{ scheme: "system" }, { scheme: "light" }]);
    act(() => theme().preview(null));
    await settled();
    expect(schemes()).toEqual([{ scheme: "system" }, { scheme: "light" }, { scheme: "system" }]);
  });

  it("sends the draft's scheme while following the system, and system when the draft is dropped", async () => {
    mount(FOLLOWING, null, <NativeScheme />);
    await settled();
    act(() => theme().setDraft({ seeds: LIGHT_SEEDS, base: null }));
    await settled();
    expect(schemes()).toEqual([{ scheme: "system" }, { scheme: "light" }]);
    act(() => theme().setDraft(null));
    await settled();
    expect(schemes()).toEqual([{ scheme: "system" }, { scheme: "light" }, { scheme: "system" }]);
  });

  it("sends a scheme asked for while a call failed with a fault that is not an AppError, and still reports the fault", async () => {
    const real = await vi.importActual<typeof import("../services/appearance")>("../services/appearance");
    const fault = new TypeError("appearance_set answered past its handler");
    vi.mocked(setNativeScheme).mockImplementationOnce((scheme) =>
      real.setNativeScheme(scheme).then(() => {
        throw fault;
      }),
    );
    const first = hold("appearance_set");
    mount(DEFAULT_STORE, null, <NativeScheme />);
    await settled();
    act(() => theme().choose("paper"));
    await settled();
    expect(schemes()).toEqual([{ scheme: "dark" }]);
    const rejected = nextUnhandled();
    await act(async () => {
      first.resolve(null);
    });
    const reason = await rejected;
    await settled();
    expect(reason).toBeInstanceOf(TypeError);
    expect(reason).toBe(fault);
    expect(schemes()).toEqual([{ scheme: "dark" }, { scheme: "light" }]);
  });

  it.each([MAC, LINUX])("sends nothing on $os, judged by the window's platform stamp", async (p) => {
    setPlatform(p);
    mount(DEFAULT_STORE, null, <NativeScheme />);
    await settled();
    act(() => theme().choose("paper"));
    await settled();
    expect(tauri.calls).toEqual([]);
    expect(vi.mocked(toast)).not.toHaveBeenCalled();
  });

  it("toasts a failed call with its message, once, and does not retry it", async () => {
    const message = "The dark appearance cannot be set on the window: its view is in no window.";
    resetTauri({
      appearance_set: () => {
        throw { code: "appearance.no_window", message };
      },
    });
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mount(DEFAULT_STORE, null, <NativeScheme />);
    await settled();
    await settled();
    expect(schemes()).toEqual([{ scheme: "dark" }]);
    expect(vi.mocked(toast).mock.calls).toEqual([[message, "bad", expect.stringMatching(new RegExp(`^appearance\\.no_window\\nAppError: ${message}`))]]);
    expect(logged.mock.calls).toEqual([[expect.objectContaining({ code: "appearance.no_window", message })]]);
    logged.mockRestore();
  });

  it("sends one call at a time and ends on the last scheme asked for", async () => {
    const first = hold("appearance_set");
    mount(DEFAULT_STORE, null, <NativeScheme />);
    await settled();
    act(() => theme().choose("paper"));
    act(() => theme().choose("cyberdeck"));
    act(() => theme().choose("daylight"));
    await settled();
    expect(schemes()).toEqual([{ scheme: "dark" }]);
    const second = hold("appearance_set");
    await act(async () => {
      first.resolve(null);
    });
    await settled();
    expect(schemes()).toEqual([{ scheme: "dark" }, { scheme: "light" }]);
    act(() => theme().choose("cyberdeck"));
    act(() => theme().choose("paper"));
    await settled();
    expect(schemes()).toEqual([{ scheme: "dark" }, { scheme: "light" }]);
    await act(async () => {
      second.resolve(null);
    });
    await settled();
    expect(schemes()).toEqual([{ scheme: "dark" }, { scheme: "light" }]);
    act(() => theme().choose("cyberdeck"));
    await settled();
    expect(schemes()).toEqual([{ scheme: "dark" }, { scheme: "light" }, { scheme: "dark" }]);
  });

  it("keeps the order when a call in flight fails", async () => {
    const first = hold("appearance_set");
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mount(DEFAULT_STORE, null, <NativeScheme />);
    await settled();
    act(() => theme().choose("paper"));
    await act(async () => {
      first.reject({ code: "appearance.stopped", message: "appearance_set stopped: the main thread dropped it without a result" });
    });
    await settled();
    expect(schemes()).toEqual([{ scheme: "dark" }, { scheme: "light" }]);
    expect(vi.mocked(toast).mock.calls).toEqual([
      ["appearance_set stopped: the main thread dropped it without a result", "bad", expect.stringMatching(/^appearance\.stopped\nAppError: appearance_set stopped/)],
    ]);
    expect(logged).toHaveBeenCalledTimes(1);
    logged.mockRestore();
  });

  describe("systemDark while UIKit's appearance is overridden", () => {
    const SYSTEM = { scheme: "system" };
    const DARK = { scheme: "dark" };

    const overriddenAndBack = async (start: () => void, end: () => void): Promise<void> => {
      setSystemDark(false);
      mount(FOLLOWING, null, <NativeScheme />);
      await settled();
      expect(schemes()).toEqual([SYSTEM]);
      expect(theme().shown.id).toBe("paper");
      act(start);
      await settled();
      expect(schemes()).toEqual([SYSTEM, DARK]);
      expect(theme().shown.id).toBe("paper");
      act(() => setSystemDark(true));
      expect(theme().systemDark).toBe(false);
      expect(theme().shown.id).toBe("paper");
      const released = hold("appearance_set");
      act(end);
      await settled();
      expect(schemes()).toEqual([SYSTEM, DARK, SYSTEM]);
      expect(theme().shown.id).toBe("paper");
      act(() => setSystemDark(false));
      expect(theme().shown.id).toBe("paper");
      await act(async () => {
        released.resolve(null);
      });
      await settled();
      expect(theme().systemDark).toBe(false);
      expect(theme().shown.id).toBe("paper");
    };

    it("keeps the light slot through a dark preview on a light iPhone that follows the system", async () => {
      await overriddenAndBack(
        () => theme().preview("blueprint"),
        () => theme().preview(null),
      );
    });

    it("keeps the light slot through a dark draft on a light iPhone that follows the system", async () => {
      await overriddenAndBack(
        () => theme().setDraft({ seeds: SEEDS, base: null }),
        () => theme().setDraft(null),
      );
    });

    it("reads the system again once system is acknowledged, so a sunset under an explicit dark theme shows the dark slot", async () => {
      setSystemDark(false);
      mount({ ...FOLLOWING, mode: "fixed", active: "blueprint" }, null, <NativeScheme />);
      await settled();
      expect(schemes()).toEqual([DARK]);
      setSystemDarkSilently(true);
      act(() => theme().setMode("system"));
      await settled();
      expect(schemes()).toEqual([DARK, SYSTEM]);
      expect(theme().systemDark).toBe(true);
      expect(theme().store.dark).toBe("blueprint");
      expect(theme().shown.id).toBe("blueprint");
    });

    it("follows a system flip at once while nothing is overridden", async () => {
      mount(FOLLOWING, null, <NativeScheme />);
      await settled();
      expect(theme().shown.id).toBe("phosphor");
      act(() => setSystemDark(false));
      expect(theme().shown.id).toBe("paper");
      act(() => setSystemDark(true));
      expect(theme().shown.id).toBe("phosphor");
      expect(schemes()).toEqual([SYSTEM]);
    });

    it("ignores a flip that arrives between sending dark and its acknowledgement", async () => {
      setSystemDark(false);
      mount(FOLLOWING, null, <NativeScheme />);
      await settled();
      const pending = hold("appearance_set");
      act(() => theme().preview("blueprint"));
      await settled();
      expect(schemes()).toEqual([SYSTEM, DARK]);
      act(() => setSystemDark(true));
      expect(theme().systemDark).toBe(false);
      expect(theme().shown.id).toBe("paper");
      await act(async () => {
        pending.resolve(null);
      });
      await settled();
      expect(theme().systemDark).toBe(false);
      expect(theme().shown.id).toBe("paper");
    });

    it("keeps holding after a failed system send, and lets go at the next acknowledged one", async () => {
      const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
      setSystemDark(false);
      mount(FOLLOWING, null, <NativeScheme />);
      await settled();
      act(() => theme().preview("blueprint"));
      await settled();
      act(() => setSystemDark(true));
      const failed = hold("appearance_set");
      act(() => theme().preview(null));
      await act(async () => {
        failed.reject({ code: "appearance.stopped", message: "appearance_set stopped: the main thread dropped it without a result" });
      });
      await settled();
      expect(schemes()).toEqual([SYSTEM, DARK, SYSTEM]);
      expect(vi.mocked(toast)).toHaveBeenCalledTimes(1);
      expect(theme().systemDark).toBe(false);
      act(() => setSystemDark(true));
      expect(theme().systemDark).toBe(false);
      act(() => theme().preview("blueprint"));
      await settled();
      act(() => theme().preview(null));
      await settled();
      expect(schemes()).toEqual([SYSTEM, DARK, SYSTEM, DARK, SYSTEM]);
      expect(theme().systemDark).toBe(true);
      expect(theme().shown.id).toBe("phosphor");
      logged.mockRestore();
    });

    it("keeps the light slot through a dark preview started while system is still in flight", async () => {
      setSystemDark(false);
      const pending = hold("appearance_set");
      mount(FOLLOWING, null, <NativeScheme />);
      await settled();
      expect(schemes()).toEqual([SYSTEM]);
      expect(theme().shown.id).toBe("paper");
      act(() => theme().preview("blueprint"));
      await settled();
      setSystemDarkSilently(true);
      await act(async () => {
        pending.resolve(null);
      });
      await settled();
      expect(schemes()).toEqual([SYSTEM, DARK]);
      expect(theme().systemDark).toBe(false);
      expect(theme().shown.id).toBe("paper");
      act(() => setSystemDark(true));
      expect(theme().shown.id).toBe("paper");
      setSystemDarkSilently(false);
      act(() => theme().preview(null));
      await settled();
      expect(schemes()).toEqual([SYSTEM, DARK, SYSTEM]);
      expect(theme().shown.id).toBe("paper");
      act(() => setSystemDark(true));
      expect(theme().shown.id).toBe("phosphor");
    });

    it("toasts a failed first system send without the kept-appearance note and keeps following the device", async () => {
      const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const message = "The system appearance cannot be set on the window: its view is in no window.";
      resetTauri({
        appearance_set: () => {
          throw { code: "appearance.no_window", message };
        },
      });
      setSystemDark(false);
      mount(FOLLOWING, null, <NativeScheme />);
      await settled();
      await settled();
      expect(schemes()).toEqual([SYSTEM]);
      expect(vi.mocked(toast).mock.calls).toEqual([[message, "bad", expect.stringMatching(new RegExp(`^appearance\\.no_window\\nAppError: ${message}`))]]);
      expect(logged.mock.calls).toEqual([[expect.objectContaining({ code: "appearance.no_window", message })]]);
      expect(theme().shown.id).toBe("paper");
      act(() => setSystemDark(true));
      expect(theme().shown.id).toBe("phosphor");
      logged.mockRestore();
    });

    it("says in the toast of a failed system send that the last known system appearance is kept", async () => {
      const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const message = "appearance_set stopped: the main thread dropped it without a result";
      setSystemDark(false);
      mount(FOLLOWING, null, <NativeScheme />);
      await settled();
      act(() => theme().preview("blueprint"));
      await settled();
      const failed = hold("appearance_set");
      act(() => theme().preview(null));
      await act(async () => {
        failed.reject({ code: "appearance.stopped", message });
      });
      await settled();
      expect(schemes()).toEqual([SYSTEM, DARK, SYSTEM]);
      expect(vi.mocked(toast).mock.calls).toEqual([[`${message}${SYSTEM_KEPT}`, "bad", expect.stringMatching(/^appearance\.stopped\nAppError: appearance_set stopped/)]]);
      expect(SYSTEM_KEPT).toBe(" WebBoard keeps the last known system appearance until the theme changes again.");
      logged.mockRestore();
    });

    it("on the Mac a flip under an explicit theme or a preview still reaches systemDark", async () => {
      setPlatform(MAC);
      mount({ ...FOLLOWING, mode: "fixed", active: "blueprint" }, null, <NativeScheme />);
      await settled();
      act(() => setSystemDark(false));
      expect(theme().systemDark).toBe(false);
      act(() => theme().setMode("system"));
      act(() => theme().preview("blueprint"));
      act(() => setSystemDark(true));
      expect(theme().systemDark).toBe(true);
      expect(theme().shown.id).toBe("blueprint");
      expect(tauri.calls).toEqual([]);
    });
  });
});
