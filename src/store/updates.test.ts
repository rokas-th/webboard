import { afterEach, describe, expect, it, vi } from "vitest";
import { createUpdates, installedButNotSaved, restartFailedLine, type InstallProgress, type UpdateDeps, type UpdateState } from "./updates";

interface Found {
  version: string;
}

const DAY = 24 * 60 * 60 * 1000;
const AT = new Date(2026, 10, 10, 9, 5, 0, 0).getTime();

interface Deferred<T> {
  promise: Promise<T>;
  resolve(v: T): void;
  reject(e: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
};

interface Harness {
  deps: UpdateDeps<Found>;
  calls: string[];
  check: ReturnType<typeof vi.fn<() => Promise<Found | null>>>;
  install: ReturnType<typeof vi.fn<(u: Found, onProgress: (p: InstallProgress) => void) => Promise<void>>>;
  closeRegistry: ReturnType<typeof vi.fn<() => Promise<void>>>;
  restart: ReturnType<typeof vi.fn<() => Promise<void>>>;
  report: ReturnType<typeof vi.fn<(e: unknown) => void>>;
}

function harness(over: Partial<UpdateDeps<Found>> = {}): Harness {
  const calls: string[] = [];
  const check = vi.fn<() => Promise<Found | null>>(async () => {
    calls.push("check");
    return null;
  });
  const install = vi.fn<(u: Found, onProgress: (p: InstallProgress) => void) => Promise<void>>(async (u) => {
    calls.push(`install ${u.version}`);
  });
  const closeRegistry = vi.fn<() => Promise<void>>(async () => {
    calls.push("closeRegistry");
  });
  const restart = vi.fn<() => Promise<void>>(async () => {
    calls.push("restart");
  });
  const report = vi.fn<(e: unknown) => void>(() => undefined);
  const deps: UpdateDeps<Found> = {
    check,
    install,
    closeRegistry,
    restart,
    report,
    now: () => AT,
    setTimer: (cb, ms) => {
      const id = setInterval(cb, ms);
      return () => clearInterval(id);
    },
    ...over,
  };
  return { deps, calls, check, install, closeRegistry, restart, report };
}

afterEach(() => {
  vi.useRealTimers();
});

const available = async (h: Harness, version = "0.2.0") => {
  h.check.mockImplementationOnce(async () => {
    h.calls.push("check");
    return { version };
  });
  const u = createUpdates(h.deps);
  u.start();
  await flush();
  expect(u.state()).toEqual({ k: "available", version });
  return u;
};

describe("checking", () => {
  it("starts idle, then checks once: checking, then current with the time", async () => {
    const h = harness();
    const gate = deferred<Found | null>();
    h.check.mockReturnValueOnce(gate.promise);
    const u = createUpdates(h.deps);
    expect(u.state()).toEqual({ k: "idle" });
    const seen: UpdateState[] = [];
    u.subscribe(() => seen.push(u.state()));
    u.start();
    expect(u.state()).toEqual({ k: "checking" });
    gate.resolve(null);
    await flush();
    expect(u.state()).toEqual({ k: "current", at: AT });
    expect(seen).toEqual([{ k: "checking" }, { k: "current", at: AT }]);
    expect(h.check).toHaveBeenCalledTimes(1);
    u.stop();
  });

  it("a check that finds an update is available with its version", async () => {
    const h = harness();
    const u = await available(h, "0.3.1");
    expect(h.install).not.toHaveBeenCalled();
    u.stop();
  });

  it.each([
    ["an Error's message", new Error("error sending request for url (https://webboard.rokass.org/releases/latest.json)"), "error sending request for url (https://webboard.rokass.org/releases/latest.json)"],
    ["a string as itself", "the platform `linux-x86_64` was not found in the response `platforms` object", "the platform `linux-x86_64` was not found in the response `platforms` object"],
    ["anything else through String", 42, "42"],
  ])("a rejected check is checkFailed carrying %s", async (_name, error, message) => {
    const h = harness();
    h.check.mockRejectedValueOnce(error);
    const u = createUpdates(h.deps);
    u.start();
    await flush();
    expect(u.state()).toEqual({ k: "checkFailed", message });
    u.stop();
  });

  it("Try again after a failed check checks again", async () => {
    const h = harness();
    h.check.mockRejectedValueOnce(new Error("offline"));
    const u = createUpdates(h.deps);
    u.start();
    await flush();
    expect(u.state()).toEqual({ k: "checkFailed", message: "offline" });
    const again = u.check();
    expect(u.state()).toEqual({ k: "checking" });
    await again;
    expect(u.state()).toEqual({ k: "current", at: AT });
    expect(h.check).toHaveBeenCalledTimes(2);
    u.stop();
  });

  it("a check while one is running does nothing", async () => {
    const h = harness();
    const gate = deferred<Found | null>();
    h.check.mockReturnValueOnce(gate.promise);
    const u = createUpdates(h.deps);
    u.start();
    await u.check();
    expect(h.check).toHaveBeenCalledTimes(1);
    gate.resolve(null);
    await flush();
    expect(u.state()).toEqual({ k: "current", at: AT });
    u.stop();
  });

  it("re-checks every 24 hours while it runs, and stops with stop()", async () => {
    vi.useFakeTimers();
    const h = harness();
    const u = createUpdates(h.deps);
    u.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.check).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(DAY - 1);
    expect(h.check).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.check).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(DAY);
    expect(h.check).toHaveBeenCalledTimes(3);
    u.stop();
    await vi.advanceTimersByTimeAsync(3 * DAY);
    expect(h.check).toHaveBeenCalledTimes(3);
  });

