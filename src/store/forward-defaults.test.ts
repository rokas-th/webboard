import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import type { Action, Write } from "../log/types";
import { act } from "../test/act";
import { MESA_SEED, SEED_ROOT, testSession } from "../test/session";
import type { PlanSession } from "./session";
import { NEWER_PLAN } from "./session";
import { encodeAction, PlanDoc } from "./doc";
import { buildImport, encodeWbx } from "./file";
import { AppError } from "../services/ipc";

vi.mock("@tauri-apps/api/core", () => import("../test/tauriMock"));

vi.mock("../plan/units", async (importOriginal) => {
  const current = await importOriginal<typeof import("../plan/units")>();
  const previous = await import("../test/fixtures/units-5d95e96");
  return { ...current, validateWrite: previous.validateWrite, parseKey: previous.parseKey, key: previous.key };
});

const DEFAULTS_WRITE: Write = { u: "pd", v: { dur: 5, dated: false, who: null, group: null, step: null }, c: "own" };

const sessions: PlanSession[] = [];

afterEach(async () => {
  await Promise.all(sessions.splice(0).map((s) => s.close()));
});

const thrown = (f: () => unknown): unknown => {
  try {
    f();
  } catch (e) {
    return e;
  }
  throw new Error("expected a throw");
};

describe("the previous reader and plan defaults", () => {
  it("the current reader accepts the pd write, so the guard below measures the previous one", async () => {
    const current = await vi.importActual<typeof import("../plan/units")>("../plan/units");
    expect(() => current.validateWrite(DEFAULTS_WRITE)).not.toThrow();
    const previous = await import("../test/fixtures/units-5d95e96");
    expect(() => previous.validateWrite(DEFAULTS_WRITE)).toThrow("Unknown unit key “pd”");
  });

  it("a plan with a pd action opens read-only for the previous reader", async () => {
    const defaults = act("pdf00000001", [SEED_ROOT], [DEFAULTS_WRITE], { dev: "iphone", lbl: "New tasks now last 5 working days" });
    const t = await testSession(MESA_SEED, { raw: { [defaults.id]: encodeAction(defaults) } });
    sessions.push(t.session);
    const view = t.session.view();
    expect(view.newer).toBe(true);
    expect(t.session.readOnly).toBe(true);
    expect(t.session.readOnlyReason).toBe(NEWER_PLAN);
    expect(view.unreadable.map((u) => u.id)).toEqual([defaults.id]);
    expect(view.unreadable[0]?.message).toContain("Unknown unit key “pd”");
    expect(view.plan.items.size).toBe(MESA_SEED.length);
    expect(view.plan.defaults).toBeNull();
  });

  it("the previous reader refuses the .webboard as unknown data (pd)", () => {
    const root: Action = act(
      "a0",
      [],
      [
        { u: "pn", v: "MESA 1.0", c: "own" },
        { u: "cw", v: [1, 2, 3, 4, 5], c: "own" },
        { u: "cr", v: null, c: "own" },
        { u: "e:t3", v: { k: "task", t: false }, c: "own" },
        { u: "n:t3", v: "Tracking: review results", c: "own" },
        { u: "s:t3", v: ["2026-11-09", 4, "todo", 0, "later"], c: "own" },
        { u: "p:t3", v: [null, "a0"], c: "own" },
      ],
      { dev: "mac" },
    );
    const doc = new Y.Doc();
    const pd = new PlanDoc(doc);
    pd.append(root, ["t3"]);
    pd.append(act("a1", ["a0"], [DEFAULTS_WRITE], { dev: "mac" }), []);
    const update = Y.encodeStateAsUpdate(doc);
    const bytes = encodeWbx({ planId: "P0000000000", name: "MESA 1.0", exportedAt: "2026-11-22T09:00:00Z", updateLength: update.length }, update);
    const err = thrown(() => buildImport(bytes, "MESA 1.0.webboard", "mac", "ses-mac", 1000));
    expect(err).toBeInstanceOf(AppError);
    expect(err instanceof AppError && err.code).toBe("import.unknown_units");
    expect(err instanceof Error && err.message).toBe("This plan uses data this WebBoard does not know (pd); update WebBoard to open it.");
  });
});
