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
  const previous = await import("../test/fixtures/units-fb6af2f");
  return { ...current, validateWrite: previous.validateWrite, parseKey: previous.parseKey, key: previous.key };
});

const PEOPLE_WRITES: readonly Write[] = [
  { u: "pp:mira", v: { n: "Mira Okafor", i: "MO", c: "cyan", o: "a0" }, c: "own" },
  { u: "pa:t3", v: ["mira"], c: "own" },
];

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

describe("the previous reader and people", () => {
  it("the current reader accepts the people writes, so the guard below measures the previous one", async () => {
    const current = await vi.importActual<typeof import("../plan/units")>("../plan/units");
    PEOPLE_WRITES.forEach((w) => expect(() => current.validateWrite(w)).not.toThrow());
    const previous = await import("../test/fixtures/units-fb6af2f");
    PEOPLE_WRITES.forEach((w) => expect(() => previous.validateWrite(w)).toThrow(`Unknown unit key “${w.u}”`));
    expect(() => previous.validateWrite(PEOPLE_WRITES[0])).toThrow("Unknown unit key “pp:mira”");
  });

  it("a plan with a people action opens read-only for the previous reader", async () => {
    const people = act("ppl00000001", [SEED_ROOT], PEOPLE_WRITES, { dev: "iphone", lbl: "Added “Mira Okafor” to people" });
    const t = await testSession(MESA_SEED, { raw: { [people.id]: encodeAction(people) } });
    sessions.push(t.session);
    const view = t.session.view();
    expect(view.newer).toBe(true);
    expect(t.session.readOnly).toBe(true);
    expect(t.session.readOnlyReason).toBe(NEWER_PLAN);
    expect(view.unreadable.map((u) => u.id)).toEqual([people.id]);
    expect(view.unreadable[0]?.message).toContain("Unknown unit key “pp:mira”");
    expect(view.plan.items.size).toBe(MESA_SEED.length);
    expect(view.plan.items.get("t3")?.name).toBe("Tracking: review results");
    expect(view.plan.items.get("t3")?.schedule?.horizon).toBe("later");
    expect(view.plan.workflow).toEqual({ steps: new Map(), items: new Map() });
    expect(view.plan.people).toEqual({ persons: new Map(), assignees: new Map() });
    expect(view.people).toEqual({ people: [], assignees: new Map(), problems: [] });
  });

  it("the previous reader refuses the .webboard as unknown data (pa:…, pp:…)", () => {
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
    pd.append(act("a1", ["a0"], PEOPLE_WRITES, { dev: "mac" }), []);
    const update = Y.encodeStateAsUpdate(doc);
    const bytes = encodeWbx({ planId: "P0000000000", name: "MESA 1.0", exportedAt: "2026-11-22T09:00:00Z", updateLength: update.length }, update);
    const err = thrown(() => buildImport(bytes, "MESA 1.0.webboard", "mac", "ses-mac", 1000));
    expect(err).toBeInstanceOf(AppError);
    expect(err instanceof AppError && err.code).toBe("import.unknown_units");
    expect(err instanceof Error && err.message).toBe("This plan uses data this WebBoard does not know (pa:t3, pp:mira); update WebBoard to open it.");
  });
});
