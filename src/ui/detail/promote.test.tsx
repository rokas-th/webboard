import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlanSession } from "../../store/session";
import { seedPanesClosed } from "../../test/panes";
import { MESA_SEED, testSession } from "../../test/session";
import { shellFor } from "../../test/shell";
import { resetTauri } from "../../test/tauriMock";
import { withSync } from "../../test/withSync";
import { clearToasts } from "../common/Toast";
import { PLACE_KEY } from "../state";
import { useDetail, type DetailApi } from "./DetailContext";

vi.mock("@tauri-apps/api/core", () => import("../../test/tauriMock"));

const seen: { api: DetailApi | null } = { api: null };

vi.mock("../board/Board", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../board/Board")>()),
  Board: function Board() {
    seen.api = useDetail();
    return <div className="board-probe" />;
  },
}));

const sessions: PlanSession[] = [];

beforeEach(() => {
  window.localStorage.clear();
  resetTauri({});
  seen.api = null;
});

afterEach(async () => {
  cleanup();
  clearToasts();
  vi.restoreAllMocks();
  await Promise.all(sessions.splice(0).map((s) => s.close()));
  window.localStorage.clear();
});

describe("the shell's promote", () => {
  it("throws, naming the item, when the item is not in the plan", async () => {
    const t = await testSession(MESA_SEED);
    sessions.push(t.session);
    window.localStorage.setItem(PLACE_KEY, JSON.stringify({ plan: t.session.view().plan.id, view: "board", zoom: "W" }));
    seedPanesClosed(["outline"]);
    render(withSync(shellFor(t).ui));
    await act(async () => {
      await new Promise<void>((r) => setTimeout(r, 0));
      await new Promise<void>((r) => setTimeout(r, 0));
    });
    const api = seen.api;
    if (api === null) throw new Error("the board probe never rendered");
    expect(() => api.promote("nope")).toThrow("Shell: no item nope to open as a modal");
    expect(() => api.rename("nope")).toThrow("Shell: no item nope to rename");
  });
});
