import { act, cleanup, fireEvent, render, renderHook, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { toast } from "../common/Toast";
import { ImageReadError, readImageColours } from "../../theme/image";
import { DEFAULT_STORE, THEME_KEY, type ThemeStore } from "../../theme/store";
import { ThemeProvider } from "../../theme/ThemeContext";
import { installMatchMedia, setSystemDark } from "../../test/matchMedia";
import { DISCARDED, THEME_TITLE, ThemePanel, useCanHover } from "./ThemePanel";

vi.mock("../common/Toast", () => ({ toast: vi.fn() }));
vi.mock("../../theme/image", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../theme/image")>();
  return { ...real, readImageColours: vi.fn() };
});

const SUNSET = "#FFEABA #FED3A4 #FEC759 #FEB484 #FF96A6 #F58A65";

afterEach(() => {
  cleanup();
  vi.mocked(toast).mockClear();
  vi.mocked(readImageColours).mockReset();
});

const voidNow = (): string => document.documentElement.style.getPropertyValue("--void");

const mount = (frame: "panel" | "sheet", hover = false, store: ThemeStore = DEFAULT_STORE) => {
  const onClose = vi.fn();
  const view = render(
    <ThemeProvider storage={window.localStorage} initial={{ store, unreadable: null }}>
      <ThemePanel frame={frame} hover={hover} onClose={onClose} />
    </ThemeProvider>,
  );
  return { ...view, onClose };
};

const cards = (root: HTMLElement): HTMLElement => within(root).getByRole("group", { name: "Themes" });

const card = (root: HTMLElement, name: RegExp): HTMLElement => within(cards(root)).getByRole("button", { name });

const hexField = (root: HTMLElement, role: string): HTMLInputElement => {
  const el = within(root).getByRole("textbox", { name: `${role} hex` });
  if (!(el instanceof HTMLInputElement)) throw new Error("not an input");
  return el;
};

const typeHex = (root: HTMLElement, role: string, value: string): void => {
  const field = hexField(root, role);
  fireEvent.change(field, { target: { value } });
  fireEvent.blur(field);
};

const checkRow = (root: HTMLElement, label: string): HTMLElement => {
  const row = within(root).getByText(label).closest(".theme-check");
  if (!(row instanceof HTMLElement)) throw new Error(`no check row ${label}`);
  return row;
};

const saveButton = (root: HTMLElement): HTMLButtonElement => {
  const b = within(root).getByRole("button", { name: "Save theme" });
  if (!(b instanceof HTMLButtonElement)) throw new Error("not a button");
  return b;
};

const saveAs = (root: HTMLElement, name: string): void => {
  fireEvent.change(within(root).getByPlaceholderText("Name, e.g. Night shift"), { target: { value: name } });
  fireEvent.click(saveButton(root));
};

const notes = (root: HTMLElement): string[] => [...root.querySelectorAll(".theme-notes li")].map((li) => li.textContent ?? "");

