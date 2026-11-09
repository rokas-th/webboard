import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Conflict } from "../domain/schedule";
import type { PlanSession } from "../store/session";
import { fs, testSession, type TestSession } from "../test/session";
import { toast } from "./common/Toast";
import { OpenChoice, READ_ONLY, useExec, useRun, type Run } from "./run";

vi.mock("@tauri-apps/api/core", () => import("../test/tauriMock"));
vi.mock("./common/Toast", async (importOriginal) => {
  const m = await importOriginal<typeof import("./common/Toast")>();
  return { ...m, toast: vi.fn() };
});

const sessions: PlanSession[] = [];

afterEach(async () => {
  cleanup();
  vi.mocked(toast).mockClear();
  await Promise.all(sessions.splice(0).map((s) => s.close()));
});

const made = async (...a: Parameters<typeof testSession>): Promise<TestSession> => {
  const t = await testSession(...a);
  sessions.push(t.session);
  return t;
};

function probe(session: PlanSession): { run: () => Run; open: ReturnType<typeof vi.fn> } {
  const open = vi.fn();
  const box: { run: Run | null } = { run: null };
  function Probe() {
    box.run = useRun(session);
    return null;
  }
  render(
    <OpenChoice.Provider value={open}>
      <Probe />
    </OpenChoice.Provider>,
  );
  return {
    run: () => {
      if (box.run === null) throw new Error("probe did not render");
      return box.run;
    },
    open,
  };
}

function now<T>(f: () => T): T {
  const box: { v: T | null; set: boolean } = { v: null, set: false };
  act(() => {
    box.v = f();
    box.set = true;
  });
  if (!box.set) throw new Error("act did not run the callback");
  return box.v as T;
}

const toasts = (): unknown[][] => vi.mocked(toast).mock.calls;

