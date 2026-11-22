import { afterEach, describe, expect, it, vi } from "vitest";
import type { HolidayDay, HolidayYear, RegionRef } from "../../domain/calendar";
import type { PlanState } from "../../domain/model";
import type { PlanSession } from "../../store/session";
import { testSession, type TestSession, type TestSessionOpts, type SeedItem } from "../../test/session";
import { bannerText, describeUnit, heldChoice, itemChoices, unitSubject } from "./describe";

vi.mock("@tauri-apps/api/core", () => import("../../test/tauriMock"));

const sessions: PlanSession[] = [];

afterEach(async () => {
  await Promise.all(sessions.splice(0).map((s) => s.close()));
});

const made = async (seed: readonly SeedItem[], opts?: TestSessionOpts): Promise<TestSession> => {
  const t = await testSession(seed, opts);
  sessions.push(t.session);
  return t;
};

const GROUPS: readonly SeedItem[] = [
  { id: "S", name: "Sprint 4", kind: "group" },
  { id: "Q", name: "QA", kind: "group", parent: "S" },
  { id: "a", name: "Review", parent: "Q", start: "2026-11-10", dur: 3 },
  { id: "b", name: "Build", start: "2026-11-16", dur: 2 },
];

const groupsPlan = async (): Promise<PlanState> => (await made(GROUPS)).session.view().plan;

const NONE: ReadonlyMap<string, string> = new Map();

const day = (date: string): HolidayDay => ({ date, name: "Holiday", kind: "public", sourceId: "x", scope: null });

const year = (region: string, n: number): HolidayYear => ({
  region,
  year: 2027,
  days: Array.from({ length: n }, (_, i) => day(`2027-01-${String(i + 1).padStart(2, "0")}`)),
  fetchedAt: "2026-11-09T08:00:00Z",
});

const withRegion = (plan: PlanState, region: RegionRef | null): PlanState => ({ ...plan, calendar: { ...plan.calendar, region } });

