import { beforeEach, describe, expect, it } from "vitest";
import { IPAD, IPHONE, LINUX, MAC, setPlatform } from "./platform";
import { getCurrentWindow, invoke, listen, pickTab, requestWindowClose, resetTauri, takeRefusals, windowState } from "./tauriMock";

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

describe("the tab bar answers", () => {
  const tab = (id: string) => ({ id, title: id.toUpperCase(), image: `${id}.symbol` });
  const STATE = { selected: "board", hidden: false, tint: "#24E0FF" };
  const BAR = { tabs: [tab("timeline"), tab("board"), tab("list")], state: STATE };

  it("installs on the iPhone with a height of 83 and then takes a set", async () => {
    setPlatform(IPHONE);
    await expect(invoke("tabbar_install", { bar: BAR })).resolves.toEqual({ height: 83 });
    await expect(invoke("tabbar_set", { state: { selected: "list", hidden: true, tint: "#00aaFF" } })).resolves.toBeNull();
    expect(takeRefusals()).toEqual([]);
  });

  it.each([IPAD, MAC, LINUX])("refuses both commands on $os $idiom", async (p) => {
    setPlatform(p);
    const where = p.idiom === null ? p.os : `${p.os} ${p.idiom}`;
    await expect(invoke("tabbar_install", { bar: BAR })).rejects.toThrow(`tabbar_install was called on ${where}, where only the iPhone has it`);
    await expect(invoke("tabbar_set", { state: STATE })).rejects.toThrow(`tabbar_set was called on ${where}, where only the iPhone has it`);
    expect(takeRefusals()).toHaveLength(2);
  });

  it.each([
    ["no bar", {}],
    ["an extra key", { bar: { ...BAR, extra: 1 } }],
    ["one tab", { bar: { ...BAR, tabs: [tab("board")], state: STATE } }],
    ["six tabs", { bar: { ...BAR, tabs: ["a", "b", "c", "d", "e", "board"].map(tab) } }],
    ["a blank title", { bar: { ...BAR, tabs: [tab("timeline"), { ...tab("board"), title: " " }] } }],
    ["an extra tab key", { bar: { ...BAR, tabs: [tab("timeline"), { ...tab("board"), badge: 1 }] } }],
    ["a repeated id", { bar: { ...BAR, tabs: [tab("board"), tab("board")] } }],
    ["a selected id that is no tab", { bar: { ...BAR, state: { ...STATE, selected: "plans" } } }],
    ["a missing hidden", { bar: { ...BAR, state: { selected: "board", tint: "#24E0FF" } } }],
    ["a tint without #", { bar: { ...BAR, state: { ...STATE, tint: "24E0FF" } } }],
    ["a short tint", { bar: { ...BAR, state: { ...STATE, tint: "#24E0F" } } }],
  ])("refuses an install with %s on the iPhone, as tabbar.rs would", async (_, args) => {
    setPlatform(IPHONE);
    await expect(invoke("tabbar_install", args)).rejects.toThrow("tabbar_install got");
    expect(takeRefusals()).toHaveLength(1);
  });

  it.each([
    ["before an install", null, { state: STATE }],
    ["a selected id that is no installed tab", BAR, { state: { ...STATE, selected: "plans" } }],
    ["a bad tint", BAR, { state: { ...STATE, tint: "cyan" } }],
    ["an extra key", BAR, { state: { ...STATE, extra: true } }],
  ])("refuses a set %s", async (_, bar, args) => {
    setPlatform(IPHONE);
    if (bar !== null) await invoke("tabbar_install", { bar });
    await expect(invoke("tabbar_set", args)).rejects.toThrow("tabbar_set");
    expect(takeRefusals()).toHaveLength(1);
  });

  it("forgets the installed tabs on reset", async () => {
    setPlatform(IPHONE);
    await invoke("tabbar_install", { bar: BAR });
    resetTauri({});
    await expect(invoke("tabbar_set", { state: STATE })).rejects.toThrow("tabbar_set was called before tabbar_install");
    expect(takeRefusals()).toHaveLength(1);
  });

  it("pickTab emits tabbar-picked with again false unless asked", async () => {
    const got: unknown[] = [];
    await listen("tabbar-picked", (e) => got.push(e.payload));
    pickTab("list");
    pickTab("board", true);
    expect(got).toEqual([
      { id: "list", again: false },
      { id: "board", again: true },
    ]);
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
