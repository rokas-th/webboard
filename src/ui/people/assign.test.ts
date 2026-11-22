import { describe, expect, it } from "vitest";
import type { Assignee, Person } from "../../domain/people";
import { assigneeName, assignSection, cardPeople, PEOPLE_SETTINGS_ROW, PERSON_ROW, personOfRow } from "./assign";

const person = (id: string, name: string, initials: string, order: string): Person => ({ id, name, initials, colour: "violet", order });

const MIRA = person("mira", "Mira Okafor", "MO", "a0");
const OLE = person("ole", "Ole Berg", "OB", "a1");
const ANA = person("ana", "Ana Ruiz", "AR", "a2");

const live = (p: Person): Assignee => ({ kind: "live", person: p });
const DANA: Assignee = { kind: "former", id: "dana", name: "Dana Lee", initials: "DL", colour: "sky" };
const NAMELESS: Assignee = { kind: "former", id: "gone", name: null, initials: null, colour: null };

describe("assignSection", () => {
  it("lists the people in Settings order under Assign, checkable, with the held ones checked", () => {
    expect(assignSection([MIRA, OLE, ANA], ["ana", "mira"])).toEqual({
      title: "Assign",
      rows: [
        { id: "person:mira", title: "Mira Okafor", checked: true, checkable: true },
        { id: "person:ole", title: "Ole Berg", checked: false, checkable: true },
        { id: "person:ana", title: "Ana Ruiz", checked: true, checkable: true },
      ],
    });
  });

  it("ignores held ids of people no longer in the plan", () => {
    expect(assignSection([OLE], ["dana", "ole"])?.rows.map((r) => [r.id, r.checked])).toEqual([["person:ole", true]]);
  });

  it("is null when the plan has no people", () => {
    expect(assignSection([], [])).toBeNull();
    expect(assignSection([], ["dana"])).toBeNull();
  });
});

describe("personOfRow", () => {
  it("reads the person of a person row and null for any other row", () => {
    expect(PERSON_ROW).toBe("person:");
    expect(PEOPLE_SETTINGS_ROW).toBe("people-settings");
    expect(personOfRow("person:mira")).toBe("mira");
    expect(personOfRow("open")).toBeNull();
    expect(personOfRow("step:now")).toBeNull();
    expect(personOfRow(PEOPLE_SETTINGS_ROW)).toBeNull();
  });

  it("refuses a person row that names nobody", () => {
    expect(() => personOfRow("person:")).toThrow('The row "person:" names no person');
  });
});

describe("cardPeople", () => {
  it("shows the first assignee and counts the rest", () => {
    expect(cardPeople([live(MIRA), live(ANA)])).toEqual({ first: live(MIRA), more: 1 });
    const shown = cardPeople([live(MIRA), live(ANA)]);
    expect(shown?.first.kind === "live" ? shown.first.person.initials : null).toBe("MO");
  });

  it("shows a former person alone with no count", () => {
    expect(cardPeople([DANA])).toEqual({ first: DANA, more: 0 });
  });

  it("is null for an empty list", () => {
    expect(cardPeople([])).toBeNull();
  });
});

describe("assigneeName", () => {
  it("names a live person, a former person with a name and one without", () => {
    expect(assigneeName(live(MIRA))).toBe("Mira Okafor");
    expect(assigneeName(DANA)).toBe("Former: Dana Lee");
    expect(assigneeName(NAMELESS)).toBe("Former person");
  });
});