describe("ThemePanel", () => {
  it("names itself Theme in both frames", () => {
    expect(THEME_TITLE).toBe("Theme");
    expect(DISCARDED).toBe("Unsaved colours discarded.");
    const a = mount("panel");
    const region = a.getByRole("region", { name: "Theme" });
    expect(within(region).getByRole("heading", { level: 2, name: "Theme" })).toBeTruthy();
    a.unmount();
    const b = mount("sheet");
    expect(b.getByRole("dialog", { name: "Theme" })).toBeTruthy();
  });

  it("lists 15 built-in cards under WebBoard and From colorfetcher.com, without Yours", () => {
    const { getByRole } = mount("panel");
    const region = getByRole("region", { name: "Theme" });
    const grid = cards(region);
    expect(within(grid).getAllByRole("button")).toHaveLength(15);
    expect(within(grid).getByRole("heading", { name: "WebBoard" })).toBeTruthy();
    expect(within(grid).getByRole("heading", { name: "From colorfetcher.com" })).toBeTruthy();
    expect(within(grid).queryByRole("heading", { name: "Yours" })).toBeNull();
    expect(card(region, /^Cyberdeck/).getAttribute("aria-pressed")).toBe("true");
  });

  it("chooses a card on click", () => {
    const { getByRole } = mount("panel");
    const region = getByRole("region", { name: "Theme" });
    fireEvent.click(card(region, /^Paper/));
    expect(card(region, /^Paper/).getAttribute("aria-pressed")).toBe("true");
    expect(card(region, /^Cyberdeck/).getAttribute("aria-pressed")).toBe("false");
    expect(voidNow()).toBe("#FFFFFF");
    expect(JSON.parse(window.localStorage.getItem(THEME_KEY) ?? "{}").active).toBe("paper");
  });

  it("previews on hover and restores when the pointer leaves the cards", () => {
    const { getByRole } = mount("panel", true);
    const region = getByRole("region", { name: "Theme" });
    fireEvent.pointerEnter(card(region, /^Phosphor/));
    expect(voidNow()).toBe("#060C09");
    fireEvent.pointerLeave(cards(region));
    expect(voidNow()).toBe("#0A0A14");
    fireEvent.focus(card(region, /^Paper/));
    expect(voidNow()).toBe("#FFFFFF");
    fireEvent.blur(card(region, /^Paper/));
    expect(voidNow()).toBe("#0A0A14");
  });

  it("does not preview without hover", () => {
    const { getByRole } = mount("panel", false);
    const region = getByRole("region", { name: "Theme" });
    fireEvent.pointerEnter(card(region, /^Phosphor/));
    expect(voidNow()).toBe("#0A0A14");
  });

  it("shows the slot selects when following the system and tags the cards", () => {
    const { getByRole, getByLabelText, queryByLabelText } = mount("panel");
    const region = getByRole("region", { name: "Theme" });
    expect(queryByLabelText("When dark")).toBeNull();
    const sw = getByRole("switch", { name: "Follow the system" });
    expect(sw.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(sw);
    expect(sw.getAttribute("aria-checked")).toBe("true");
    const dark = getByLabelText("When dark");
    const light = getByLabelText("When light");
    if (!(dark instanceof HTMLSelectElement) || !(light instanceof HTMLSelectElement)) throw new Error("not selects");
    expect(dark.value).toBe("cyberdeck");
    expect(light.value).toBe("daylight");
    expect([...light.options].map((o) => o.value)).not.toContain("cyberdeck");
    expect(within(card(region, /^Cyberdeck/)).getByText("When dark")).toBeTruthy();
    expect(within(card(region, /^Daylight/)).getByText("When light")).toBeTruthy();
    fireEvent.change(dark, { target: { value: "phosphor" } });
    expect(voidNow()).toBe("#060C09");
  });

  it("normalises hex fields and marks bad ones invalid", () => {
    const { getByRole } = mount("panel");
    const region = getByRole("region", { name: "Theme" });
    typeHex(region, "Accent", "24e0ff");
    expect(hexField(region, "Accent").value).toBe("#24E0FF");
    expect(hexField(region, "Accent").getAttribute("aria-invalid")).toBe("false");
    typeHex(region, "Highlight", "#abc");
    expect(hexField(region, "Highlight").value).toBe("#AABBCC");
    expect(document.documentElement.style.getPropertyValue("--amber")).toBe("#AABBCC");
    fireEvent.change(hexField(region, "Accent"), { target: { value: "zz" } });
    expect(hexField(region, "Accent").getAttribute("aria-invalid")).toBe("true");
    expect(document.documentElement.style.getPropertyValue("--cyan")).toBe("#24E0FF");
    expect(within(region).getByText("Unsaved")).toBeTruthy();
  });

  it("follows the colour picker", () => {
    const { getByRole } = mount("panel");
    const region = getByRole("region", { name: "Theme" });
    fireEvent.change(within(region).getByLabelText("Background"), { target: { value: "#222233" } });
    expect(voidNow()).toBe("#222233");
    expect(hexField(region, "Background").value).toBe("#222233");
  });

  it("offers Fix for a failing check and only saves once it passes", () => {
    const { getByRole } = mount("panel");
    const region = getByRole("region", { name: "Theme" });
    expect(saveButton(region).disabled).toBe(true);
    typeHex(region, "Accent", "#333344");
    const row = checkRow(region, "Accent on background");
    expect(saveButton(region).disabled).toBe(true);
    fireEvent.click(within(row).getByRole("button", { name: "Fix" }));
    expect(within(checkRow(region, "Accent on background")).queryByRole("button", { name: "Fix" })).toBeNull();
    expect(saveButton(region).disabled).toBe(false);
  });

  it("shows ratios, degrees and yes/no with badges", () => {
    const { getByRole } = mount("panel");
    const region = getByRole("region", { name: "Theme" });
    const text = checkRow(region, "Text on background");
    expect(within(text).getByText(/^\d+\.\d:1$/)).toBeTruthy();
    expect(within(text).getByText("AAA")).toBeTruthy();
    expect(within(checkRow(region, "Danger apart from highlight")).getByText(/^\d+°$/)).toBeTruthy();
    expect(within(checkRow(region, "Danger is red")).getByText("yes")).toBeTruthy();
    expect(within(checkRow(region, "Danger is red")).getByText("OK")).toBeTruthy();
  });

  it("saves, refuses a duplicate name, and deletes in two steps", () => {
    const { getByRole } = mount("panel");
    const region = getByRole("region", { name: "Theme" });
    typeHex(region, "Accent", "#7CC4FF");
    saveAs(region, "Night shift");
    const grid = cards(region);
    expect(within(grid).getByRole("heading", { name: "Yours" })).toBeTruthy();
    expect(card(region, /^Night shift/).getAttribute("aria-pressed")).toBe("true");
    expect(within(region).queryByText("Unsaved")).toBeNull();
    typeHex(region, "Accent", "#7CC4EE");
    saveAs(region, "night shift");
    expect(notes(region)).toContain("You already have a theme called night shift.");
    fireEvent.click(within(region).getByRole("button", { name: "Use Cyberdeck" }));
    fireEvent.click(card(region, /^Night shift/));
    fireEvent.click(within(region).getByRole("button", { name: "Delete" }));
    fireEvent.click(within(region).getByRole("button", { name: "Delete Night shift" }));
    expect(within(cards(region)).queryByRole("button", { name: /^Night shift/ })).toBeNull();
    expect(within(cards(region)).queryByRole("heading", { name: "Yours" })).toBeNull();
    expect(card(region, /^Cyberdeck/).getAttribute("aria-pressed")).toBe("true");
  });

  it("saves changes to an edited theme of your own", () => {
    const { getByRole } = mount("panel");
    const region = getByRole("region", { name: "Theme" });
    typeHex(region, "Accent", "#7CC4FF");
    saveAs(region, "Night shift");
    typeHex(region, "Accent", "#7CC4EE");
    expect(within(card(region, /^Night shift/)).getByText("Edited")).toBeTruthy();
    fireEvent.click(within(region).getByRole("button", { name: "Save changes" }));
    expect(within(cards(region)).getAllByRole("button", { name: /^Night shift/ })).toHaveLength(1);
    expect(document.documentElement.style.getPropertyValue("--cyan")).toBe("#7CC4EE");
    expect(within(region).queryByText("Unsaved")).toBeNull();
  });

  it("makes a theme from a pasted palette", () => {
    const { getByRole } = mount("panel");
    const region = getByRole("region", { name: "Theme" });
    fireEvent.change(within(region).getByPlaceholderText("Paste hex codes, or the CSS variables colorfetcher.com exports"), { target: { value: SUNSET } });
    fireEvent.click(within(region).getByRole("button", { name: "Make a dark theme" }));
    expect(notes(region)[0]).toBe("Used 6 colours.");
    expect(within(region).getByText("Unsaved")).toBeTruthy();
    expect(saveButton(region).disabled).toBe(false);
  });

  it("never offers a pasted palette as changes to the saved theme on show", () => {
    const night = { id: "mine-1", name: "Night", note: "Yours", group: "mine" as const, seeds: { ground: "#0B1630", text: "#C9D6EA", accent: "#7CC4FF", highlight: "#FFD166", danger: "#FF6B88" } };
    const { getByRole } = mount("panel", false, { ...DEFAULT_STORE, active: "mine-1", mine: [night] });
    const region = getByRole("region", { name: "Theme" });
    fireEvent.change(within(region).getByPlaceholderText("Paste hex codes, or the CSS variables colorfetcher.com exports"), { target: { value: SUNSET } });
    fireEvent.click(within(region).getByRole("button", { name: "Make a dark theme" }));
    expect(within(region).getByText("Unsaved")).toBeTruthy();
    expect(within(region).queryByRole("button", { name: "Save changes" })).toBeNull();
    expect(within(card(region, /^Night/)).queryByText("Edited")).toBeNull();
    expect(toast).not.toHaveBeenCalled();
  });

  it("says so when a pasted palette replaces unsaved edits of a saved theme", () => {
    const night = { id: "mine-1", name: "Night", note: "Yours", group: "mine" as const, seeds: { ground: "#0B1630", text: "#C9D6EA", accent: "#7CC4FF", highlight: "#FFD166", danger: "#FF6B88" } };
    const { getByRole } = mount("panel", false, { ...DEFAULT_STORE, active: "mine-1", mine: [night] });
    const region = getByRole("region", { name: "Theme" });
    typeHex(region, "Accent", "#7CC4EE");
    expect(within(region).getByRole("button", { name: "Save changes" })).toBeTruthy();
    fireEvent.change(within(region).getByPlaceholderText("Paste hex codes, or the CSS variables colorfetcher.com exports"), { target: { value: SUNSET } });
    fireEvent.click(within(region).getByRole("button", { name: "Make a dark theme" }));
    expect(vi.mocked(toast).mock.calls).toEqual([[DISCARDED]]);
    expect(within(region).queryByRole("button", { name: "Save changes" })).toBeNull();
    typeHex(region, "Accent", "#7CC4FF");
    expect(within(region).queryByRole("button", { name: "Save changes" })).toBeNull();
  });

  it("asks for at least three pasted colours", () => {
    const { getByRole } = mount("panel");
    const region = getByRole("region", { name: "Theme" });
    const area = within(region).getByPlaceholderText("Paste hex codes, or the CSS variables colorfetcher.com exports");
    fireEvent.change(area, { target: { value: "#123456" } });
    fireEvent.click(within(region).getByRole("button", { name: "Make a light theme" }));
    expect(notes(region)).toEqual(["Found 1 colour; paste at least three."]);
    fireEvent.change(area, { target: { value: "#123456 #654321" } });
    fireEvent.click(within(region).getByRole("button", { name: "Make a light theme" }));
    expect(notes(region)).toEqual(["Found 2 colours; paste at least three."]);
  });

  it("reads colours from an image and shows its errors as a note", async () => {
    vi.mocked(readImageColours).mockResolvedValueOnce(["#FFEABA", "#FEC759", "#FF96A6", "#292214"]);
    const { getByRole } = mount("panel");
    const region = getByRole("region", { name: "Theme" });
    fireEvent.click(within(region).getByRole("button", { name: "From an image" }));
    expect(within(region).getByText("Drop an image here, or choose one. It stays on this device.")).toBeTruthy();
    const input = within(region).getByLabelText("Choose an image");
    const file = new File(["x"], "sunset.png", { type: "image/png" });
    await act(async () => {
      fireEvent.change(input, { target: { files: [file] } });
    });
    expect(region.querySelectorAll(".theme-strip .theme-swatch")).toHaveLength(4);
    fireEvent.click(within(region).getByRole("button", { name: "Make a dark theme" }));
    expect(notes(region)[0]).toBe("Used 4 colours.");
    vi.mocked(readImageColours).mockRejectedValueOnce(new ImageReadError("broken.png is not an image WebBoard can read."));
    await act(async () => {
      fireEvent.drop(within(region).getByText("Drop an image here, or choose one. It stays on this device.").closest(".theme-drop") ?? region, {
        dataTransfer: { files: [new File(["x"], "broken.png")] },
      });
    });
    expect(notes(region)).toEqual(["broken.png is not an image WebBoard can read."]);
  });

  it("discards a draft on close, toasts, and restores the committed theme", () => {
    const { getByRole, onClose } = mount("panel");
    const region = getByRole("region", { name: "Theme" });
    typeHex(region, "Background", "#222222");
    expect(voidNow()).toBe("#222222");
    fireEvent.click(within(region).getByRole("button", { name: "Close" }));
    expect(toast).toHaveBeenCalledWith(DISCARDED);
    expect(voidNow()).toBe("#0A0A14");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes without a toast when there is no draft", () => {
    const { getByRole, onClose } = mount("sheet");
    fireEvent.click(within(getByRole("dialog", { name: "Theme" })).getByRole("button", { name: "Close" }));
    expect(toast).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes on Escape inside the panel", () => {
    const { getByRole, onClose } = mount("panel");
    const region = getByRole("region", { name: "Theme" });
    fireEvent.keyDown(hexField(region, "Text"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("tags a saved theme that fails today's checks", () => {
    const murky = { id: "mine-1", name: "Murky", note: "Yours", group: "mine" as const, seeds: { ground: "#0A0A14", text: "#C8D3E0", accent: "#333344", highlight: "#FFB000", danger: "#FF3B6B" } };
    const { getByRole } = mount("panel", false, { ...DEFAULT_STORE, mine: [murky] });
    const region = getByRole("region", { name: "Theme" });
    expect(within(card(region, /^Murky/)).getByText("Fails checks")).toBeTruthy();
    expect(within(card(region, /^Cyberdeck/)).queryByText("Fails checks")).toBeNull();
  });

  it("goes back to Cyberdeck, toasting the discarded draft", () => {
    const { getByRole } = mount("panel");
    const region = getByRole("region", { name: "Theme" });
    fireEvent.click(card(region, /^Paper/));
    typeHex(region, "Accent", "#7CC4FF");
    fireEvent.click(within(region).getByRole("button", { name: "Use Cyberdeck" }));
    expect(voidNow()).toBe("#0A0A14");
    expect(card(region, /^Cyberdeck/).getAttribute("aria-pressed")).toBe("true");
    expect(within(region).queryByText("Unsaved")).toBeNull();
    expect(vi.mocked(toast).mock.calls).toEqual([[DISCARDED]]);
  });

  it("lets an image-reading bug escape as an unhandled rejection instead of becoming a note", async () => {
    const bug = new TypeError("medianCut broke");
    vi.mocked(readImageColours).mockRejectedValueOnce(bug);
    const seen: unknown[] = [];
    const onRejection = (reason: unknown): void => {
      seen.push(reason);
    };
    const node = (globalThis as unknown as { process: { on(e: string, cb: (r: unknown) => void): void; off(e: string, cb: (r: unknown) => void): void } }).process;
    node.on("unhandledRejection", onRejection);
    const { getByRole } = mount("panel");
    const region = getByRole("region", { name: "Theme" });
    fireEvent.click(within(region).getByRole("button", { name: "From an image" }));
    await act(async () => {
      fireEvent.change(within(region).getByLabelText("Choose an image"), { target: { files: [new File(["x"], "a.png")] } });
    });
    await new Promise((r) => setTimeout(r, 0));
    node.off("unhandledRejection", onRejection);
    expect(seen).toEqual([bug]);
    expect(notes(region)).toEqual([]);
  });

  it("deletes a saved light theme while following the system in dark mode", () => {
    const day = { id: "mine-1", name: "Noon", note: "Yours", group: "mine" as const, seeds: { ground: "#FFFFFF", text: "#111418", accent: "#1F5FD1", highlight: "#A35400", danger: "#CC1F3D" } };
    setSystemDark(true);
    const { getByRole } = mount("panel", false, { ...DEFAULT_STORE, mode: "system", mine: [day] });
    const region = getByRole("region", { name: "Theme" });
    expect(within(region).queryByRole("button", { name: "Delete" })).toBeNull();
    fireEvent.click(card(region, /^Noon/));
    expect(voidNow()).toBe("#0A0A14");
    expect(hexField(region, "Background").value).toBe("#FFFFFF");
    fireEvent.click(within(region).getByRole("button", { name: "Delete" }));
    fireEvent.click(within(region).getByRole("button", { name: "Delete Noon" }));
    expect(within(cards(region)).queryByRole("button", { name: /^Noon/ })).toBeNull();
    expect(notes(region)).toEqual(["When light uses Daylight again."]);
    expect(JSON.parse(window.localStorage.getItem(THEME_KEY) ?? "{}").light).toBe("daylight");
  });

  it("says when saving changes moves a theme out of its slot", () => {
    setSystemDark(true);
    const night = { id: "mine-1", name: "Night", note: "Yours", group: "mine" as const, seeds: { ground: "#0B1630", text: "#C9D6EA", accent: "#7CC4FF", highlight: "#FFD166", danger: "#FF6B88" } };
    const { getByRole } = mount("panel", false, { ...DEFAULT_STORE, mode: "system", dark: "mine-1", mine: [night] });
    const region = getByRole("region", { name: "Theme" });
    typeHex(region, "Background", "#FFFFFF");
    typeHex(region, "Text", "#111418");
    typeHex(region, "Accent", "#1F5FD1");
    typeHex(region, "Highlight", "#A35400");
    typeHex(region, "Danger", "#CC1F3D");
    fireEvent.click(within(region).getByRole("button", { name: "Save changes" }));
    expect(notes(region)).toEqual(["Night is no longer a dark theme, so When dark uses Cyberdeck."]);
  });

  it("keeps Save changes for an edited saved theme across a remount", () => {
    const night = { id: "mine-1", name: "Night", note: "Yours", group: "mine" as const, seeds: { ground: "#0B1630", text: "#C9D6EA", accent: "#7CC4FF", highlight: "#FFD166", danger: "#FF6B88" } };
    const onClose = vi.fn();
    const store = { ...DEFAULT_STORE, active: "mine-1", mine: [night] };
    const view = render(
      <ThemeProvider storage={window.localStorage} initial={{ store, unreadable: null }}>
        <ThemePanel frame="panel" hover={false} onClose={onClose} />
      </ThemeProvider>,
    );
    typeHex(view.getByRole("region", { name: "Theme" }), "Accent", "#7CC4EE");
    view.rerender(
      <ThemeProvider storage={window.localStorage} initial={{ store, unreadable: null }}>
        <ThemePanel key="sheet" frame="sheet" hover={false} onClose={onClose} />
      </ThemeProvider>,
    );
    const sheet = view.getByRole("dialog", { name: "Theme" });
    expect(within(sheet).getByText("Unsaved")).toBeTruthy();
    expect(within(card(sheet, /^Night/)).getByText("Edited")).toBeTruthy();
    expect(within(sheet).getByRole("button", { name: "Save changes" })).toBeTruthy();
  });

  it("marks your own themes in the slot selects", () => {
    const sunset = { id: "mine-1", name: "Sunset", note: "Yours", group: "mine" as const, seeds: { ground: "#0B1630", text: "#C9D6EA", accent: "#7CC4FF", highlight: "#FFD166", danger: "#FF6B88" } };
    const { getByLabelText } = mount("panel", false, { ...DEFAULT_STORE, mode: "system", mine: [sunset] });
    const dark = getByLabelText("When dark");
    if (!(dark instanceof HTMLSelectElement)) throw new Error("not a select");
    expect([...dark.options].filter((o) => o.textContent?.startsWith("Sunset")).map((o) => o.textContent)).toEqual(["Sunset", "Sunset (yours)"]);
  });

  it("shows a save validation error as a note", () => {
    const { getByRole } = mount("panel");
    const region = getByRole("region", { name: "Theme" });
    typeHex(region, "Accent", "#7CC4FF");
    saveAs(region, "x".repeat(41));
    expect(notes(region)).toEqual(["Use at most 40 characters."]);
  });
});

describe("useCanHover", () => {
  afterEach(() => installMatchMedia());

  it("follows (hover: hover) as it changes, and unsubscribes on unmount", () => {
    const listeners = new Set<() => void>();
    let matches = false;
    const queries: string[] = [];
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      writable: true,
      value: (query: string) => {
        queries.push(query);
        return {
          get matches() {
            return matches;
          },
          addEventListener: (_: string, cb: () => void) => listeners.add(cb),
          removeEventListener: (_: string, cb: () => void) => listeners.delete(cb),
        };
      },
    });
    const { result, unmount } = renderHook(() => useCanHover());
    expect(result.current).toBe(false);
    act(() => {
      matches = true;
      listeners.forEach((cb) => cb());
    });
    expect(result.current).toBe(true);
    expect(new Set(queries)).toEqual(new Set(["(hover: hover)"]));
    unmount();
    expect(listeners.size).toBe(0);
  });
});