  it("start while it runs is a programming error; after stop it starts again without a second check in flight", async () => {
    const h = harness();
    const gate = deferred<Found | null>();
    h.check.mockReturnValueOnce(gate.promise);
    const u = createUpdates(h.deps);
    u.start();
    expect(() => u.start()).toThrow("Updates: start() while it runs");
    u.stop();
    u.start();
    expect(h.check).toHaveBeenCalledTimes(1);
    gate.resolve(null);
    await flush();
    expect(u.state()).toEqual({ k: "current", at: AT });
    u.stop();
  });

  it.each(["downloading", "installing"] as const)("the 24 h check is skipped while %s", async (phase) => {
    vi.useFakeTimers();
    const h = harness();
    const gate = deferred<void>();
    h.install.mockImplementationOnce((_u, onProgress) => {
      onProgress({ t: "downloading", downloaded: 0, total: 1000 });
      if (phase === "installing") onProgress({ t: "installing" });
      return gate.promise;
    });
    h.check.mockResolvedValueOnce({ version: "0.2.0" });
    const u = createUpdates(h.deps);
    u.start();
    await vi.advanceTimersByTimeAsync(0);
    void u.install();
    await vi.advanceTimersByTimeAsync(0);
    expect(u.state().k).toBe(phase);
    await vi.advanceTimersByTimeAsync(DAY);
    await u.check();
    expect(h.check).toHaveBeenCalledTimes(1);
    expect(u.state().k).toBe(phase);
    u.stop();
  });

  it.each(["available", "installFailed"] as const)("the 24 h check is skipped while an update is known (%s); the palette's check still checks", async (known) => {
    vi.useFakeTimers();
    const h = harness();
    h.check.mockResolvedValueOnce({ version: "0.2.0" });
    if (known === "installFailed") h.install.mockRejectedValueOnce(new Error("connection reset"));
    const u = createUpdates(h.deps);
    u.start();
    await vi.advanceTimersByTimeAsync(0);
    if (known === "installFailed") await u.install();
    expect(u.state().k).toBe(known);
    h.check.mockRejectedValue(new Error("offline"));
    await vi.advanceTimersByTimeAsync(3 * DAY);
    expect(h.check).toHaveBeenCalledTimes(1);
    expect(u.state().k).toBe(known);
    await u.check();
    expect(h.check).toHaveBeenCalledTimes(2);
    expect(u.state()).toEqual({ k: "checkFailed", message: "offline" });
    u.stop();
  });

