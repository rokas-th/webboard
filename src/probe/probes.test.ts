import { beforeEach, describe, expect, it, vi } from "vitest";
import { framed } from "../test/fixtures/framed";
import { emitFromRust, resetTauri, tauri } from "../test/tauriMock";
import { IPAD, setPlatform } from "../test/platform";
import {
  failure,
  MENU_END_MS,
  PROBE_ALERT,
  PROBE_BYTES,
  PROBE_MENU,
  PROBE_MENU_ANCHOR,
  probeAlert,
  probeAppearance,
  probeHaptic,
  probeHolidays,
  probeLine,
  probeMenu,
  probeOpen,
  probePaths,
  probeSave,
  sendLine,
} from "./probes";

vi.mock("@tauri-apps/api/core", () => import("../test/tauriMock"));
vi.mock("@tauri-apps/api/event", () => import("../test/tauriMock"));

const loadAnswer = (lastSeq: number): ArrayBuffer => {
  const bytes = new Uint8Array(17);
  const view = new DataView(bytes.buffer);
  view.setBigUint64(1, BigInt(lastSeq), true);
  view.setUint32(9, 1, true);
  return bytes.buffer;
};

beforeEach(() => {
  resetTauri({});
});

describe("probeLine", () => {
  it("names the probe and its data as one JSON line", () => {
    expect(probeLine("keys", { key: "k", meta: true })).toBe('keys {"key":"k","meta":true}');
  });
});

describe("sendLine", () => {
  it("hands the line to probe_log", async () => {
    tauri.answers.probe_log = () => null;
    await sendLine('ready {"a":1}');
    expect(tauri.calls).toEqual([{ cmd: "probe_log", args: { line: 'ready {"a":1}' }, options: undefined }]);
  });

  it("rejects with probe_log's error", async () => {
    tauri.answers.probe_log = () => {
      throw { code: "probe.io", message: "Could not append to probe.log: disk full" };
    };
    await expect(sendLine("ready {}")).rejects.toMatchObject({ code: "probe.io" });
  });
});

describe("probePaths", () => {
  it("appends after the doc's last seq, then lists the docs", async () => {
    tauri.answers.store_load = () => loadAnswer(4);
    tauri.answers.store_append = () => null;
    tauri.answers.store_list = () => ["local", "probe"];
    expect(await probePaths()).toEqual(["paths", { appended: 5, docs: ["local", "probe"], listed: true }]);
    expect(tauri.calls.map((c) => c.cmd)).toEqual(["store_load", "store_append", "store_list"]);
    expect(tauri.calls[0].args).toEqual({ doc: "probe" });
    expect(tauri.calls[1].args).toEqual(PROBE_BYTES);
    expect(tauri.calls[1].options).toEqual({ headers: { "x-doc": "probe", "x-seq": "5" } });
  });

  it("reports the first failing command's code", async () => {
    tauri.answers.store_load = () => loadAnswer(0);
    tauri.answers.store_append = () => {
      throw { code: "store.locked", message: "This plan is open in another WebBoard process; close it there first." };
    };
    expect(await probePaths()).toEqual([
      "paths",
      { error: "store.locked", message: "This plan is open in another WebBoard process; close it there first." },
    ]);
  });
});

describe("probeHolidays", () => {
  it("asks for Zürich 2027 from the cache first and reports count, cache and first date", async () => {
    tauri.answers.holidays_year = () => ({
      days: [{ date: "2027-01-01" }, { date: "2027-01-02" }],
      fetchedAt: "2026-11-10T00:00:00Z",
      fromCache: false,
      coverage: null,
    });
    expect(await probeHolidays()).toEqual(["holidays", { days: 2, fromCache: false, first: "2027-01-01" }]);
    expect(tauri.calls[0].args).toEqual({ region: { src: "openholidays", country: "CH", subdivision: "CH-ZH" }, year: 2027, fresh: false });
  });

  it("reports the error code", async () => {
    tauri.answers.holidays_year = () => {
      throw { code: "holidays.offline", message: "WebBoard is offline." };
    };
    expect(await probeHolidays()).toEqual(["holidays", { error: "holidays.offline", message: "WebBoard is offline." }]);
  });
});

describe("files", () => {
  it("exports 16 bytes through plan_export under the name probe and reports the written name", async () => {
    tauri.answers.plan_export = () => "probe.webboard";
    expect(await probeSave()).toEqual(["files", { saved: "probe.webboard" }]);
    expect(tauri.calls.map((c) => c.cmd)).toEqual(["plan_export"]);
    expect(tauri.calls[0].args).toEqual(PROBE_BYTES);
    expect(PROBE_BYTES.length).toBe(16);
    expect(tauri.calls[0].options).toEqual({ headers: { "x-name": "probe", "x-format": "webboard" } });
  });

  it("reports a cancelled save", async () => {
    tauri.answers.plan_export = () => null;
    expect(await probeSave()).toEqual(["files", { saved: null }]);
    expect(tauri.calls.map((c) => c.cmd)).toEqual(["plan_export"]);
  });

  it("reports a save answer that is not a file name", async () => {
    tauri.answers.plan_export = () => ({});
    expect(await probeSave()).toEqual(["files", { error: "ipc.shape", message: "plan_export answered object instead of a file name or null" }]);
  });

  it("imports through plan_import and reports the picked name and its length", async () => {
    tauri.answers.plan_import = () => framed("probe ü.webboard", PROBE_BYTES);
    expect(await probeOpen()).toEqual(["files", { opened: "probe ü.webboard", read: 16 }]);
    expect(tauri.calls.map((c) => c.cmd)).toEqual(["plan_import"]);
    expect(tauri.calls[0].args).toBeUndefined();
  });

  it("reports a cancelled open", async () => {
    tauri.answers.plan_import = () => new ArrayBuffer(0);
    expect(await probeOpen()).toEqual(["files", { opened: null }]);
  });

  it("reports a frame it cannot read", async () => {
    tauri.answers.plan_import = () => new Uint8Array([9]).buffer;
    expect(await probeOpen()).toEqual(["files", { error: "ipc.shape", message: "plan_import answered 1 bytes, which do not hold a file name and its file" }]);
  });

  it("reports plan_import's code", async () => {
    tauri.answers.plan_import = () => {
      throw { code: "file.io", message: "Could not read /x/probe.webboard: denied." };
    };
    expect(await probeOpen()).toEqual(["files", { error: "file.io", message: "Could not read /x/probe.webboard: denied." }]);
  });
});

