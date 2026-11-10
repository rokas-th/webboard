import { describe, expect, it, vi } from "vitest";
import type { DownloadEvent } from "@tauri-apps/plugin-updater";
import type { InstallProgress } from "../store/updates";

const plugin = vi.hoisted(() => ({
  check: vi.fn<() => Promise<unknown>>(),
  relaunch: vi.fn<() => Promise<void>>(),
}));

vi.mock("@tauri-apps/plugin-updater", () => ({ check: plugin.check }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: plugin.relaunch }));

const { check, progressTracker, restart } = await import("./updates");

describe("progressTracker", () => {
  it("adds chunks to the size the download started with, then reports installing", () => {
    const seen: InstallProgress[] = [];
    const on = progressTracker((p) => seen.push(p));
    const events: DownloadEvent[] = [
      { event: "Started", data: { contentLength: 1000 } },
      { event: "Progress", data: { chunkLength: 400 } },
      { event: "Progress", data: { chunkLength: 600 } },
      { event: "Finished" },
    ];
    events.forEach(on);
    expect(seen).toEqual([
      { t: "downloading", downloaded: 0, total: 1000 },
      { t: "downloading", downloaded: 400, total: 1000 },
      { t: "downloading", downloaded: 1000, total: 1000 },
      { t: "installing" },
    ]);
  });

  it("an unknown size stays unknown", () => {
    const seen: InstallProgress[] = [];
    const on = progressTracker((p) => seen.push(p));
    on({ event: "Started", data: {} });
    on({ event: "Progress", data: { chunkLength: 10 } });
    expect(seen).toEqual([
      { t: "downloading", downloaded: 0, total: null },
      { t: "downloading", downloaded: 10, total: null },
    ]);
  });
});

describe("check and restart", () => {
  it("no update is null", async () => {
    plugin.check.mockResolvedValueOnce(null);
    expect(await check()).toBeNull();
  });

  it("an update carries its version and installs through downloadAndInstall", async () => {
    const downloadAndInstall = vi.fn(async (on: (e: DownloadEvent) => void) => {
      on({ event: "Started", data: { contentLength: 4 } });
      on({ event: "Finished" });
    });
    plugin.check.mockResolvedValueOnce({ version: "0.2.0", downloadAndInstall });
    const found = await check();
    expect(found?.version).toBe("0.2.0");
    const seen: InstallProgress[] = [];
    await found?.install((p) => seen.push(p));
    expect(downloadAndInstall).toHaveBeenCalledTimes(1);
    expect(seen).toEqual([{ t: "downloading", downloaded: 0, total: 4 }, { t: "installing" }]);
  });

  it("errors propagate unchanged", async () => {
    plugin.check.mockRejectedValueOnce("Could not fetch a valid release JSON from the remote");
    await expect(check()).rejects.toBe("Could not fetch a valid release JSON from the remote");
    const failure = new Error("relaunch failed");
    plugin.relaunch.mockRejectedValueOnce(failure);
    await expect(restart()).rejects.toBe(failure);
  });
});
