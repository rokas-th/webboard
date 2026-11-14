import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  call,
  callNull,
  AppError,
  syncSetup,
  syncPairCode,
  syncPairJoin,
  syncTicket,
  syncDevices,
  syncRemoveDevice,
  syncStatus,
  syncMarkRevoked,
  syncReset,
  type SpaceInfo,
} from "./ipc";
import { resetTauri, commandsSince, hold, tauri } from "../test/tauriMock";

vi.mock("@tauri-apps/api/core", () => import("../test/tauriMock"));

const CORE_IMPORT = /from ['"]@tauri-apps\/api\/core['"]/;

describe("call", () => {
  beforeEach(() => resetTauri({}));

  it("call resolves with the command's answer and records it", async () => {
    resetTauri({ device_info: () => ({ deviceId: "d1" }) });
    await expect(call("device_info")).resolves.toEqual({ deviceId: "d1" });
    expect(commandsSince(0)).toEqual(["device_info"]);
  });

  it("a Rust CommandError becomes an AppError with its code", async () => {
    resetTauri({
      store_list: () => {
        throw { code: "store.io", message: "disk full" };
      },
    });
    const e = await call("store_list").catch((x: unknown) => x);
    expect(e).toBeInstanceOf(AppError);
    expect(e).toMatchObject({ code: "store.io", message: "disk full" });
  });

  it("any other rejection becomes ipc.failed naming the command", async () => {
    const e = await call("store_list").catch((x: unknown) => x);
    expect(e).toBeInstanceOf(AppError);
    expect(e).toMatchObject({ code: "ipc.failed", message: "store_list: no fixture answers store_list" });
  });

  it("names a rejection that cannot be printed without throwing", async () => {
    const h = hold("store_list");
    const p = call("store_list");
    h.reject(Object.create(null));
    const e = await p.catch((x: unknown) => x);
    expect(e).toBeInstanceOf(AppError);
    expect(e).toMatchObject({ code: "ipc.failed", message: "store_list: an object that cannot be printed" });
  });

  it("headers reach invoke", async () => {
    resetTauri({ store_append: () => null });
    const bytes = new Uint8Array([1, 2, 3]);
    const options = { headers: { "x-doc": "p1", "x-seq": "7" } };
    await call("store_append", bytes, options);
    expect(tauri.calls).toHaveLength(1);
    expect(tauri.calls[0].args).toBe(bytes);
    expect(tauri.calls[0].options).toEqual(options);
  });

  it("a held command settles only when the test does", async () => {
    const h = hold("holidays_year");
    let settled = false;
    const p = call("holidays_year", { region: { src: "opm" }, year: 2026, fresh: false });
    p.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(settled).toBe(false);
    expect(commandsSince(0)).toEqual(["holidays_year"]);
    const x = { days: [], fetchedAt: "2026-11-08T00:00:00Z", fromCache: false, coverage: null };
    h.resolve(x);
    await expect(p).resolves.toBe(x);

    const h2 = hold("holidays_year");
    const q = call("holidays_year", { region: { src: "opm" }, year: 2026, fresh: false });
    h2.reject({ code: "holidays.offline", message: "No connection" });
    const e = await q.catch((y: unknown) => y);
    expect(e).toBeInstanceOf(AppError);
    expect(e).toMatchObject({ code: "holidays.offline", message: "No connection" });
  });

  it("only services/ipc.ts imports the Tauri core module", () => {
    const sources = import.meta.glob("/src/**/*.{ts,tsx}", { query: "?raw", import: "default", eager: true }) as Record<
      string,
      string
    >;
    expect(CORE_IMPORT.test(sources["/src/services/ipc.ts"])).toBe(true);
    const offenders = Object.entries(sources)
      .filter(([path]) => path !== "/src/services/ipc.ts" && !path.startsWith("/src/test/"))
      .filter(([, text]) => CORE_IMPORT.test(text))
      .map(([path]) => path);
    expect(offenders).toEqual([]);
  });
});

describe("callNull", () => {
  beforeEach(() => resetTauri({}));

  it("resolves once the command answers null, passing its arguments", async () => {
    resetTauri({ sync_reset: () => null });
    await expect(callNull("sync_reset", { why: "test" })).resolves.toBeUndefined();
    expect(tauri.calls).toEqual([{ cmd: "sync_reset", args: { why: "test" }, options: undefined }]);
  });

  it.each([
    [undefined, "undefined"],
    ["ok", '"ok"'],
    [0, "0"],
    [true, "true"],
    [{}, "{}"],
    [[1], "[1]"],
  ])("refuses the answer %o as ipc.shape naming the command and the answer", async (out, named) => {
    resetTauri({ sync_reset: () => out });
    const e = await callNull("sync_reset").catch((x: unknown) => x);
    expect(e).toBeInstanceOf(AppError);
    expect(e).toMatchObject({ code: "ipc.shape", message: `sync_reset answered ${named} instead of null` });
  });

  it.each([
    [1n, "a bigint JSON cannot show"],
    [Symbol("s"), "Symbol(s)"],
  ])("still names an answer JSON cannot show without throwing: %o", async (out, named) => {
    resetTauri({ sync_reset: () => out });
    const e = await callNull("sync_reset").catch((x: unknown) => x);
    expect(e).toBeInstanceOf(AppError);
    expect(e).toMatchObject({ code: "ipc.shape", message: `sync_reset answered ${named} instead of null` });
  });

  it("names a cyclic answer without throwing", async () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    resetTauri({ sync_reset: () => cyclic });
    const e = await callNull("sync_reset").catch((x: unknown) => x);
    expect(e).toBeInstanceOf(AppError);
    expect(e).toMatchObject({ code: "ipc.shape", message: "sync_reset answered an object JSON cannot show instead of null" });
  });

  it("keeps a Rust CommandError's code", async () => {
    resetTauri({
      sync_reset: () => {
        throw { code: "store.io", message: "disk full" };
      },
    });
    await expect(callNull("sync_reset")).rejects.toMatchObject({ code: "store.io", message: "disk full" });
  });
});

