import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { version } from "../../../package.json";
import type { PlanSession } from "../../store/session";
import type { UpdateState, Updates } from "../../store/updates";
import { MESA_SEED, testSession } from "../../test/session";
import { shellFor } from "../../test/shell";
import { resetTauri } from "../../test/tauriMock";
import { withSync } from "../../test/withSync";
import { clearToasts } from "../common/Toast";
import { UpdateLine, UpdatesContext } from "./UpdateLine";

vi.mock("@tauri-apps/api/core", () => import("../../test/tauriMock"));

const sessions: PlanSession[] = [];

beforeEach(() => {
  window.localStorage.clear();
  resetTauri({});
});

afterEach(async () => {
  cleanup();
  clearToasts();
  await Promise.all(sessions.splice(0).map((s) => s.close()));
  window.localStorage.clear();
});

const settle = async (): Promise<void> => {
  await act(async () => {
    await new Promise<void>((r) => setTimeout(r, 0));
    await new Promise<void>((r) => setTimeout(r, 0));
  });
};

interface Fake extends Updates {
  set(s: UpdateState): void;
  check: ReturnType<typeof vi.fn<() => Promise<void>>>;
  install: ReturnType<typeof vi.fn<() => Promise<void>>>;
}

function fake(initial: UpdateState): Fake {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    state: () => state,
    subscribe: (cb) => {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    start: () => undefined,
    stop: () => undefined,
    check: vi.fn<() => Promise<void>>(async () => undefined),
    install: vi.fn<() => Promise<void>>(async () => undefined),
    set: (s) => {
      state = s;
      listeners.forEach((cb) => cb());
    },
  };
}

const AT = new Date(2026, 10, 10, 9, 5, 0, 0).getTime();
const LONG = "error sending request for url (https://webboard.rokass.org/releases/latest.json): client error (Connect): dns error: failed to lookup address information: nodename nor servname provided, or not known";

const lineOf = (): HTMLElement => {
  const el = document.querySelector<HTMLElement>(".update-line");
  if (el === null) throw new Error("no .update-line");
  return el;
};

const texts = (): string[] => [...lineOf().querySelectorAll("p")].map((p) => p.textContent ?? "");
const buttons = (): string[] => [...lineOf().querySelectorAll("button")].map((b) => b.textContent ?? "");

describe("UpdateLine", () => {
  const ROWS: readonly (readonly [string, UpdateState, readonly string[], readonly string[]])[] = [
    ["idle", { k: "idle" }, [], []],
    ["checking", { k: "checking" }, ["Checking for updates…"], []],
    ["current", { k: "current", at: AT }, ["Up to date · checked 09:05"], []],
    ["available", { k: "available", version: "0.2.0" }, ["WebBoard 0.2.0 is available"], ["Install and restart"]],
    ["downloading, size unknown", { k: "downloading", version: "0.2.0", percent: null }, ["Downloading 0.2.0…"], []],
    ["downloading, size known", { k: "downloading", version: "0.2.0", percent: 42 }, ["Downloading 0.2.0… 42%"], []],
    ["installing", { k: "installing", version: "0.2.0" }, ["Installing 0.2.0…"], []],
    ["checkFailed", { k: "checkFailed", message: LONG }, [`Could not check for updates: ${LONG}`], ["Try again"]],
    ["installFailed", { k: "installFailed", version: "0.2.0", message: "signature verification failed" }, ["Could not install 0.2.0: signature verification failed"], ["Try again"]],
    ["closeFailed", { k: "closeFailed", version: "0.2.0", line: "WebBoard 0.2.0 is installed, but …" }, [], []],
    ["restartFailed", { k: "restartFailed", version: "0.2.0", line: "WebBoard 0.2.0 is installed and everything is saved, but …" }, [], []],
  ];

  it.each(ROWS)("%s shows the version first, then its text and control", (_name, state, lines, controls) => {
    render(<UpdateLine updates={fake(state)} />);
    expect(texts()).toEqual([`WebBoard ${version}`, ...lines]);
    expect(buttons()).toEqual(controls);
  });

  it("the available line is amber and every status line carries its full text as a title", () => {
    render(<UpdateLine updates={fake({ k: "available", version: "0.2.0" })} />);
    const status = lineOf().querySelector(".update-status");
    expect(status?.className).toBe("update-status amber");
    expect(status?.getAttribute("title")).toBe("WebBoard 0.2.0 is available");
    cleanup();
    render(<UpdateLine updates={fake({ k: "checkFailed", message: LONG })} />);
    const failed = lineOf().querySelector(".update-status");
    expect(failed?.className).toBe("update-status bad");
    expect(failed?.getAttribute("title")).toBe(`Could not check for updates: ${LONG}`);
  });

  it("Install and restart calls the store's install", () => {
    const u = fake({ k: "available", version: "0.2.0" });
    render(<UpdateLine updates={u} />);
    fireEvent.click(screen.getByRole("button", { name: "Install and restart" }));
    expect(u.install).toHaveBeenCalledTimes(1);
    expect(u.check).not.toHaveBeenCalled();
  });

  it("Try again after a failed check checks again", () => {
    const u = fake({ k: "checkFailed", message: "offline" });
    render(<UpdateLine updates={u} />);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(u.check).toHaveBeenCalledTimes(1);
    expect(u.install).not.toHaveBeenCalled();
  });

  it("Try again after a failed install installs again", () => {
    const u = fake({ k: "installFailed", version: "0.2.0", message: "x" });
    render(<UpdateLine updates={u} />);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(u.install).toHaveBeenCalledTimes(1);
    expect(u.check).not.toHaveBeenCalled();
  });

  it("follows the store", () => {
    const u = fake({ k: "checking" });
    render(<UpdateLine updates={u} />);
    expect(texts()).toEqual([`WebBoard ${version}`, "Checking for updates…"]);
    act(() => u.set({ k: "available", version: "0.3.0" }));
    expect(texts()).toEqual([`WebBoard ${version}`, "WebBoard 0.3.0 is available"]);
  });
});

describe("UpdatesContext", () => {
  it("defaults to no updates", () => {
    let seen: Updates | null | undefined;
    function Probe() {
      return (
        <UpdatesContext.Consumer>
          {(v) => {
            seen = v;
            return null;
          }}
        </UpdatesContext.Consumer>
      );
    }
    render(<Probe />);
    expect(seen).toBeNull();
  });
});

describe("the sidebar", () => {
  it("renders the update line as its last child when updates run", async () => {
    const t = await testSession(MESA_SEED);
    sessions.push(t.session);
    const { ui } = shellFor(t);
    render(<UpdatesContext.Provider value={fake({ k: "available", version: "0.2.0" })}>{withSync(ui)}</UpdatesContext.Provider>);
    await settle();
    const sidebar = document.querySelector("nav.sidebar");
    expect(sidebar?.lastElementChild?.className).toBe("update-line");
    expect(texts()).toEqual([`WebBoard ${version}`, "WebBoard 0.2.0 is available"]);
  });

  it("renders no update line without updates", async () => {
    const t = await testSession(MESA_SEED);
    sessions.push(t.session);
    const { ui } = shellFor(t);
    render(<UpdatesContext.Provider value={null}>{withSync(ui)}</UpdatesContext.Provider>);
    await settle();
    expect(document.querySelector("nav.sidebar")).not.toBeNull();
    expect(document.querySelector(".update-line")).toBeNull();
  });
});