describe("useRun", () => {
  it("toasts the push", async () => {
    const t = await made([
      { name: "A", start: "2026-11-09", dur: 2 },
      { name: "B", start: "2026-11-11", dur: 1, deps: [fs("A")] },
      { name: "C", start: "2026-11-12", dur: 1, deps: [fs("B")] },
      { name: "D", start: "2026-11-13", dur: 1, deps: [fs("C")] },
      { name: "E", start: "2026-11-16", dur: 1, deps: [fs("D")] },
    ]);
    const p = probe(t.session);
    const built = now(() => p.run().run({ t: "move", items: ["A"], days: 6 }));
    expect(built).not.toBeNull();
    expect(built?.toast).toBe("Moved “A” later by 6 working days; 4 dependent items moved.");
    expect(toasts()).toEqual([["Moved “A” later by 6 working days; 4 dependent items moved."]]);
  });

  it("toasts a refusal", async () => {
    const t = await made([
      { id: "sprint4", name: "Sprint 4", kind: "group" },
      { id: "review", name: "Review", parent: "sprint4", start: "2026-11-10", dur: 2 },
    ]);
    const p = probe(t.session);
    now(() => p.run().run({ t: "trash", items: ["sprint4"] }));
    vi.mocked(toast).mockClear();
    const r = now(() => p.run().run({ t: "restore", items: ["review"] }));
    expect(r).toBeNull();
    expect(toasts()).toEqual([["“Review” is inside “Sprint 4”, which is in the Trash. Restore “Sprint 4” first.", "bad"]]);
  });

  it("opens a held choice", async () => {
    const t = await made(
      [
        { name: "A", start: "2026-11-10", dur: 3 },
        { name: "B", start: "2026-11-11", dur: 2, deps: [fs("A")] },
      ],
      { clashes: [{ unit: "s:B", mac: ["2026-11-11", 2, "todo", 0, "now"], iphone: ["2026-11-12", 2, "todo", 0, "now"] }] },
    );
    const view = t.session.view();
    expect(view.held.has("B")).toBe(true);
    const conflict = view.derived.conflicts.find((c): c is Extract<Conflict, { kind: "early" }> => c.kind === "early" && c.succ === "B");
    if (conflict === undefined) throw new Error("fixture: no early conflict on B");
    const p = probe(t.session);
    const r = now(() => p.run().run({ t: "fix", conflict, how: "push" }));
    expect(r).toBeNull();
    expect(toasts()).toEqual([]);
    expect(p.open.mock.calls).toEqual([[view.choices[0].id]]);
  });

  it("toasts kept lines on undo", async () => {
    const t = await made([{ name: "A", start: "2026-11-10", dur: 3 }]);
    const peer = await t.peer("iphone");
    sessions.push(peer.session);
    const p = probe(t.session);
    now(() => p.run().run({ t: "move", items: ["A"], days: 1 }));
    peer.sync();
    peer.session.apply({ t: "move", items: ["A"], days: 2 });
    act(() => peer.sync());
    vi.mocked(toast).mockClear();
    const built = now(() => p.run().undo());
    expect(built).not.toBeNull();
    expect(toasts()).toEqual([[built?.toast]]);
    expect(built?.toast).toContain("“A” was changed since on the iPhone — kept");
  });

  it("read-only", async () => {
    const t = await made([{ name: "A", start: "2026-11-10", dur: 3 }]);
    const p = probe(t.session);
    act(() => t.session.setReadOnly(true));
    const apply = vi.spyOn(t.session, "apply");
    const undo = vi.spyOn(t.session, "undo");
    const redo = vi.spyOn(t.session, "redo");
    expect(now(() => p.run().run({ t: "move", items: ["A"], days: 1 }))).toBeNull();
    expect(now(() => p.run().undo())).toBeNull();
    expect(now(() => p.run().redo())).toBeNull();
    expect(toasts()).toEqual([
      [READ_ONLY, "bad"],
      [READ_ONLY, "bad"],
      [READ_ONLY, "bad"],
    ]);
    expect(apply).not.toHaveBeenCalled();
    expect(undo).not.toHaveBeenCalled();
    expect(redo).not.toHaveBeenCalled();
  });

  it("opens the offered choice when undo is one side of it", async () => {
    const t = await made([{ name: "A", start: "2026-11-10", dur: 3 }]);
    const peer = await t.peer("iphone");
    sessions.push(peer.session);
    const p = probe(t.session);
    now(() => p.run().run({ t: "move", items: ["A"], days: 1 }));
    peer.session.apply({ t: "move", items: ["A"], days: 2 });
    act(() => peer.sync());
    const offer = t.session.undoOffer();
    if (offer === null) throw new Error("fixture: no undo offer");
    vi.mocked(toast).mockClear();
    expect(now(() => p.run().undo())).toBeNull();
    expect(p.open.mock.calls).toEqual([[offer.choice, offer.side]]);
    expect(toasts()).toEqual([]);
  });

  it("lets other errors through", async () => {
    const t = await made([{ name: "A", start: "2026-11-10", dur: 3 }]);
    const box: { exec: ((w: () => null) => unknown) | null } = { exec: null };
    function Probe() {
      box.exec = useExec(t.session);
      return null;
    }
    render(
      <OpenChoice.Provider value={vi.fn()}>
        <Probe />
      </OpenChoice.Provider>,
    );
    const boom = new Error("boom");
    expect(() =>
      box.exec?.(() => {
        throw boom;
      }),
    ).toThrow(boom);
    expect(box.exec?.(() => null)).toBeNull();
    expect(toasts()).toEqual([]);
  });

  it("needs an OpenChoice provider", async () => {
    const t = await made([{ name: "A", start: "2026-11-10", dur: 3 }]);
    function Probe() {
      useRun(t.session);
      return null;
    }
    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(() => render(<Probe />)).toThrow(new Error("useRun needs an OpenChoice provider"));
    quiet.mockRestore();
  });
});
