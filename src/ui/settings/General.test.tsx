import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fixedClock } from "../../services/clock";
import type { PlanSession } from "../../store/session";
import { IPAD, IPHONE, MAC, setPlatform, stubVisualViewport } from "../../test/platform";
import { emitFromRust, resetTauri, tauri } from "../../test/tauriMock";
import { TEST_PLAN, testSession, type SeedItem, type TestSession } from "../../test/session";
import { shellFor } from "../../test/shell";
import { deviced } from "../../test/theme";
import { withSync } from "../../test/withSync";
import { DEFAULT_STORE } from "../../theme/store";
import { ThemeProvider } from "../../theme/ThemeContext";
import { clearToasts, Toasts } from "../common/Toast";
import { normalizeName } from "../../actions/build";
import { peopleOf } from "../../domain/people";
import { DEFAULT_DEVICE, DEVICE_KEY } from "../device";
import { useUi, type UiState } from "../state";
import { CSV_KEEPS_ISO, General, NO_PLAN_ME, TAB_HINT, WEEK_HINT } from "./General";
import { SettingsView } from "./Settings";

vi.mock("@tauri-apps/api/core", () => import("../../test/tauriMock"));
vi.mock("@tauri-apps/api/event", () => import("../../test/tauriMock"));
vi.mock("../state", async (importOriginal) => {
  const m = await importOriginal<typeof import("../state")>();
  return { ...m, useUi: vi.fn(m.useUi) };
});

const sessions: PlanSession[] = [];

let unstub: () => void = () => {};

beforeEach(() => {
  window.localStorage.clear();
  setPlatform(MAC);
  resetTauri({});
  unstub = stubVisualViewport();
});

afterEach(async () => {
  cleanup();
  unstub();
  clearToasts();
  vi.mocked(useUi).mockClear();
  await Promise.all(sessions.splice(0).map((s) => s.close()));
  window.localStorage.clear();
  setPlatform(MAC);
});

const SEED: readonly SeedItem[] = [{ id: "a", name: "Pour the pier", start: "2026-11-10", dur: 3 }];

const made = async (): Promise<TestSession> => {
  const t = await testSession(SEED, { today: "2026-11-09" });
  sessions.push(t.session);
  return t;
};

const settle = async (): Promise<void> => {
  await act(async () => {
    await new Promise<void>((r) => setTimeout(r, 0));
    await new Promise<void>((r) => setTimeout(r, 0));
  });
};

const setUiNow = (patch: Partial<UiState>): void => {
  const results = vi.mocked(useUi).mock.results;
  const r = results[results.length - 1];
  if (r === undefined || r.type !== "return") throw new Error("useUi has not returned");
  act(() => r.value[1](patch));
};

const one = (sel: string, root: ParentNode = document): HTMLElement => {
  const el = root.querySelector(sel);
  if (!(el instanceof HTMLElement)) throw new Error("no " + sel);
  return el;
};

const all = (sel: string, root: ParentNode = document): HTMLElement[] => [...root.querySelectorAll(sel)].filter((e): e is HTMLElement => e instanceof HTMLElement);

const group = (field: string): HTMLElement => one(`.seg.general-seg[role="radiogroup"][data-general="${field}"]`);

const radios = (field: string): [string | null, string | null, number][] => all('[role="radio"]', group(field)).map((r) => [r.textContent, r.getAttribute("aria-checked"), r.tabIndex]);

const radio = (field: string, text: string): HTMLElement => {
  const el = all('[role="radio"]', group(field)).find((r) => r.textContent === text);
  if (el === undefined) throw new Error(`no ${text} in ${field}`);
  return el;
};

const pick = (field: string, text: string): void => {
  act(() => {
    fireEvent.click(radio(field, text));
  });
};

const stored = (): unknown => JSON.parse(window.localStorage.getItem(DEVICE_KEY) ?? "null");

const hintText = (el: HTMLElement): string | null => {
  const id = el.getAttribute("aria-describedby");
  if (id === null) throw new Error("no hint");
  return document.getElementById(id)?.textContent ?? null;
};

const hintOf = (row: string): string | null => {
  const id = group(row).getAttribute("aria-describedby");
  if (id === null) throw new Error(`${row} has no hint`);
  return document.getElementById(id)?.textContent ?? null;
};

const general = (): void => {
  render(deviced(<General session={null} device="Rokas’s Mac" renameDevice={vi.fn()} clock={fixedClock("2026-11-09")} updates={null} onPeople={vi.fn()} />));
};

