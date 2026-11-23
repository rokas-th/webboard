import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { testSession, type TestSession } from "../test/session";
import { useNotes, type PlanSession } from "./session";

vi.mock("@tauri-apps/api/core", () => import("../test/tauriMock"));

const sessions: PlanSession[] = [];

afterEach(async () => {
  cleanup();
  await Promise.all(sessions.splice(0).map((s) => s.close()));
});

const made = async (): Promise<TestSession> => {
  const t = await testSession([{ id: "a", name: "A" }]);
  sessions.push(t.session);
  return t;
};

describe("PlanSession notes", () => {
  it("bumps notesVersion and tells subscribers when a note changes here or on another device", async () => {
    const t = await made();
    const p = await t.peer("iphone");
    sessions.push(p.session);
    const cb = vi.fn();
    const off = t.session.onNotes(cb);
    const v0 = t.session.notesVersion();
    t.session.note("a").insert(0, "mac");
    expect([t.session.notesVersion() > v0, cb.mock.calls.length]).toEqual([true, 1]);
    const v1 = t.session.notesVersion();
    p.session.note("a").insert(0, "phone ");
    p.sync();
    expect([t.session.notesVersion() > v1, cb.mock.calls.length]).toEqual([true, 2]);
    off();
    t.session.note("a").insert(0, "x");
    expect(cb.mock.calls.length).toBe(2);
  });

  it("stops counting once closed", async () => {
    const t = await made();
    await t.session.close();
    const v = t.session.notesVersion();
    t.doc.ydoc.getMap("notes").set("b", null);
    expect(t.session.notesVersion()).toBe(v);
  });
});

describe("useNotes", () => {
  it("re-renders on a note change only while active", async () => {
    const t = await made();
    let renders = 0;
    const { rerender } = renderHook(
      (p: { active: boolean }) => {
        renders += 1;
        return useNotes(t.session, p.active);
      },
      { initialProps: { active: false } },
    );
    const before = renders;
    act(() => {
      t.session.note("a").insert(0, "one");
    });
    expect(renders).toBe(before);
    rerender({ active: true });
    const on = renders;
    act(() => {
      t.session.note("a").insert(0, "two");
    });
    expect(renders).toBe(on + 1);
  });
});
