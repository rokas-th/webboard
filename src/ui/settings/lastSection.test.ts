import { afterEach, describe, expect, it, vi } from "vitest";
import { toast } from "../common/Toast";
import type { SettingsSection } from "../state";
import { lastSection, parseSettingsPlace, saveSection, SETTINGS_KEY, SETTINGS_UNREADABLE } from "./lastSection";
import { SETTINGS_SECTIONS } from "./sections";

vi.mock("../common/Toast", () => ({ toast: vi.fn() }));

afterEach(() => {
  window.localStorage.clear();
  vi.mocked(toast).mockClear();
});

const ALL: readonly SettingsSection[] = ["general", "theme", "sync", "files", "overview", "people", "workflow", "working-time", "defaults", "baselines", "danger"];

describe("the last Settings section", () => {
  it("round-trips every section", () => {
    expect(SETTINGS_KEY).toBe("webboard.settings");
    ALL.forEach((at) => {
      saveSection(window.localStorage, at);
      expect([window.localStorage.getItem(SETTINGS_KEY), lastSection(window.localStorage, true)]).toEqual([JSON.stringify({ v: 1, at }), at]);
    });
    expect(toast).not.toHaveBeenCalled();
  });

  it("reads back every section the registry holds", () => {
    expect(SETTINGS_SECTIONS.map((s) => parseSettingsPlace(JSON.stringify({ v: 1, at: s.id })))).toEqual(SETTINGS_SECTIONS.map((s) => s.id));
    expect(SETTINGS_SECTIONS.map((s) => s.id)).toEqual(ALL);
  });

  it("opens General when nothing is saved", () => {
    expect(lastSection(window.localStorage, true)).toBe("general");
    expect(toast).not.toHaveBeenCalled();
  });

  it("rejects extra keys, v 2, unknown ids", () => {
    expect(parseSettingsPlace('{"v":1,"at":"theme"}')).toBe("theme");
    ['{"v":1,"at":"theme","x":1}', '{"v":2,"at":"theme"}', '{"v":1,"at":"about"}', '{"v":1}', '{"at":"theme"}', '["theme"]', "null", '"theme"', '{"v":"1","at":"theme"}', "{not json"].forEach((raw) => {
      expect([raw, parseSettingsPlace(raw)]).toEqual([raw, null]);
    });
  });

  it("lets a throw that is no syntax error through", () => {
    const parse = vi.spyOn(JSON, "parse").mockImplementation(() => {
      throw new RangeError("deep");
    });
    try {
      expect(() => parseSettingsPlace('{"v":1,"at":"theme"}')).toThrow("deep");
    } finally {
      parse.mockRestore();
    }
  });

  it("removes an unreadable value with one toast", () => {
    window.localStorage.setItem(SETTINGS_KEY, '{"v":1,"at":"nowhere"}');
    expect(lastSection(window.localStorage, true)).toBe("general");
    expect(window.localStorage.getItem(SETTINGS_KEY)).toBeNull();
    expect(lastSection(window.localStorage, true)).toBe("general");
    expect(SETTINGS_UNREADABLE).toBe("The saved Settings section could not be read; Settings opens on General.");
    expect(vi.mocked(toast).mock.calls).toEqual([[SETTINGS_UNREADABLE, "bad"]]);
  });

  it("a plan section without a plan opens General", () => {
    saveSection(window.localStorage, "baselines");
    expect([lastSection(window.localStorage, false), lastSection(window.localStorage, true)]).toEqual(["general", "baselines"]);
    expect(window.localStorage.getItem(SETTINGS_KEY)).toBe(JSON.stringify({ v: 1, at: "baselines" }));
    expect(toast).not.toHaveBeenCalled();
  });
});