const generalFor = (session: PlanSession, o: { device?: string; renameDevice?: (name: string) => void; onPeople?: () => void } = {}) =>
  render(
    deviced(
      <>
        <General session={session} device={o.device ?? "Rokas’s Mac"} renameDevice={o.renameDevice ?? vi.fn()} clock={fixedClock("2026-11-09")} updates={null} onPeople={o.onPeople ?? vi.fn()} />
        <Toasts />
      </>,
    ),
  );

const mePick = (): HTMLElement => one('[data-settings-row="general.me"] button.settings-pick[data-pick="me"]');

const meStatus = (): HTMLElement => one('[data-settings-row="general.me"] p.settings-row-status[role="status"]');

const menuRows = (): [string | null, string | null][] => [...document.querySelectorAll('.context-menu [role^="menuitem"]')].map((e) => [e.textContent, e.getAttribute("aria-checked")]);

const choose = (row: string): void => {
  const el = [...document.querySelectorAll<HTMLElement>('.context-menu [role^="menuitem"]')].find((e) => e.textContent === row);
  if (el === undefined) throw new Error("no menu row " + row);
  act(() => {
    fireEvent.click(el);
  });
};

const openMe = (): void => {
  act(() => {
    fireEvent.click(mePick());
  });
};

const addCrew = (t: TestSession): Record<string, string> => {
  act(() => {
    [
      ["Mira Okafor", "MO"],
      ["Dana Lee", "DL"],
    ].forEach(([name, initials]) => {
      const known = peopleOf(t.session.view().plan);
      t.session.apply({ t: "person", op: "add", name, initials, colour: "sky", after: known.length === 0 ? null : known[known.length - 1].id });
    });
  });
  return Object.fromEntries(peopleOf(t.session.view().plan).map((p) => [p.initials, p.id]));
};

const deviceField = (): HTMLInputElement => {
  const el = one('[data-settings-row="general.device"] input.settings-device-name');
  if (!(el instanceof HTMLInputElement)) throw new Error("the device name is not an input");
  return el;
};

const typeName = (text: string): void => {
  act(() => {
    fireEvent.change(deviceField(), { target: { value: text } });
    fireEvent.keyDown(deviceField(), { key: "Enter" });
  });
};

const toastTexts = (): (string | null)[] => all(".toasts .toast").map((e) => e.textContent);

const pull = (field: string): HTMLElement => one(`button.settings-pick[data-pick="${field}"][aria-haspopup="menu"]`);

const openPull = (field: string): void => {
  act(() => {
    fireEvent.click(pull(field));
  });
};

interface SentMenu {
  token: string;
  sections: { title: string | null; rows: { id: string; title: string; checked: boolean }[] }[];
}

const lastAsk = (): SentMenu => {
  const sent = tauri.calls.filter((c) => c.cmd === "menu_show").map((c) => (c.args as { menu: SentMenu }).menu);
  const last = sent[sent.length - 1];
  if (last === undefined) throw new Error("no menu_show was sent");
  return last;
};

const nativeRows = (): [string, string, boolean][] => lastAsk().sections.flatMap((s) => s.rows.map((r): [string, string, boolean] => [r.id, r.title, r.checked]));

const chooseNative = (id: string): void => {
  const { token } = lastAsk();
  act(() => {
    emitFromRust("menu-ended", { token });
    emitFromRust("menu-chosen", { token, id });
  });
};

