import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetTauri, tauri } from "../test/tauriMock";
import ProbeApp from "./ProbeApp";

vi.mock("@tauri-apps/api/core", () => import("../test/tauriMock"));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));

const loadAnswer = (): ArrayBuffer => {
  const bytes = new Uint8Array(17);
  new DataView(bytes.buffer).setUint32(9, 1, true);
  return bytes.buffer;
};

const logged = (): string[] => tauri.calls.filter((c) => c.cmd === "probe_log").map((c) => (c.args as { line: string }).line);

const settle = async (): Promise<void> => {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
};

beforeEach(() => {
  document.body.innerHTML = '<div id="root"></div>';
  resetTauri({
    probe_log: () => null,
    store_load: loadAnswer,
    store_append: () => null,
    store_list: () => ["probe"],
    holidays_year: () => ({ days: [{ date: "2027-01-01" }], fetchedAt: "x", fromCache: true, coverage: null }),
  });
});

afterEach(() => {
  cleanup();
});

describe("ProbeApp", () => {
  it("logs ready, the window, paths and holidays on mount, in order, through probe_log", async () => {
    render(<ProbeApp />, { container: document.getElementById("root") as HTMLElement });
    await settle();
    const lines = logged();
    expect(lines[0]).toMatch(/^ready \{"userAgent":/);
    expect(lines[1]).toMatch(/^window \{"on":"mount","inner":\[/);
    expect(lines).toContain('paths {"appended":1,"docs":["probe"],"listed":true}');
    expect(lines).toContain('holidays {"days":1,"fromCache":true,"first":"2027-01-01"}');
  });

  it("logs a keydown with its modifiers", async () => {
    render(<ProbeApp />, { container: document.getElementById("root") as HTMLElement });
    await settle();
    fireEvent.keyDown(screen.getByLabelText("Key probe input"), { key: "k", code: "KeyK", metaKey: true });
    await settle();
    expect(logged()).toContain('keys {"key":"k","code":"KeyK","metaKey":true,"ctrlKey":false,"shiftKey":false,"altKey":false,"target":"input"}');
  });

  it("shows a failed probe_log on screen", async () => {
    tauri.answers.probe_log = () => {
      throw { code: "probe.io", message: "Could not append to probe.log: disk full" };
    };
    render(<ProbeApp />, { container: document.getElementById("root") as HTMLElement });
    await settle();
    expect(screen.getAllByText('probe_log {"error":"probe.io","message":"Could not append to probe.log: disk full"}').length).toBeGreaterThan(0);
  });
});
