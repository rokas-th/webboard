import { afterEach, expect, it, vi } from "vitest";
import { testSession, type TestSession } from "./session";

vi.mock("@tauri-apps/api/core", () => import("./tauriMock"));

const open: TestSession[] = [];

afterEach(async () => {
  await Promise.all(open.splice(0).map((t) => t.session.close()));
});

const made = async (...a: Parameters<typeof testSession>): Promise<TestSession> => {
  const t = await testSession(...a);
  open.push(t);
  return t;
};

it("a peer's move reaches the main session on sync", async () => {
  const t = await made([{ name: "A", start: "2026-11-10", dur: 3 }]);
  const p = await t.peer("iphone");
  p.session.apply({ t: "move", items: ["A"], days: 2 });
  p.sync();
  expect(t.session.view().plan.items.get("A")?.schedule?.start).toBe("2026-11-12");
  await p.session.close();
});

it("moves made apart become one items choice", async () => {
  const t = await made([{ name: "A", start: "2026-11-10", dur: 3 }]);
  const p = await t.peer("iphone");
  t.session.apply({ t: "move", items: ["A"], days: 1 });
  p.session.apply({ t: "move", items: ["A"], days: 2 });
  p.sync();
  expect(t.session.view().choices).toHaveLength(1);
  expect(t.session.view().choices[0].kind).toBe("items");
  await p.session.close();
});

it("seeds one root action and names the devices", async () => {
  const t = await made([{ id: "sprint4", name: "Sprint 4", kind: "group" }, { name: "Review", parent: "sprint4", start: "2026-11-10", dur: 2, note: "n" }]);
  const h = t.session.history();
  expect(h.map((e) => e.id)).toEqual(["seed0000000"]);
  expect(h[0].device).toBe("Mac");
  expect(t.session.view().plan.items.get("Review")?.place.parent).toBe("sprint4");
  expect(t.session.note("Review").toString()).toBe("n");
});