describe("the General rows", () => {
  it("shows Default tab, Week starts on and Date format with their hints and the current choice", () => {
    general();
    expect(all(".settings-row").map((r) => [r.dataset["settingsRow"], r.querySelector(".settings-label")?.textContent])).toEqual([
      ["general.tab", "Default tab"],
      ["general.week", "Week starts on"],
      ["general.dates", "Date format"],
      ["general.me", "This is me"],
      ["general.device", "Device name"],
      ["general.about", "About"],
    ]);
    expect([group("tab").getAttribute("aria-label"), group("week").getAttribute("aria-label"), group("dates").getAttribute("aria-label")]).toEqual(["Default tab", "Week starts on", "Date format"]);
    expect(radios("tab")).toEqual([
      ["Timeline", "true", 0],
      ["Board", "false", -1],
      ["List", "false", -1],
    ]);
    expect(radios("week")).toEqual([
      ["Monday", "true", 0],
      ["Sunday", "false", -1],
    ]);
    expect(radios("dates")).toEqual([
      ["System", "true", 0],
      ["ISO", "false", -1],
      ["D.M.YYYY", "false", -1],
    ]);
    expect([hintOf("tab"), hintOf("week"), hintOf("dates")]).toEqual([TAB_HINT, WEEK_HINT, `Today reads 9 Nov. ${CSV_KEEPS_ISO}`]);
    expect([TAB_HINT, WEEK_HINT]).toEqual(["Used when WebBoard has no last place to reopen.", "The Timeline, printed weeks and Working days start on this day. Date pickers follow the system."]);
    expect(one('[data-settings-row="general.dates"] .settings-hint span.mono').textContent).toBe("9 Nov");
  });

  it("saves each choice on this device and repaints the hint in the chosen format", () => {
    general();
    pick("tab", "List");
    pick("week", "Sunday");
    pick("dates", "ISO");
    expect(stored()).toEqual({ ...DEFAULT_DEVICE, tab: "list", week: 7, dates: "iso" });
    expect([radios("tab")[2], radios("week")[1], radios("dates")[1]]).toEqual([
      ["List", "true", 0],
      ["Sunday", "true", 0],
      ["ISO", "true", 0],
    ]);
    expect(hintOf("dates")).toBe(`Today reads 2026-11-09. ${CSV_KEEPS_ISO}`);
    pick("dates", "D.M.YYYY");
    expect(hintOf("dates")).toBe(`Today reads 9.11.2026. ${CSV_KEEPS_ISO}`);
  });

  it("moves and chooses with the arrow keys, wrapping at the ends", () => {
    general();
    act(() => {
      fireEvent.keyDown(radio("dates", "System"), { key: "ArrowLeft" });
    });
    expect([document.activeElement?.textContent, stored()]).toEqual(["D.M.YYYY", { ...DEFAULT_DEVICE, dates: "dmy" }]);
    act(() => {
      fireEvent.keyDown(radio("dates", "D.M.YYYY"), { key: "ArrowDown" });
    });
    expect([document.activeElement?.textContent, stored()]).toEqual(["System", DEFAULT_DEVICE]);
    act(() => {
      fireEvent.keyDown(radio("tab", "Timeline"), { key: "ArrowRight", shiftKey: true });
    });
    expect(stored()).toEqual(DEFAULT_DEVICE);
  });

  it("starts from the stored prefs", () => {
    window.localStorage.setItem(DEVICE_KEY, JSON.stringify({ ...DEFAULT_DEVICE, tab: "board", week: 7, dates: "dmy" }));
    general();
    expect([radios("tab")[1][1], radios("week")[1][1], radios("dates")[2][1]]).toEqual(["true", "true", "true"]);
  });
});

describe("a date format change", () => {
  it("repaints a Board date and a List cell", async () => {
    const t = await made();
    render(withSync(shellFor(t).ui));
    await settle();
    fireEvent.click(screen.getByRole("tab", { name: "Board" }));
    expect(one('[data-card="a"] .when').textContent).toBe("10 Nov – 12 Nov");
    setUiNow({ settings: "general" });
    pick("dates", "ISO");
    expect(one('[data-card="a"] .when').textContent).toBe("2026-11-10 – 2026-11-12");
    setUiNow({ settings: null });
    fireEvent.click(screen.getByRole("tab", { name: "List" }));
    const cells = (): (string | null)[] => all('[data-lrow="a"] td').map((c) => c.textContent);
    expect(cells()).toContain("2026-11-10");
    setUiNow({ settings: "general" });
    pick("dates", "D.M.YYYY");
    expect(cells()).toEqual(expect.arrayContaining(["10.11.2026", "12.11.2026"]));
  });
});

describe("the iPhone settings sheet", () => {
  it("lists the same General rows", async () => {
    setPlatform(IPHONE);
    const t = await made();
    render(
      withSync(
        <ThemeProvider storage={window.localStorage} initial={{ store: DEFAULT_STORE, unreadable: null }}>
          <SettingsView
            frame="sheet"
            section="general"
            row={null}
            onRowShown={vi.fn()}
            session={null}
            readOnly={false}
            device="Rokas’s iPhone"
            renameDevice={vi.fn()}
            backup={vi.fn()}
            clock={t.clock}
            hover={false}
            closer={createRef()}
            files={{ creating: false, importing: false, newPlan: vi.fn(), newExample: vi.fn(), importPlan: vi.fn() }}
            onSection={vi.fn()}
            syncPane={null}
            onClose={vi.fn()}
            onSyncPane={vi.fn()}
            onTrashPlan={vi.fn()}
            sync={{ kind: "off" }}
            syncName={() => null}
            updates={null}
            syncPanes={null}
            planLocked={false}
          />
        </ThemeProvider>,
        { registry: shellFor(t).registry },
      ),
    );
    const section = one('section.settings-group[data-section="general"]');
    expect(all(".settings-row", section).map((r) => r.dataset["settingsRow"])).toEqual(["general.week", "general.dates", "general.me", "general.device", "general.about"]);
    expect(one('[data-settings-row="general.me"] .settings-value.dim', section).textContent).toBe(NO_PLAN_ME);
    expect(deviceField().value).toBe("Rokas’s iPhone");
    expect(all('[role="radiogroup"]', section)).toEqual([]);
    openPull("week");
    await settle();
    expect(nativeRows()).toEqual([
      ["1", "Monday", true],
      ["7", "Sunday", false],
    ]);
    chooseNative("7");
    expect([stored(), pull("week").textContent]).toEqual([{ ...DEFAULT_DEVICE, week: 7 }, "Sunday"]);
  });
});

