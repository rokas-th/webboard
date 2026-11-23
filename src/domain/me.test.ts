import { act } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PlanSession } from "../store/session";
import { testSession } from "../test/session";
import { meId, meOf } from "./me";
import type { PersonId } from "./model";
import { peopleOf } from "./people";

vi.mock("@tauri-apps/api/core", () => import("../test/tauriMock"));

const sessions: PlanSession[] = [];

afterEach(async () => {
  await Promise.all(sessions.splice(0).map((s) => s.close()));
});

const crew = async (): Promise<{ session: PlanSession; ids: Record<string, PersonId> }> => {
  const t = await testSession([
    { id: "a", name: "a", start: "2026-11-10" },
    { id: "b", name: "b", start: "2026-11-10" },
  ]);
  sessions.push(t.session);
  const ids: Record<string, PersonId> = {};
  act(() => {
    [
      ["Mira Okafor", "MO"],
      ["Dana Lee", "DL"],
      ["Ole Berg", "OB"],
    ].forEach(([name, initials]) => {
      const known = peopleOf(t.session.view().plan);
      t.session.apply({ t: "person", op: "add", name, initials, colour: "sky", after: known.length === 0 ? null : known[known.length - 1].id });
    });
    peopleOf(t.session.view().plan).forEach((p) => {
      ids[p.initials] = p.id;
    });
  });
  const phone = await t.peer("iphone");
  sessions.push(phone.session);
  phone.session.apply({ t: "assign", items: ["a"], person: ids.DL });
  act(() => {
    t.session.apply({ t: "person", op: "remove", person: ids.DL, to: null });
    t.session.apply({ t: "person", op: "remove", person: ids.OB, to: null });
    phone.sync();
  });
  return { session: t.session, ids };
};

describe("meOf", () => {
  it("is none without a choice, live for a live person, removed with the former name, and missing for an id the plan never held", async () => {
    const { session, ids } = await crew();
    const view = session.view();
    expect(meOf(view, null)).toEqual({ kind: "none" });
    const live = meOf(view, ids.MO);
    expect(live.kind === "live" ? live.person.name : null).toBe("Mira Okafor");
    expect(meOf(view, ids.DL)).toEqual({ kind: "removed", id: ids.DL, name: "Dana Lee" });
    expect(meOf(view, ids.OB)).toEqual({ kind: "removed", id: ids.OB, name: null });
    expect(meOf(view, "nobody")).toEqual({ kind: "missing", id: "nobody" });
  });

  it("gives an id only for a live me", async () => {
    const { session, ids } = await crew();
    const view = session.view();
    expect([meOf(view, null), meOf(view, ids.MO), meOf(view, ids.DL), meOf(view, "nobody")].map(meId)).toEqual([null, ids.MO, null, null]);
  });

  it("reads the former map the session builds", async () => {
    const { session, ids } = await crew();
    expect([...session.view().former].map(([id, v]) => [id, v.n])).toEqual([[ids.DL, "Dana Lee"]]);
  });
});