describe("describeUnit", () => {
  it("reads a schedule", async () => {
    const plan = await groupsPlan();
    expect(describeUnit("s:a", ["2026-11-25", 4, "doing", 40, "now"], plan, NONE)).toBe("starts 25 Nov · 4 working days · in progress");
    expect(describeUnit("s:a", ["2026-11-25", 4, "todo", 0, "now"], plan, NONE)).toBe("starts 25 Nov · 4 working days");
    expect(describeUnit("s:a", ["2026-11-25", 1, "done", 100, "later"], plan, NONE)).toBe("starts 25 Nov · 1 working day · done");
    expect(describeUnit("s:a", ["2026-11-25", 0, "todo", 0, "now"], plan, NONE)).toBe("starts 25 Nov");
    expect(describeUnit("s:a", [null, 4, "todo", 0, "later"], plan, NONE)).toBe("unscheduled · 4 working days");
  });

  it("reads names, existence and place", async () => {
    const plan = await groupsPlan();
    expect(describeUnit("n:a", "Plan file format", plan, NONE)).toBe("“Plan file format”");
    expect(describeUnit("pn", "MESA 1.0", plan, NONE)).toBe("“MESA 1.0”");
    expect(describeUnit("e:a", { k: "task", t: true }, plan, NONE)).toBe("in the Trash");
    expect(describeUnit("e:a", { k: "task", t: false }, plan, NONE)).toBe("in the plan");
    expect(describeUnit("p:a", ["S", "a0"], plan, NONE)).toBe("in “Sprint 4”");
    expect(describeUnit("p:a", ["Q", "a0"], plan, NONE)).toBe("in “Sprint 4 › QA”");
    expect(describeUnit("p:a", [null, "a0"], plan, NONE)).toBe("at the top level");
  });

  it("reads references, sorted, without their values", async () => {
    const plan = await groupsPlan();
    expect(describeUnit("r:a", {}, plan, NONE)).toBe("no references");
    expect(describeUnit("r:a", { "ticket:x/y#1": "" }, plan, NONE)).toBe("1 reference: ticket:x/y#1");
    expect(describeUnit("r:a", { "ticket:x/y#2": "", "ticket:x/y#1": "" }, plan, NONE)).toBe("2 references: ticket:x/y#1, ticket:x/y#2");
  });

  it("reads a link", async () => {
    const plan = await groupsPlan();
    expect(describeUnit("l:a>b", ["SS", 2], plan, NONE)).toBe("SS +2d");
    expect(describeUnit("l:a>b", ["FS", 0], plan, NONE)).toBe("FS");
    expect(describeUnit("l:a>b", ["FF", -1], plan, NONE)).toBe("FF −1d");
    expect(describeUnit("l:a>b", null, plan, NONE)).toBe("no link");
  });

  it("reads weekdays and the holiday region", async () => {
    const plan = await groupsPlan();
    expect(describeUnit("cw", [1, 2, 3, 4], plan, NONE)).toBe("Mon–Thu");
    expect(describeUnit("cw", [1, 3, 5], plan, NONE)).toBe("Mon, Wed, Fri");
    expect(describeUnit("cr", { src: "openholidays", country: "CH", subdivision: "CH-ZH" }, plan, NONE)).toBe("holiday region CH-ZH");
    expect(describeUnit("cr", { src: "openholidays", country: "CH", subdivision: null }, plan, NONE)).toBe("holiday region CH");
    expect(describeUnit("cr", { src: "govuk", division: "scotland" }, plan, NONE)).toBe("holiday region Scotland");
    expect(describeUnit("cr", { src: "opm" }, plan, NONE)).toBe("holiday region US federal (OPM)");
    expect(describeUnit("cr", { src: "ics", url: "https://x.example/a.ics", name: "Team" }, plan, NONE)).toBe("holiday region “Team”");
    expect(describeUnit("cr", null, plan, NONE)).toBe("no holiday region");
  });

  it("reads closures and tuning", async () => {
    const plan = await groupsPlan();
    expect(describeUnit("cc:c1", ["2026-12-28", "2026-12-31", "Year-end"], plan, NONE)).toBe("closure 28–31 Dec “Year-end”");
    expect(describeUnit("cc:c1", ["2026-12-28", "2027-01-02", "Year-end"], plan, NONE)).toBe("closure 28 Dec–2 Jan “Year-end”");
    expect(describeUnit("cc:c1", ["2026-12-24", "2026-12-24", "Eve"], plan, NONE)).toBe("closure 24 Dec “Eve”");
    expect(describeUnit("cc:c1", null, plan, NONE)).toBe("no closure");
    expect(describeUnit("ct:2026-11-17", { kind: "add", name: "Away" }, plan, NONE)).toBe("day off “Away”");
    expect(describeUnit("ct:2026-11-17", { kind: "work" }, plan, NONE)).toBe("work this day");
    expect(describeUnit("ct:2026-11-17", { kind: "off" }, plan, NONE)).toBe("counted as a day off");
    expect(describeUnit("ct:2026-11-17", null, plan, NONE)).toBe("not tuned");
  });

  it("reads a holiday year by its source", async () => {
    const plan = await groupsPlan();
    expect(describeUnit("ch:2027", year("oh:CH:CH-ZH", 9), plan, NONE)).toBe("2027: 9 days from OpenHolidays");
    expect(describeUnit("ch:2027", year("oh:CH:CH-ZH", 1), plan, NONE)).toBe("2027: 1 day from OpenHolidays");
    expect(describeUnit("ch:2027", year("govuk:scotland", 9), plan, NONE)).toBe("2027: 9 days from GOV.UK");
    expect(describeUnit("ch:2027", year("opm", 9), plan, NONE)).toBe("2027: 9 days from US OPM");
    const ics = withRegion(plan, { src: "ics", url: "https://x.example/a.ics", name: "Team" });
    expect(describeUnit("ch:2027", year("ics:https://x.example/a.ics", 9), ics, NONE)).toBe("2027: 9 days from “Team”");
    expect(describeUnit("ch:2027", year("ics:https://y.example/b.ics", 9), ics, NONE)).toBe("2027: 9 days from a calendar link");
    expect(describeUnit("ch:2027", null, plan, NONE)).toBe("2027: no holiday data");
  });

  it("reads baselines and activity", async () => {
    const plan = await groupsPlan();
    expect(describeUnit("b:B1", { name: "Before", at: "2026-11-09", dates: {} }, plan, NONE)).toBe("baseline “Before”");
    expect(describeUnit("b:B1", null, plan, NONE)).toBe("removed");
    expect(describeUnit("a:x1", true, plan, NONE)).toBe("this change stands");
    expect(describeUnit("a:x1", false, plan, new Map([["x1", "Moved “Review”"]]))).toBe("this change is undone: Moved “Review”");
    expect(() => describeUnit("a:x1", false, plan, NONE)).toThrow(new Error("No label for action x1"));
  });

  it("reads a step and an item's step", async () => {
    const base = await groupsPlan();
    const plan: PlanState = { ...base, workflow: { steps: new Map([["qa", { n: "QA", c: "sky", o: "a1V" }], ["later", null]]), items: new Map() } };
    expect(describeUnit("ws:qa", { n: "QA", c: "sky", o: "a1V" }, plan, NONE)).toBe("step “QA” · sky");
    expect(describeUnit("ws:qa", { n: "Ship", c: "lime", o: "a1V", d: true }, plan, NONE)).toBe("step “Ship” · lime · completes");
    expect(describeUnit("ws:qa", { n: "QA", c: "sky", o: "a1V", l: 4 }, plan, NONE)).toBe("step “QA” · sky · limit 4");
    expect(describeUnit("ws:done", { n: "Done", c: "lime", o: "a3", d: true, l: 12 }, plan, NONE)).toBe("step “Done” · lime · completes · limit 12");
    expect(describeUnit("ws:qa", null, plan, NONE)).toBe("removed");
    expect(describeUnit("wi:a", null, plan, NONE)).toBe("no step");
    expect(describeUnit("wi:a", "qa", plan, NONE)).toBe("in step “QA”");
    expect(describeUnit("wi:a", "now", plan, NONE)).toBe("in step “Now”");
    expect(describeUnit("wi:a", "later", plan, NONE)).toBe("in a removed step");
    expect(describeUnit("wi:a", "gone", plan, NONE)).toBe("in a removed step");
  });

  it("reads a person and an item's assignees", async () => {
    const base = await groupsPlan();
    const plan: PlanState = {
      ...base,
      people: {
        persons: new Map([
          ["mira", { n: "Mira Okafor", i: "MO", c: "cyan", o: "a1" }],
          ["ole", { n: "Ole Berg", i: "OB", c: "lime", o: "a0" }],
          ["gone", null],
        ]),
        assignees: new Map(),
      },
    };
    expect(describeUnit("pp:mira", { n: "Mira Okafor", i: "MO", c: "cyan", o: "a1" }, plan, NONE)).toBe("person “Mira Okafor” · MO · cyan");
    expect(describeUnit("pp:mira", null, plan, NONE)).toBe("removed");
    expect(describeUnit("pa:a", null, plan, NONE)).toBe("unassigned");
    expect(describeUnit("pa:a", [], plan, NONE)).toBe("unassigned");
    expect(describeUnit("pa:a", ["mira"], plan, NONE)).toBe("assigned to “Mira Okafor”");
    expect(describeUnit("pa:a", ["gone", "mira"], plan, NONE)).toBe("assigned to “Mira Okafor” and a former person");
    expect(describeUnit("pa:a", ["mira", "ole"], plan, NONE)).toBe("assigned to “Ole Berg” and “Mira Okafor”");
    expect(describeUnit("pa:a", ["gone", "mira", "nobody", "ole"], plan, NONE)).toBe("assigned to “Ole Berg”, “Mira Okafor” and 2 former people");
    expect(describeUnit("pa:a", ["gone"], plan, NONE)).toBe("assigned to a former person");
  });
});