describe("the General rows on iPad", () => {
  it("asks the native pull-down menu for Default tab, Week starts on and Date format, and draws no web menu", async () => {
    setPlatform(IPAD);
    general();
    expect([all('[role="radiogroup"]'), [pull("tab"), pull("week"), pull("dates")].map((b) => [b.textContent, b.getAttribute("aria-label"), hintText(b)])]).toEqual([
      [],
      [
        ["Timeline", "Default tab: Timeline", TAB_HINT],
        ["Monday", "Week starts on: Monday", WEEK_HINT],
        ["System", "Date format: System", `Today reads 9 Nov. ${CSV_KEEPS_ISO}`],
      ],
    ]);
    openPull("tab");
    await settle();
    expect([document.querySelector(".context-menu"), nativeRows()]).toEqual([
      null,
      [
        ["timeline", "Timeline", true],
        ["board", "Board", false],
        ["list", "List", false],
      ],
    ]);
    chooseNative("list");
    openPull("week");
    await settle();
    chooseNative("7");
    openPull("dates");
    await settle();
    expect(nativeRows()).toEqual([
      ["system", "System", true],
      ["iso", "ISO", false],
      ["dmy", "D.M.YYYY", false],
    ]);
    chooseNative("dmy");
    expect([stored(), pull("tab").textContent, pull("week").textContent, pull("dates").textContent, hintText(pull("dates"))]).toEqual([
      { ...DEFAULT_DEVICE, tab: "list", week: 7, dates: "dmy" },
      "List",
      "Sunday",
      "D.M.YYYY",
      `Today reads 9.11.2026. ${CSV_KEEPS_ISO}`,
    ]);
  });
});

describe("This is me", () => {
  it("says to open a plan when none is open", () => {
    general();
    expect([one('[data-settings-row="general.me"] .settings-value.dim').textContent, all('[data-settings-row="general.me"] button')]).toEqual([NO_PLAN_ME, []]);
    expect(NO_PLAN_ME).toBe("Open a plan to choose who you are in it.");
  });

  it("offers Nobody and Add people in Settings… while the plan has no people", async () => {
    const t = await made();
    const onPeople = vi.fn<() => void>();
    generalFor(t.session, { onPeople });
    expect([mePick().textContent, mePick().getAttribute("aria-label"), meStatus().hidden, meStatus().textContent]).toEqual(["Nobody", "This is me: Nobody", true, ""]);
    expect(hintText(mePick())).toBe("For “Plan” on this device only. Turns on Mine in the List.");
    openMe();
    expect(menuRows()).toEqual([
      ["Nobody", "true"],
      ["Add people in Settings…", null],
    ]);
    choose("Add people in Settings…");
    expect([onPeople.mock.calls.length, stored()]).toEqual([1, null]);
  });

  it("chooses a person for this plan on this device only, and Nobody clears it", async () => {
    const t = await made();
    const ids = addCrew(t);
    generalFor(t.session);
    openMe();
    expect(menuRows()).toEqual([
      ["Nobody", "true"],
      ["Mira Okafor", "false"],
      ["Dana Lee", "false"],
    ]);
    choose("Mira Okafor");
    expect([mePick().textContent, stored()]).toEqual(["Mira Okafor", { ...DEFAULT_DEVICE, me: { [TEST_PLAN]: ids.MO } }]);
    openMe();
    expect(menuRows().map((r) => r[1])).toEqual(["false", "true", "false"]);
    choose("Nobody");
    expect([mePick().textContent, stored()]).toEqual(["Nobody", DEFAULT_DEVICE]);
  });

  it("stays enabled on a read-only plan", async () => {
    const t = await made();
    vi.spyOn(t.session, "readOnly", "get").mockReturnValue(true);
    expect(t.session.readOnly).toBe(true);
    generalFor(t.session);
    expect(mePick().hasAttribute("disabled")).toBe(false);
  });

  it("names a removed me, and says so without a name when the plan does not know the person", async () => {
    const t = await made();
    const ids = addCrew(t);
    const phone = await t.peer("iphone");
    sessions.push(phone.session);
    phone.session.apply({ t: "assign", items: ["a"], person: ids.DL });
    act(() => {
      t.session.apply({ t: "person", op: "remove", person: ids.DL, to: null });
      phone.sync();
    });
    window.localStorage.setItem(DEVICE_KEY, JSON.stringify({ ...DEFAULT_DEVICE, me: { [TEST_PLAN]: ids.DL } }));
    generalFor(t.session);
    expect([mePick().textContent, meStatus().hidden, meStatus().textContent]).toEqual(["Former: Dana Lee", false, "“Dana Lee” was removed from this plan’s people. Mine shows nothing until you choose again."]);
    cleanup();
    window.localStorage.setItem(DEVICE_KEY, JSON.stringify({ ...DEFAULT_DEVICE, me: { [TEST_PLAN]: "nobody" } }));
    generalFor(t.session);
    expect([mePick().textContent, meStatus().textContent]).toEqual(["Former person", "The person chosen as you is not in this plan’s people. Mine shows nothing until you choose again."]);
    openMe();
    expect(menuRows()[0]).toEqual(["Nobody", "false"]);
    choose("Mira Okafor");
    expect([meStatus().hidden, meStatus().textContent]).toEqual([true, ""]);
  });
});

