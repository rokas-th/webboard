import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResolveOptions } from "../../actions/resolve";
import type { Choice } from "../../plan/choices";
import type { PlanSession } from "../../store/session";
import { testSession, type Clash, type TestSession } from "../../test/session";
import { impactText } from "../calendar/impact";
import { unitSubject } from "./describe";
import { sideSummary } from "./outcome";
import { sideContent, type SideContent } from "./side";

vi.mock("@tauri-apps/api/core", () => import("../../test/tauriMock"));

const sessions: PlanSession[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(sessions.splice(0).map((s) => s.close()));
});

const defaults: ResolveOptions = { pushFromPredecessors: true, returnPushed: true };

const made = async (clashes: readonly Clash[]): Promise<TestSession> => {
  const t = await testSession(
    [
      { name: "A", start: "2026-11-10", dur: 3 },
      { name: "B", start: "2026-11-16", dur: 2 },
    ],
    { clashes },
  );
  sessions.push(t.session);
  return t;
};

const only = (t: TestSession): Choice => {
  const cs = t.session.view().choices;
  if (cs.length !== 1) throw new Error(`fixture: ${cs.length} choices`);
  return cs[0];
};

const sideKey = (c: Choice, label: string): string => {
  const s = c.sides.find((x) => x.label === label);
  if (s === undefined) throw new Error(`fixture: no side ${label}`);
  return s.key;
};

const contentOf = (t: TestSession, c: Choice, label: string): { got: SideContent; rp: ReturnType<PlanSession["previewResolve"]>; calls: number } => {
  const side = sideKey(c, label);
  const rp = t.session.previewResolve(c.id, { side }, defaults);
  const spy = vi.spyOn(t.session, "previewResolve");
  const got = sideContent(t.session, c, { side }, defaults);
  const calls = spy.mock.calls.length;
  spy.mockRestore();
  return { got, rp, calls };
};

describe("sideContent", () => {
  it("reads a rename clash", async () => {
    const t = await made([{ unit: "n:A", mac: "North", iphone: "South" }]);
    const c = only(t);
    const s = unitSubject("n:A", t.session.view().plan);
    const mac = contentOf(t, c, "Mac");
    const iphone = contentOf(t, c, "iPhone");
    expect(mac.got.values).toEqual([`${s}: “North”`]);
    expect(iphone.got.values).toEqual([`${s}: “South”`]);
    [mac, iphone].forEach(({ got, rp, calls }) => {
      expect(got.summary).toBe("moves 0");
      expect(got.stopped).toEqual([]);
      expect(got.kept).toEqual(rp.preview.kept);
      expect(got.impact).toBeNull();
      expect(got.rows).toEqual(rp.rows);
      expect(calls).toBe(1);
    });
  });

  it("reads a calendar clash with its impact line", async () => {
    const t = await made([{ unit: "ct:2026-11-17", mac: { kind: "add", name: "Away" }, iphone: null }]);
    const c = only(t);
    const mac = contentOf(t, c, "Mac");
    const iphone = contentOf(t, c, "iPhone");
    expect(mac.got.values).toEqual(["The calendar: day off “Away”"]);
    expect(iphone.got.values).toEqual(["The calendar: not tuned"]);
    [mac, iphone].forEach(({ got, rp, calls }) => {
      expect(got.impact).toBe(impactText(rp.preview));
      expect(got.summary).toBe(sideSummary(rp));
      expect(calls).toBe(1);
    });
  });

  it("reads a baseline clash", async () => {
    const t = await made([{ unit: "b:B1", mac: { name: "Before", at: "2026-11-09", dates: {} }, iphone: null }]);
    const c = only(t);
    const s = unitSubject("b:B1", t.session.view().plan);
    const mac = contentOf(t, c, "Mac");
    const iphone = contentOf(t, c, "iPhone");
    expect(mac.got.values).toEqual([`${s}: baseline “Before”`]);
    expect(iphone.got.values).toEqual([`${s}: removed`]);
    [mac, iphone].forEach(({ got, calls }) => {
      expect(got.summary).toBe("moves 0");
      expect(got.impact).toBeNull();
      expect(calls).toBe(1);
    });
  });

  it("reads a two-item rename, one line per unit", async () => {
    const t = await made([{ unit: ["n:A", "n:B"], mac: ["North", "East"], iphone: ["South", "West"] }]);
    const c = only(t);
    expect(c.kind).toBe("items");
    const plan = t.session.view().plan;
    const name = (id: string): string => {
      const it = plan.items.get(id);
      if (it === undefined) throw new Error(`fixture: no item ${id}`);
      return it.name;
    };
    const a = name("A");
    const b = name("B");
    const mac = contentOf(t, c, "Mac");
    const iphone = contentOf(t, c, "iPhone");
    expect(mac.got.values).toEqual([`“${a}”: “North”`, `“${b}”: “East”`]);
    expect(iphone.got.values).toEqual([`“${a}”: “South”`, `“${b}”: “West”`]);
    expect([mac.calls, iphone.calls]).toEqual([1, 1]);
  });
});