describe("failure", () => {
  it("reports a rejection that is not an AppError as thrown", () => {
    expect(failure(new TypeError("x"))).toEqual({ thrown: "TypeError: x" });
    expect(failure("s")).toEqual({ thrown: "s" });
  });
});

describe("probeAppearance", () => {
  it("sets the dark appearance and reports it", async () => {
    setPlatform(IPAD);
    await expect(probeAppearance()).resolves.toEqual(["appearance", { set: "dark" }]);
    expect(tauri.calls).toEqual([{ cmd: "appearance_set", args: { scheme: "dark" }, options: undefined }]);
  });

  it("reports a failed call as its error", async () => {
    setPlatform(IPAD);
    tauri.answers.appearance_set = () => {
      throw { code: "appearance.no_window", message: "no window" };
    };
    await expect(probeAppearance()).resolves.toEqual(["appearance", { error: "appearance.no_window", message: "no window" }]);
  });
});

describe("probeHaptic", () => {
  it("plays the selection haptic and reports it", async () => {
    setPlatform(IPAD);
    await expect(probeHaptic()).resolves.toEqual(["haptic", { sent: "selection" }]);
    expect(tauri.calls).toEqual([{ cmd: "haptic", args: { kind: "selection" }, options: undefined }]);
  });

  it("reports a failed call as its error", async () => {
    setPlatform(IPAD);
    tauri.answers.haptic = () => {
      throw { code: "haptic.no_view", message: "no view" };
    };
    await expect(probeHaptic()).resolves.toEqual(["haptic", { error: "haptic.no_view", message: "no view" }]);
  });
});

describe("probeMenu", () => {
  const menuCalls = (): unknown[][] => tauri.calls.filter((c) => c.cmd === "menu_show" || c.cmd === "menu_dismiss").map((c) => [c.cmd, c.args]);

  it("shows the two-row menu, says so, dismisses it and says when it ended", async () => {
    setPlatform(IPAD);
    const said: string[] = [];
    tauri.answers.menu_dismiss = (args) => {
      emitFromRust("menu-ended", { token: (args as { token: string }).token });
      return null;
    };
    await expect(probeMenu((line) => said.push(line))).resolves.toBeNull();
    const calls = menuCalls();
    const token = (calls[0][1] as { menu: { token: string } }).menu.token;
    expect(calls).toEqual([
      ["menu_show", { menu: { token, anchor: PROBE_MENU_ANCHOR, sections: PROBE_MENU } }],
      ["menu_dismiss", { token }],
    ]);
    expect(PROBE_MENU.flatMap((s) => s.rows.map((r) => r.title))).toEqual(["Probe row one", "Probe row two"]);
    expect(said).toEqual(["menu shown", "menu ended"]);
  });

  it("reports a refused menu as its error and says nothing", async () => {
    setPlatform(IPAD);
    tauri.answers.menu_show = () => {
      throw { code: "menu.not_shown", message: "not shown" };
    };
    const said: string[] = [];
    await expect(probeMenu((line) => said.push(line))).resolves.toEqual(["menu", { error: "menu.not_shown", message: "not shown" }]);
    expect(said).toEqual([]);
  });

  it("reports a menu whose end never arrives by name", async () => {
    setPlatform(IPAD);
    vi.useFakeTimers();
    const said: string[] = [];
    const done = probeMenu((line) => said.push(line));
    await vi.advanceTimersByTimeAsync(MENU_END_MS);
    await expect(done).resolves.toEqual(["menu", { error: "probe.menu_ended", message: `menu-ended did not arrive within ${MENU_END_MS} ms of menu_dismiss` }]);
    expect(said).toEqual(["menu shown"]);
    vi.useRealTimers();
  });
});

describe("probeAlert", () => {
  it("asks UIKit with the probe title and message and reports the answer", async () => {
    setPlatform(IPAD);
    tauri.answers.alert_ask = () => "cancel";
    await expect(probeAlert()).resolves.toEqual(["alert", { answer: "cancel" }]);
    expect(tauri.calls).toEqual([
      {
        cmd: "alert_ask",
        args: { ask: { title: "WebBoard probe alert", message: "Nothing is changed. Tap either button.", confirm: { label: "Confirm", destructive: false }, cancel: "Cancel" } },
        options: undefined,
      },
    ]);
    expect(PROBE_ALERT.title).toBe("WebBoard probe alert");
  });

  it("reports a failed alert as its error, not as an answer", async () => {
    setPlatform(IPAD);
    tauri.answers.alert_ask = () => {
      throw { code: "alert.busy", message: "busy" };
    };
    await expect(probeAlert()).resolves.toEqual(["alert", { error: "alert.busy", message: "busy" }]);
  });
});
