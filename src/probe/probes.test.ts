import { open, save } from "@tauri-apps/plugin-dialog";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetTauri, tauri } from "../test/tauriMock";
import { PROBE_BYTES, probeHolidays, probeLine, probeOpen, probePaths, probeSave, sendLine } from "./probes";

vi.mock("@tauri-apps/api/core", () => import("../test/tauriMock"));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));

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

afterEach(() => {
  vi.mocked(save).mockReset();
  vi.mocked(open).mockReset();
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
  it("writes 16 bytes to the saved path", async () => {
    vi.mocked(save).mockResolvedValue("/var/mobile/Documents/probe file.webboard");
    tauri.answers.file_write = () => null;
    expect(await probeSave()).toEqual(["files", { saved: "/var/mobile/Documents/probe file.webboard" }]);
    expect(vi.mocked(save)).toHaveBeenCalledWith({ defaultPath: "probe.webboard" });
    expect(tauri.calls[0].args).toEqual(PROBE_BYTES);
    expect(PROBE_BYTES.length).toBe(16);
    expect(tauri.calls[0].options).toEqual({ headers: { "x-path": "%2Fvar%2Fmobile%2FDocuments%2Fprobe%20file.webboard" } });
  });

  it("reports a cancelled save without writing", async () => {
    vi.mocked(save).mockResolvedValue(null);
    expect(await probeSave()).toEqual(["files", { saved: null }]);
    expect(tauri.calls).toEqual([]);
  });

  it("reads the opened path and reports its length", async () => {
    vi.mocked(open).mockResolvedValue("file:///private/var/mobile/probe.webboard");
    tauri.answers.file_read = () => PROBE_BYTES.slice().buffer;
    expect(await probeOpen()).toEqual(["files", { opened: "file:///private/var/mobile/probe.webboard", read: 16 }]);
    expect(tauri.calls[0].options).toEqual({ headers: { "x-path": encodeURIComponent("file:///private/var/mobile/probe.webboard") } });
  });

  it("reports a dialog rejection that is not an AppError as thrown", async () => {
    vi.mocked(open).mockRejectedValue("dialog.open not allowed");
    expect(await probeOpen()).toEqual(["files", { thrown: "dialog.open not allowed" }]);
  });

  it("reports file_read's code", async () => {
    vi.mocked(open).mockResolvedValue("/x/probe.webboard");
    tauri.answers.file_read = () => {
      throw { code: "file.io", message: "Could not read /x/probe.webboard: denied." };
    };
    expect(await probeOpen()).toEqual(["files", { error: "file.io", message: "Could not read /x/probe.webboard: denied." }]);
  });
});