describe("unitSubject", () => {
  const SEED: readonly SeedItem[] = [
    { id: "a", name: "Review", start: "2026-11-10", dur: 3 },
    { id: "b", name: "Build", start: "2026-11-16", dur: 2, deps: [{ from: "a", type: "FS", lag: 0 }] },
  ];

  it("names the subject of every unit kind", async () => {
    const base = (await made(SEED)).session.view().plan;
    const plan: PlanState = { ...base, baselines: new Map([["B1", { id: "B1", name: "Before", at: "2026-11-09", dates: {} }]]) };
    ["e:a", "n:a", "s:a", "p:a", "r:a"].forEach((u) => expect([u, unitSubject(u, plan)]).toEqual([u, "“Review”"]));
    expect(unitSubject("l:a>b", plan)).toBe("The link “Review” → “Build”");
    ["cr", "cw", "cc:c1", "ct:2026-11-17", "ch:2027"].forEach((u) => expect([u, unitSubject(u, plan)]).toEqual([u, "The calendar"]));
    expect(unitSubject("pn", plan)).toBe("The plan name");
    expect(unitSubject("b:B1", plan)).toBe("Baseline “Before”");
    expect(unitSubject("b:B2", plan)).toBe("A removed baseline");
    expect(unitSubject("a:x1", plan)).toBe("The change");
    expect(() => unitSubject("n:zz", plan)).toThrow(new Error("No item zz"));
  });

  it("names a step and an item's step", async () => {
    const base = (await made(SEED)).session.view().plan;
    const plan: PlanState = { ...base, workflow: { steps: new Map([["qa", { n: "QA", c: "sky", o: "a1V" }], ["later", null]]), items: new Map([["a", "qa"]]) } };
    expect(unitSubject("ws:qa", plan)).toBe("The step “QA”");
    expect(unitSubject("ws:next", plan)).toBe("The step “Next”");
    expect(unitSubject("ws:later", plan)).toBe("A removed step");
    expect(unitSubject("ws:gone", plan)).toBe("A removed step");
    expect(unitSubject("wi:a", plan)).toBe("“Review”");
    expect(() => unitSubject("wi:zz", plan)).toThrow(new Error("No item zz"));
  });

  it("names a person and an item's assignees", async () => {
    const base = (await made(SEED)).session.view().plan;
    const plan: PlanState = {
      ...base,
      people: { persons: new Map([["mira", { n: "Mira Okafor", i: "MO", c: "cyan", o: "a1" }], ["gone", null]]), assignees: new Map([["a", ["mira"]]]) },
    };
    expect(unitSubject("pp:mira", plan)).toBe("The person “Mira Okafor”");
    expect(unitSubject("pp:gone", plan)).toBe("A removed person");
    expect(unitSubject("pp:nobody", plan)).toBe("A removed person");
    expect(unitSubject("pa:a", plan)).toBe("“Review”");
    expect(() => unitSubject("pa:zz", plan)).toThrow(new Error("No item zz"));
  });
});

