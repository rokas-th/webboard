import { afterEach, describe, expect, it, vi } from "vitest";
import { OfferRefused } from "../../actions/undo";
import type { PlanSession } from "../../store/session";
import { testSession, type TestSession } from "../../test/session";
import { requestUndo } from "./undo";

vi.mock("@tauri-apps/api/core", () => import("../../test/tauriMock"));

const sessions: PlanSession[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(sessions.splice(0).map((s) => s.close()));
});

const made = async (): Promise<TestSession> => {
  const t = await testSession([{ name: "A", start: "2026-11-10", dur: 3 }]);
  sessions.push(t.session);
  return t;
};

const OFFER = { choice: "c1", side: "s2" };

describe("requestUndo", () => {
  it("opens the offer instead of undoing", async () => {
    const t = await made();
    t.session.apply({ t: "move", items: ["A"], days: 1 });
    vi.spyOn(t.session, "undoOffer").mockReturnValue(OFFER);
    const undo = vi.spyOn(t.session, "undo");
    const open = vi.fn();
    expect(requestUndo(t.session, open)).toBeNull();
    expect(open.mock.calls).toEqual([[OFFER]]);
    expect(undo).not.toHaveBeenCalled();
  });

  it("opens the offer an undo refuses with", async () => {
    const t = await made();
    vi.spyOn(t.session, "undoOffer").mockReturnValue(null);
    vi.spyOn(t.session, "undo").mockImplementation(() => {
      throw new OfferRefused(OFFER);
    });
    const open = vi.fn();
    expect(requestUndo(t.session, open)).toBeNull();
    expect(open.mock.calls).toEqual([[OFFER]]);
  });

  it("returns what the undo built", async () => {
    const t = await made();
    t.session.apply({ t: "move", items: ["A"], days: 1 });
    vi.spyOn(t.session, "undoOffer").mockReturnValue(null);
    const undo = vi.spyOn(t.session, "undo");
    const open = vi.fn();
    const built = requestUndo(t.session, open);
    expect(built).not.toBeNull();
    expect(built).toBe(undo.mock.results[0]?.value);
    expect(open).not.toHaveBeenCalled();
    expect(t.session.view().plan.items.get("A")?.schedule?.start).toBe("2026-11-10");
  });

  it("lets any other error through", async () => {
    const t = await made();
    const boom = new Error("boom");
    vi.spyOn(t.session, "undo").mockImplementation(() => {
      throw boom;
    });
    expect(() => requestUndo(t.session, vi.fn())).toThrow(boom);
  });
});
