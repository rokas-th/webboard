import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { peopleOf } from "../../domain/people";
import type { PlanSession } from "../../store/session";
import { testSession, type SeedItem, type TestSession } from "../../test/session";
import { rowContext, type RowContext } from "../list/columns";
import { Highlight } from "./Highlight";
import { searchMatcher, type Matcher } from "./match";

vi.mock("@tauri-apps/api/core", () => import("../../test/tauriMock"));

const sessions: PlanSession[] = [];

afterEach(async () => {
  cleanup();
  await Promise.all(sessions.splice(0).map((s) => s.close()));
});

const SEED: readonly SeedItem[] = [
  { id: "g", name: "Site works", kind: "group" },
  { id: "h", name: "Pier", kind: "group", parent: "g" },
  { id: "a", name: "Pour footings", parent: "h", start: "2026-11-02", dur: 3 },
  { id: "m", name: "Dome set", kind: "milestone", parent: "g", start: "2026-11-20" },
  { id: "b", name: "Build", start: "2026-11-10", dur: 2, note: "Order the crane\nthen the bolts" },
  { id: "u", name: "Undated", horizon: "next" },
  { id: "e", name: "Empty group", kind: "group" },
];

const made = async (): Promise<TestSession> => {
  const t = await testSession(SEED);
  sessions.push(t.session);
  act(() => {
    t.session.apply({ t: "person", op: "add", name: "Mira Okafor", initials: "MO", colour: "sky", after: null });
    const mira = peopleOf(t.session.view().plan)[0].id;
    t.session.apply({ t: "person", op: "add", name: "Dana Lee", initials: "DL", colour: "lime", after: mira });
    t.session.apply({ t: "assign", items: ["b"], person: mira });
    t.session.apply({ t: "step", op: "rename", step: "next", name: "Review" });
  });
  const dana = peopleOf(t.session.view().plan)[1].id;
  const phone = await t.peer("iphone");
  sessions.push(phone.session);
  phone.session.apply({ t: "assign", items: ["m"], person: dana });
  act(() => {
    t.session.apply({ t: "person", op: "remove", person: dana, to: null });
    phone.sync();
  });
  return t;
};

const ctxOf = (t: TestSession): RowContext => rowContext(t.session.view(), (id) => t.session.note(id).toString());

const IDS = ["g", "h", "a", "m", "b", "u", "e"];

const hits = (match: Matcher | null): string[] => {
  if (match === null) throw new Error("no matcher");
  return IDS.filter((id) => match(id));
};

describe("searchMatcher", () => {
  it("gives null for a blank query", async () => {
    const ctx = ctxOf(await made());
    expect([searchMatcher(ctx, ""), searchMatcher(ctx, "   ")]).toEqual([null, null]);
  });

  it("matches the name as a substring, ignoring case and the query's outer spaces", async () => {
    const ctx = ctxOf(await made());
    expect(hits(searchMatcher(ctx, "FOOT"))).toEqual(["g", "h", "a"]);
    expect(hits(searchMatcher(ctx, "  dome "))).toEqual(["g", "m"]);
  });

  it("matches any line of the note", async () => {
    const ctx = ctxOf(await made());
    expect(hits(searchMatcher(ctx, "crane"))).toEqual(["b"]);
    expect(hits(searchMatcher(ctx, "bolts"))).toEqual(["b"]);
  });

  it("matches the step's name, and not the No step placeholder", async () => {
    const ctx = ctxOf(await made());
    expect(hits(searchMatcher(ctx, "review"))).toContain("u");
    expect(hits(searchMatcher(ctx, "no step"))).toEqual([]);
  });

  it("matches live and former people by name, and not the Former prefix", async () => {
    const ctx = ctxOf(await made());
    expect(hits(searchMatcher(ctx, "okafor"))).toEqual(["b"]);
    expect(hits(searchMatcher(ctx, "dana"))).toEqual(["g", "m"]);
    expect(hits(searchMatcher(ctx, "former"))).toEqual([]);
  });

  it("matches an item by its group's path, and a group by its own name or through a descendant", async () => {
    const ctx = ctxOf(await made());
    expect(hits(searchMatcher(ctx, "pier"))).toEqual(["g", "h", "a"]);
    expect(hits(searchMatcher(ctx, "site works"))).toEqual(["g", "h", "a", "m"]);
    expect(hits(searchMatcher(ctx, "empty"))).toEqual(["e"]);
    expect(hits(searchMatcher(ctx, "zebra"))).toEqual([]);
  });

  it("leaves a trashed child out of its group's match", async () => {
    const t = await made();
    act(() => {
      t.session.apply({ t: "trash", items: ["a"] });
    });
    expect(hits(searchMatcher(ctxOf(t), "foot"))).toEqual(["a"]);
  });
});

describe("Highlight", () => {
  it("marks every match, ignoring case, and keeps the text as written", () => {
    const { container } = render(<Highlight text="Dome set, then the dome bolts" q="DOME" />);
    expect(container.textContent).toBe("Dome set, then the dome bolts");
    expect([...container.querySelectorAll("mark")].map((m) => m.textContent)).toEqual(["Dome", "dome"]);
  });

  it("marks nothing for a blank query or no match", () => {
    const { container } = render(
      <>
        <Highlight text="Dome set" q="  " />
        <Highlight text="Dome set" q="pier" />
      </>,
    );
    expect(container.textContent).toBe("Dome setDome set");
    expect(container.querySelectorAll("mark")).toHaveLength(0);
  });

  it("marks the whole character when a match starts inside one whose lower case is longer", () => {
    const { container } = render(<Highlight text="İstanbul, then İzmir" q="i" />);
    expect(container.textContent).toBe("İstanbul, then İzmir");
    expect([...container.querySelectorAll("mark")].map((m) => m.textContent)).toEqual(["İ", "İ", "i"]);
  });

  it("marks all 40,000 matches in a 120,000-character line", () => {
    const { container } = render(<Highlight text={"dom".repeat(40000)} q="d" />);
    expect(container.querySelectorAll("mark")).toHaveLength(40000);
  });
});