describe("the device name", () => {
  it("holds the given name and renames this device on a commit", async () => {
    const t = await made();
    const renameDevice = vi.fn<(name: string) => void>();
    const view = generalFor(t.session, { renameDevice });
    expect([deviceField().value, deviceField().getAttribute("aria-label"), hintText(deviceField())]).toEqual([
      "Rokas’s Mac",
      "Device name",
      "Shown in History and on your other devices. The sync server keeps the name this device joined with.",
    ]);
    typeName("  Studio Mac ");
    expect(renameDevice.mock.calls).toEqual([["Studio Mac"]]);
    view.rerender(
      deviced(
        <>
          <General session={t.session} device="Studio Mac" renameDevice={renameDevice} clock={fixedClock("2026-11-09")} updates={null} onPeople={vi.fn()} />
          <Toasts />
        </>,
      ),
    );
    expect(deviceField().value).toBe("Studio Mac");
  });

  it("toasts the refusal of an empty name and puts the field back", async () => {
    const t = await made();
    const renameDevice = vi.fn((name: string): void => {
      normalizeName(name);
    });
    generalFor(t.session, { renameDevice });
    typeName("   ");
    expect([renameDevice.mock.calls, toastTexts(), deviceField().value]).toEqual([[[""]], ["The name is empty. Type at least one character."], "Rokas’s Mac"]);
  });

  it("lets a fault that is not a refusal propagate", async () => {
    const t = await made();
    const bug = new Error("disk gone");
    generalFor(t.session, {
      renameDevice: () => {
        throw bug;
      },
    });
    const reported: unknown[] = [];
    const onError = (e: ErrorEvent): void => {
      reported.push(e.error);
      e.preventDefault();
    };
    window.addEventListener("error", onError);
    try {
      act(() => {
        fireEvent.change(deviceField(), { target: { value: "Studio" } });
      });
      try {
        fireEvent.keyDown(deviceField(), { key: "Enter" });
      } catch (e) {
        reported.push(e);
      }
    } finally {
      window.removeEventListener("error", onError);
    }
    expect([reported, toastTexts()]).toEqual([[bug], []]);
  });
});

describe("the General rows in Settings", () => {
  it("rename goes to the registry and the field follows its live name", async () => {
    const t = await made();
    const { ui, registry } = shellFor(t);
    let name = "Mac";
    const rename = vi.fn((next: string): void => {
      name = normalizeName(next);
      registry.notify();
    });
    Object.defineProperty(registry, "device", { get: () => ({ deviceId: "mac", name, platform: "macos" }) });
    Object.assign(registry, { renameDevice: rename });
    render(withSync(ui));
    await settle();
    setUiNow({ settings: "general" });
    expect(deviceField().value).toBe("Mac");
    typeName("Studio\tMac");
    expect([rename.mock.calls, deviceField().value]).toEqual([[["Studio\tMac"]], "Studio Mac"]);
  });
});