describe("sync commands", () => {
  const space: SpaceInfo = { server: "https://webboard.rokass.org", spaceId: "sp000000000", deviceId: "devA0000000", deviceName: "Mac" };

  it("each sync wrapper calls its command with the Rust argument names", async () => {
    resetTauri({
      sync_setup: () => space,
      sync_pair_join: () => space,
      sync_pair_code: () => ({ code: "ABCD2345", expiresAt: 5 }),
      sync_ticket: () => ({ ticket: "tk_1", expiresAt: 6 }),
      sync_devices: () => [{ id: "devA0000000", name: "Mac", createdAt: 1, lastSeenAt: 2, current: true }],
      sync_remove_device: () => null,
      sync_status: () => ({ space, revoked: false }),
      sync_mark_revoked: () => null,
      sync_reset: () => null,
    });
    await expect(syncSetup("https://webboard.rokass.org", "s3cr3t", "Mac")).resolves.toEqual(space);
    await expect(syncPairJoin("https://webboard.rokass.org", "ABCD2345", "Mac")).resolves.toEqual(space);
    await expect(syncPairCode()).resolves.toEqual({ code: "ABCD2345", expiresAt: 5 });
    await expect(syncTicket("ix-sp000000000")).resolves.toEqual({ ticket: "tk_1", expiresAt: 6 });
    await expect(syncDevices()).resolves.toEqual([{ id: "devA0000000", name: "Mac", createdAt: 1, lastSeenAt: 2, current: true }]);
    await expect(syncRemoveDevice("dev00000000")).resolves.toBeUndefined();
    await expect(syncStatus()).resolves.toEqual({ space, revoked: false });
    await expect(syncMarkRevoked()).resolves.toBeUndefined();
    await expect(syncReset()).resolves.toBeUndefined();
    expect(tauri.calls.map((c) => [c.cmd, c.args])).toEqual([
      ["sync_setup", { server: "https://webboard.rokass.org", secret: "s3cr3t", deviceName: "Mac" }],
      ["sync_pair_join", { server: "https://webboard.rokass.org", code: "ABCD2345", deviceName: "Mac" }],
      ["sync_pair_code", undefined],
      ["sync_ticket", { doc: "ix-sp000000000" }],
      ["sync_devices", undefined],
      ["sync_remove_device", { id: "dev00000000" }],
      ["sync_status", undefined],
      ["sync_mark_revoked", undefined],
      ["sync_reset", undefined],
    ]);
  });

  it("a sync error keeps its code", async () => {
    resetTauri({
      sync_ticket: () => {
        throw { code: "keychain.missing", message: "This device has no sync key. Join the space again with a pairing code." };
      },
    });
    const e = await syncTicket("ix-sp000000000").catch((x: unknown) => x);
    expect(e).toBeInstanceOf(AppError);
    expect(e).toMatchObject({ code: "keychain.missing" });
  });
});