  it("a subscriber's error after a check propagates as itself, not as a failed check", async () => {
    const h = harness();
    const u = createUpdates(h.deps);
    const boom = new Error("the sidebar broke");
    u.subscribe(() => {
      if (u.state().k === "current") throw boom;
    });
    await expect(u.check()).rejects.toBe(boom);
    expect(u.state()).toEqual({ k: "current", at: AT });
    expect(h.report).not.toHaveBeenCalled();
  });
});

describe("installing", () => {
  it("progress is downloading with a percent only when the total is known, then installing", async () => {
    const h = harness();
    const u = await available(h);
    const seen: UpdateState[] = [];
    u.subscribe(() => seen.push(u.state()));
    const gate = deferred<void>();
    let progress!: (p: InstallProgress) => void;
    h.install.mockImplementationOnce((_u, onProgress) => {
      progress = onProgress;
      return gate.promise;
    });
    const done = u.install();
    expect(u.state()).toEqual({ k: "downloading", version: "0.2.0", percent: null });
    progress({ t: "downloading", downloaded: 0, total: null });
    expect(u.state()).toEqual({ k: "downloading", version: "0.2.0", percent: null });
    progress({ t: "downloading", downloaded: 512, total: null });
    expect(u.state()).toEqual({ k: "downloading", version: "0.2.0", percent: null });
    progress({ t: "downloading", downloaded: 0, total: 2000 });
    expect(u.state()).toEqual({ k: "downloading", version: "0.2.0", percent: 0 });
    progress({ t: "downloading", downloaded: 999, total: 2000 });
    expect(u.state()).toEqual({ k: "downloading", version: "0.2.0", percent: 49 });
    progress({ t: "downloading", downloaded: 2000, total: 2000 });
    expect(u.state()).toEqual({ k: "downloading", version: "0.2.0", percent: 100 });
    progress({ t: "installing" });
    expect(u.state()).toEqual({ k: "installing", version: "0.2.0" });
    gate.resolve();
    await done;
    expect(seen.map((s) => s.k)).toEqual(["downloading", "downloading", "downloading", "downloading", "downloading", "downloading", "installing"]);
    u.stop();
  });

  it("a successful install closes the registry, then restarts", async () => {
    const h = harness();
    const u = await available(h);
    await u.install();
    expect(h.calls).toEqual(["check", "install 0.2.0", "closeRegistry", "restart"]);
    u.stop();
  });

  it("the registry is not closed before the install has finished", async () => {
    const h = harness();
    const u = await available(h);
    const gate = deferred<void>();
    h.install.mockReturnValueOnce(gate.promise);
    const done = u.install();
    await flush();
    expect(h.closeRegistry).not.toHaveBeenCalled();
    gate.resolve();
    await done;
    expect(h.closeRegistry).toHaveBeenCalledTimes(1);
    expect(h.restart).toHaveBeenCalledTimes(1);
    u.stop();
  });

  it("a failed install is installFailed with its message, and nothing is closed or restarted", async () => {
    const h = harness();
    const u = await available(h);
    h.install.mockRejectedValueOnce("signature verification failed");
    await u.install();
    expect(u.state()).toEqual({ k: "installFailed", version: "0.2.0", message: "signature verification failed" });
    expect(h.closeRegistry).not.toHaveBeenCalled();
    expect(h.restart).not.toHaveBeenCalled();
    u.stop();
  });

  it("Try again after a failed install installs the same update again", async () => {
    const h = harness();
    const u = await available(h);
    h.install.mockRejectedValueOnce(new Error("connection reset"));
    await u.install();
    expect(u.state()).toEqual({ k: "installFailed", version: "0.2.0", message: "connection reset" });
    await u.install();
    expect(h.install.mock.calls.map((c) => c[0])).toEqual([{ version: "0.2.0" }, { version: "0.2.0" }]);
    expect(h.calls).toEqual(["check", "install 0.2.0", "closeRegistry", "restart"]);
    u.stop();
  });

  it("a failed close after the install reports it and never restarts", async () => {
    const h = harness();
    const u = await available(h);
    h.closeRegistry.mockRejectedValueOnce(new Error("Could not save “Alpha”: disk full."));
    await u.install();
    const line = "WebBoard 0.2.0 is installed, but WebBoard could not save everything before restarting: Could not save “Alpha”: disk full. Close the window again to quit, then start WebBoard.";
    expect(installedButNotSaved("0.2.0", "Could not save “Alpha”: disk full.")).toBe(line);
    expect(u.state()).toEqual({ k: "closeFailed", version: "0.2.0", line });
    expect(h.restart).not.toHaveBeenCalled();
    await u.install();
    await u.check();
    expect(h.install).toHaveBeenCalledTimes(1);
    expect(h.check).toHaveBeenCalledTimes(1);
    expect(h.closeRegistry).toHaveBeenCalledTimes(1);
    u.stop();
  });

  it("a second Install and restart while one runs does nothing", async () => {
    const h = harness();
    const u = await available(h);
    const gate = deferred<void>();
    h.install.mockReturnValueOnce(gate.promise);
    const first = u.install();
    await u.install();
    expect(h.install).toHaveBeenCalledTimes(1);
    gate.resolve();
    await first;
    expect(h.calls).toEqual(["check", "closeRegistry", "restart"]);
    u.stop();
  });

  it("install with no update found does nothing", async () => {
    const h = harness();
    const u = createUpdates(h.deps);
    u.start();
    await flush();
    await u.install();
    expect(h.install).not.toHaveBeenCalled();
    expect(u.state()).toEqual({ k: "current", at: AT });
    u.stop();
  });

  it("a failed restart after the install and the close is restartFailed with its copy, and nothing else is called", async () => {
    const h = harness();
    const u = await available(h);
    const failure = new Error("could not relaunch");
    h.restart.mockImplementationOnce(async () => {
      h.calls.push("restart");
      throw failure;
    });
    await expect(u.install()).resolves.toBeUndefined();
    const line = "WebBoard 0.2.0 is installed and everything is saved, but WebBoard could not restart: could not relaunch Quit WebBoard and start it again.";
    expect(restartFailedLine("0.2.0", "could not relaunch")).toBe(line);
    expect(u.state()).toEqual({ k: "restartFailed", version: "0.2.0", line });
    await u.install();
    await u.check();
    expect(h.calls).toEqual(["check", "install 0.2.0", "closeRegistry", "restart"]);
    u.stop();
  });
});