describe("reachability helpers", () => {
  const AB: readonly SeedItem[] = [
    { name: "A", start: "2026-11-10", dur: 3 },
    { name: "B", start: "2026-11-16", dur: 2 },
    { name: "C", start: "2026-11-18", dur: 1 },
  ];

  it("lists a link clash on both ends and on neither other item", async () => {
    const t = await made(AB, { clashes: [{ unit: "l:A>B", mac: ["FS", 0], iphone: ["SS", 1] }] });
    const view = t.session.view();
    expect(view.choices).toHaveLength(1);
    expect(itemChoices(view, "A")).toEqual([view.choices[0]]);
    expect(itemChoices(view, "B")).toEqual([view.choices[0]]);
    expect(itemChoices(view, "C")).toEqual([]);
  });

  it("lists the item's choices once each, in view order", async () => {
    const t = await made(AB, {
      clashes: [
        { unit: "n:A", mac: "North", iphone: "South" },
        { unit: "l:A>B", mac: ["FS", 0], iphone: ["SS", 1] },
      ],
    });
    const view = t.session.view();
    expect(view.choices).toHaveLength(2);
    expect(itemChoices(view, "A").map((c) => c.id)).toEqual(view.choices.map((c) => c.id));
    expect(itemChoices(view, "B").map((c) => c.units)).toEqual([["l:A>B"]]);
  });

  it("lists a clash on an item's step under that item, and a step clash under no item", async () => {
    const t = await made(AB, {
      clashes: [
        { unit: "wi:A", mac: "next", iphone: "later" },
        { unit: "ws:qa", mac: { n: "QA", c: "sky", o: "a1V" }, iphone: { n: "Check", c: "sky", o: "a1V" } },
      ],
    });
    const view = t.session.view();
    expect(view.choices).toHaveLength(2);
    const step = view.choices.find((c) => c.units.includes("ws:qa"));
    const item = view.choices.find((c) => c.units.includes("wi:A"));
    if (step === undefined || item === undefined) throw new Error("fixture: expected a step and an item-step choice");
    expect(item.kind).toBe("items");
    expect(item.items).toEqual(["A"]);
    expect(step.kind).toBe("items");
    expect(step.items).toEqual([]);
    expect(itemChoices(view, "A")).toEqual([item]);
    expect(itemChoices(view, "B")).toEqual([]);
    expect([...view.held]).toEqual([]);
  });

  it("lists a clash on an item's assignees under that item, and a person clash under no item", async () => {
    const t = await made(AB, {
      clashes: [
        { unit: "pa:A", mac: ["mira"], iphone: ["ole"] },
        { unit: "pp:mira", mac: { n: "Mira Okafor", i: "MO", c: "cyan", o: "a0" }, iphone: { n: "Mira Oka", i: "MO", c: "cyan", o: "a0" } },
      ],
    });
    const view = t.session.view();
    expect(view.choices).toHaveLength(2);
    const person = view.choices.find((c) => c.units.includes("pp:mira"));
    const item = view.choices.find((c) => c.units.includes("pa:A"));
    if (person === undefined || item === undefined) throw new Error("fixture: expected a person and an assignees choice");
    expect(item.kind).toBe("items");
    expect(item.items).toEqual(["A"]);
    expect(person.kind).toBe("items");
    expect(person.items).toEqual([]);
    expect(itemChoices(view, "A")).toEqual([item]);
    expect(itemChoices(view, "B")).toEqual([]);
    expect([...view.held]).toEqual([]);
  });

  it("finds the choice that holds the held items", async () => {
    const name = await made(AB, { clashes: [{ unit: "n:A", mac: "North", iphone: "South" }] });
    expect(heldChoice(name.session.view())).toBeNull();
    const sched = await made(AB, { clashes: [{ unit: "s:A", mac: ["2026-11-10", 3, "todo", 0, "now"], iphone: ["2026-11-12", 3, "todo", 0, "now"] }] });
    const view = sched.session.view();
    expect(heldChoice(view)).toBe(view.choices[0]);
  });

  it("finds the choice that holds the item, not an earlier rename choice that only lists it", async () => {
    const t = await made(AB, {
      clashes: [
        { unit: "n:A", mac: "North", iphone: "South" },
        { unit: "s:A", mac: ["2026-11-10", 3, "todo", 0, "now"], iphone: ["2026-11-12", 3, "todo", 0, "now"] },
      ],
    });
    const view = t.session.view();
    const rename = view.choices.find((c) => c.units.includes("n:A"));
    const schedule = view.choices.find((c) => c.units.includes("s:A"));
    if (rename === undefined || schedule === undefined) throw new Error("fixture: expected a rename and a schedule choice");
    expect(rename).not.toBe(schedule);
    expect([...view.held]).toEqual(["A"]);
    expect(heldChoice({ ...view, choices: [rename, schedule] })).toBe(schedule);
    expect(heldChoice({ ...view, choices: [schedule, rename] })).toBe(schedule);
  });

  it("names the sides in the banner, this device first, then by label", async () => {
    const t = await made(AB, { clashes: [{ unit: "n:A", mac: "North", iphone: "South" }] });
    const found = t.session.view().choices[0];
    const side = (label: string) => {
      const s = found.sides.find((x) => x.label === label);
      if (s === undefined) throw new Error(`fixture: no side ${label}`);
      return s;
    };
    const c = { ...found, sides: [side("iPhone"), side("Mac")] };
    expect(bannerText(c, "Mac")).toBe("Changed on Mac and iPhone. Choose which to keep.");
    expect(bannerText(c, "iPhone")).toBe("Changed on iPhone and Mac. Choose which to keep.");
    const three = { ...c, sides: [{ key: "x", label: "Mac — earlier copy", actions: [], values: new Map() }, ...c.sides] };
    expect(bannerText(three, "Mac")).toBe("Changed on Mac, iPhone and Mac — earlier copy. Choose which to keep.");
  });
});
