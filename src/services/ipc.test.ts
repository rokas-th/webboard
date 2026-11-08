import { describe, it, expect, beforeEach, vi } from "vitest";
import { call, AppError } from "./ipc";
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