describe("reporting", () => {
  const failure = new Error("the original");

  it("a failed check reports the original error", async () => {
    const h = harness();
    h.check.mockRejectedValueOnce(failure);
    const u = createUpdates(h.deps);
    await u.check();
    expect(h.report.mock.calls).toEqual([[failure]]);
    expect(h.report.mock.calls[0]?.[0]).toBe(failure);
  });

  it.each([
    ["install", (h: Harness) => h.install.mockRejectedValueOnce(failure), "installFailed"],
    ["closeRegistry", (h: Harness) => h.closeRegistry.mockRejectedValueOnce(failure), "closeFailed"],
    ["restart", (h: Harness) => h.restart.mockRejectedValueOnce(failure), "restartFailed"],
  ] as const)("a failed %s reports the original error", async (_name, fail, k) => {
    const h = harness();
    const u = await available(h);
    fail(h);
    await u.install();
    expect(u.state().k).toBe(k);
    expect(h.report).toHaveBeenCalledTimes(1);
    expect(h.report.mock.calls[0]?.[0]).toBe(failure);
    u.stop();
  });

  it("nothing is reported when every step succeeds", async () => {
    const h = harness();
    const u = await available(h);
    await u.install();
    expect(h.report).not.toHaveBeenCalled();
    u.stop();
  });
});
