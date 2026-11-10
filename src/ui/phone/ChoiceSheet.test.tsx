import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Refused } from "../../actions/intents";
import type { ResolveOptions } from "../../actions/resolve";
import { newId } from "../../log/ids";
import type { UnitKey } from "../../log/types";
import { sideText, type Choice, type ChoiceSide } from "../../plan/choices";
import type { Registry } from "../../store/registry";
import type { PlanSession } from "../../store/session";
import { phoneRegistry } from "../../test/phone";
import { fs, testSession, type SeedItem, type TestSession, type TestSessionOpts } from "../../test/session";
import { setScreen } from "../../test/setup";
import { impactText } from "../calendar/impact";
import { describeUnit, unitSubject } from "../choices/describe";
import { orderedSides } from "../choices/order";
import { groupRows, outcomeLine } from "../choices/outcome";
import { sideContent, type SideContent } from "../choices/side";
import { clearToasts } from "../common/Toast";
import { useUi, type UiState } from "../state";
import { ChoiceBanner } from "../choices/ChoiceBanner";
import { PhoneShell } from "./PhoneShell";

vi.mock("@tauri-apps/api/core", () => import("../../test/tauriMock"));
vi.mock("../state", async (importOriginal) => {
  const m = await importOriginal<typeof import("../state")>();
  return { ...m, useUi: vi.fn(m.useUi) };
});
vi.mock("../../log/ids", async (importOriginal) => {
  const m = await importOriginal<typeof import("../../log/ids")>();
  return { ...m, newId: vi.fn(m.newId) };
});

const sessions: PlanSession[] = [];
const registries: Registry[] = [];

beforeEach(() => {
  window.localStorage.clear();
  setScreen(390, 844);
});

afterEach(async () => {
  cleanup();
  clearToasts();
  vi.restoreAllMocks();
  vi.mocked(useUi).mockClear();
  vi.mocked(newId).mockReset();
  await Promise.all(sessions.splice(0).map((s) => s.close()));
  await Promise.all(registries.splice(0).map((r) => r.close()));
  window.localStorage.clear();
});

const DEFAULTS: ResolveOptions = { pushFromPredecessors: true, returnPushed: true };

const SETTLED = "This choice was settled meanwhile.";

const CUE = " · show what moves";

const REVIEW: readonly SeedItem[] = [{ name: "Review", start: "2026-11-10", dur: 2 }];

const SPRINT: readonly SeedItem[] = [
  { id: "S", name: "Sprint 4", kind: "group" },
  { name: "Review", parent: "S", start: "2026-11-12", dur: 2 },
  { name: "Ship", parent: "S", start: "2026-11-12", dur: 1 },
  { name: "Build", parent: "S", start: "2026-11-16", dur: 1, deps: [fs("Review")] },
];

const settle = async (): Promise<void> => {
  await act(async () => {
    await new Promise<void>((r) => setTimeout(r, 0));
    await new Promise<void>((r) => setTimeout(r, 0));
  });
};

const made = async (seed: readonly SeedItem[], opts?: TestSessionOpts): Promise<TestSession> => {
  const t = await testSession(seed, opts);
  sessions.push(t.session);
  return t;
};

const peerOf = async (t: TestSession, device = "iphone"): Promise<{ session: PlanSession; sync(): void }> => {
  const p = await t.peer(device);
  sessions.push(p.session);
  return p;
};

const shown = async (t: TestSession): Promise<Registry> => {
  const registry = await phoneRegistry(t);
  registries.push(registry);
  render(<PhoneShell registry={registry} clock={t.clock} />);
  await settle();
  return registry;
};

const uiNow = (): [UiState, (patch: Partial<UiState>) => void] => {
  const results = vi.mocked(useUi).mock.results;
  const r = results[results.length - 1];
  if (r === undefined || r.type !== "return") throw new Error("useUi has not returned");
  return r.value;
};

const setUi = (patch: Partial<UiState>): void => act(() => uiNow()[1](patch));

const all = (sel: string, root: ParentNode = document): HTMLElement[] =>
  [...root.querySelectorAll(sel)].filter((e): e is HTMLElement => e instanceof HTMLElement);

const one = (sel: string, root: ParentNode = document): HTMLElement => {
  const el = root.querySelector(sel);
  if (!(el instanceof HTMLElement)) throw new Error("no " + sel);
  return el;
};

const sheet = (): HTMLElement => screen.getByRole("dialog", { name: "Choose which to keep" });
const toastTexts = (): (string | null)[] => screen.queryAllByRole("status").map((e) => e.textContent);
const badToasts = (): (string | null)[] => all(".toast.bad").map((e) => e.textContent);

const only = (t: TestSession): Choice => {
  const cs = t.session.view().choices;
  if (cs.length !== 1) throw new Error(`fixture: ${cs.length} choices`);
  return cs[0];
};

const keyOf = (c: Choice, label: string): string => {
  const s = c.sides.find((x) => x.label === label);
  if (s === undefined) throw new Error(`fixture: no side ${label}`);
  return s.key;
};

const cards = (): HTMLElement[] => all(".choice-col", sheet());

const cardOf = (t: TestSession, c: Choice, key: string): HTMLElement => {
  const opening = sideText(c, key, t.session.view().plan);
  const card = cards().find((x) => one(".choice-side", x).textContent === opening);
  if (card === undefined) throw new Error("no card opening with " + opening);
  return card;
};

const textOf = (t: TestSession, c: Choice, key: string, content: SideContent): string =>
  [
    sideText(c, key, t.session.view().plan),
    ...content.values,
    content.rows.length === 0 ? content.summary : content.summary + CUE,
    ...content.stopped,
    ...content.kept,
    ...(content.impact === null ? [] : [content.impact]),
  ].join("");

const labelsOf = (t: TestSession): ReadonlyMap<string, string> => new Map(t.session.history().map((e) => [e.id, e.label]));

const switchOf = (name: string): HTMLInputElement => {
  const el = within(sheet()).getByRole("switch", { name });
  if (!(el instanceof HTMLInputElement)) throw new Error("no switch " + name);
  return el;
};

const pickOf = (subject: string): HTMLSelectElement => {
  const el = within(sheet()).getByRole("combobox", { name: subject });
  if (!(el instanceof HTMLSelectElement)) throw new Error("no pick for " + subject);
  return el;
};

const apply = (): HTMLButtonElement => {
  const el = within(sheet()).getByRole("button", { name: "Apply" });
  if (!(el instanceof HTMLButtonElement)) throw new Error("no Apply");
  return el;
};

const startOf = (t: TestSession, id: string): string | null => {
  const s = t.session.view().plan.items.get(id)?.schedule;
  if (s === undefined || s === null) throw new Error(`fixture: no schedule on ${id}`);
  return s.start;
};

const nameOf = (t: TestSession, id: string): string => {
  const it = t.session.view().plan.items.get(id);
  if (it === undefined) throw new Error(`fixture: no item ${id}`);
  return it.name;
};

const sprint = async (): Promise<{ t: TestSession; peer: { session: PlanSession; sync(): void }; c: Choice }> => {
  const t = await made(SPRINT);
  const peer = await peerOf(t);
  vi.mocked(newId).mockReturnValueOnce("a1").mockReturnValueOnce("a2");
  t.session.apply({ t: "move", items: ["Review", "Ship"], days: 2 });
  peer.session.apply({ t: "move", items: ["Review", "Ship"], days: 5 });
  peer.sync();
  return { t, peer, c: only(t) };
};

describe("ChoiceSheet: Step 2's fixture", () => {
  it("cards, options, the grouped rows, per-item picks and Apply", async () => {
    const { t, c } = await sprint();
    expect(c.kind).toBe("items");
    expect(c.sides.map((s) => [s.label, s.key])).toEqual([
      ["Mac", "a1"],
      ["iPhone", "a2"],
    ]);
    expect([startOf(t, "Review"), startOf(t, "Ship"), startOf(t, "Build")]).toEqual(["2026-11-19", "2026-11-19", "2026-11-23"]);
    await shown(t);
    const resolve = vi.spyOn(t.session, "resolve");
    setUi({ dialog: { t: "choice", id: c.id } });
    expect(cards()).toHaveLength(2);
    const mac = cardOf(t, c, "a1");
    const phone = cardOf(t, c, "a2");
    expect(one(".choice-summary", mac).textContent).toBe("moves 3 · show what moves");
    expect(one(".choice-summary", phone).textContent).toBe("moves 0 · show what moves");
    expect(one(".choice-summary", mac).textContent).toBe(sideContent(t.session, c, { side: "a1" }, DEFAULTS).summary + CUE);
    expect(one(".choice-summary", phone).textContent).toBe(sideContent(t.session, c, { side: "a2" }, DEFAULTS).summary + CUE);
    expect(one(".choice-summary .dim", mac).textContent).toBe(CUE);
    expect([switchOf("Push from predecessors").checked, switchOf("Return the items the other side's push moved").checked]).toEqual([true, true]);
    fireEvent.click(one(".choice-summary", mac));
    expect(one(".choice-summary", mac).textContent).toBe("moves 3");
    expect(all(".moves-title", mac).map((e) => e.textContent)).toEqual(["Sprint 4"]);
    expect(all(".moves-line", mac).map((e) => e.textContent)).toEqual([
      "Review  Thu 19 Nov → Mon 16 Nov · −3 working days",
      "Ship  Thu 19 Nov → Mon 16 Nov · −3 working days",
      "Build  Mon 23 Nov → Wed 18 Nov · −3 working days",
    ]);
    const rp = t.session.previewResolve(c.id, { side: "a1" }, DEFAULTS);
    expect(rp.rows.find((r) => r.item === "Review")?.shift).toBe(-3);
    expect([rp.preview.itemsChanged, rp.preview.movedLater, rp.preview.conflictsAfter]).toEqual([3, 0, 0]);
    const other = t.session.previewResolve(c.id, { side: "a2" }, DEFAULTS);
    expect(other.rows.map((r) => r.item)).toEqual(["Review", "Ship"]);
    expect(other.rows.every((r) => JSON.stringify(r.before) === JSON.stringify(r.after))).toBe(true);
    fireEvent.click(within(sheet()).getByRole("radio", { name: "Mac" }));
    expect(within(sheet()).getByRole("radio", { name: "Mac" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.change(pickOf("“Ship”"), { target: { value: "a2" } });
    fireEvent.click(apply());
    expect(resolve.mock.calls).toEqual([[c.id, { side: "a1", perUnit: new Map([["s:Ship", "a2"]]) }, DEFAULTS]]);
    const built = resolve.mock.results[0]?.value;
    expect(toastTexts()).toEqual([built?.toast]);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(uiNow()[0].dialog).toBeNull();
    expect([startOf(t, "Review"), startOf(t, "Ship")]).toEqual(["2026-11-16", "2026-11-19"]);
    expect(t.session.view().held.size).toBe(0);
    expect(screen.queryByRole("button", { name: /held/ })).toBeNull();
  });

  it("the item sheet of a held item shows its banner before every control, and Choose opens the choice's sheet", async () => {
    const { t, c } = await sprint();
    const registry = await shown(t);
    setUi({ selected: "Review" });
    const item = screen.getByRole("dialog", { name: "Review" });
    const banners = all(".choice-banner", item);
    expect(banners).toHaveLength(1);
    const banner = banners[0];
    const controls = all("button, input, select, textarea", one(".sheet-body", item)).filter((e) => !banner.contains(e));
    expect(controls.length).toBeGreaterThan(0);
    controls.forEach((ctl) => expect(banner.compareDocumentPosition(ctl) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0));
    expect(one(".banner-text", banner).textContent).toBe(`Changed on ${orderedSides(c, registry.device.name).map((s) => s.label).join(" and ")}. Choose which to keep.`);
    fireEvent.click(within(banner).getByRole("button", { name: "Choose" }));
    expect(uiNow()[0].dialog).toEqual({ t: "choice", id: c.id });
    expect(cards()).toHaveLength(2);
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
  });

  it("toggling an option changes the summary", async () => {
    const { t, c } = await sprint();
    await shown(t);
    const preview = vi.spyOn(t.session, "previewResolve");
    const resolve = vi.spyOn(t.session, "resolve");
    setUi({ dialog: { t: "choice", id: c.id } });
    preview.mockClear();
    fireEvent.click(switchOf("Return the items the other side's push moved"));
    const off: ResolveOptions = { pushFromPredecessors: true, returnPushed: false };
    expect(switchOf("Return the items the other side's push moved").checked).toBe(false);
    expect(new Set(preview.mock.calls.map((x) => JSON.stringify([x[0], x[1], x[2]])))).toEqual(
      new Set(["a1", "a2"].map((side) => JSON.stringify([c.id, { side }, off]))),
    );
    expect(one(".choice-summary", cardOf(t, c, "a1")).textContent).toBe("moves 2 · show what moves");
    expect(one(".choice-summary", cardOf(t, c, "a1")).textContent).toBe(sideContent(t.session, c, { side: "a1" }, off).summary + CUE);
    fireEvent.click(within(sheet()).getByRole("radio", { name: "Mac" }));
    fireEvent.click(apply());
    expect(resolve.mock.calls).toEqual([[c.id, { side: "a1" }, off]]);
    expect(startOf(t, "Build")).toBe("2026-11-23");
  });

  it("settled on another device closes the sheet", async () => {
    const { t, peer, c } = await sprint();
    await shown(t);
    const resolve = vi.spyOn(t.session, "resolve");
    setUi({ dialog: { t: "choice", id: c.id } });
    expect(sheet()).toBeTruthy();
    peer.session.resolve(c.id, { side: "a2" }, DEFAULTS);
    act(() => peer.sync());
    await settle();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(uiNow()[0].dialog).toBeNull();
    expect(toastTexts()).toEqual(["This choice was settled meanwhile."]);
    expect(resolve).toHaveBeenCalledTimes(0);
    expect(t.session.view().choices).toEqual([]);
  });

  it("shows an Apply that resolve refuses as one bad toast", async () => {
    const { t, c } = await sprint();
    await shown(t);
    setUi({ dialog: { t: "choice", id: c.id } });
    vi.spyOn(t.session, "resolve").mockImplementation(() => {
      throw new Refused(SETTLED);
    });
    fireEvent.click(apply());
    await settle();
    expect(badToasts()).toEqual([SETTLED]);
    expect(toastTexts()).toEqual([SETTLED]);
  });

  it("says it once when an Apply loses the race with the sync that settled it", async () => {
    const { t, peer, c } = await sprint();
    await shown(t);
    setUi({ dialog: { t: "choice", id: c.id } });
    const real = t.session.resolve.bind(t.session);
    const resolve = vi.spyOn(t.session, "resolve").mockImplementation((...args) => {
      peer.session.resolve(c.id, { side: "a2" }, DEFAULTS);
      peer.sync();
      return real(...args);
    });
    fireEvent.click(apply());
    await settle();
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(badToasts()).toEqual([SETTLED]);
    expect(toastTexts()).toEqual([SETTLED]);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(uiNow()[0].dialog).toBeNull();
    expect(t.session.view().choices).toEqual([]);
  });

  it("opens on the offered side, and Apply keeps it", async () => {
    const { t, c } = await sprint();
    await shown(t);
    const resolve = vi.spyOn(t.session, "resolve");
    setUi({ dialog: { t: "choice", id: c.id, side: "a1" } });
    expect(within(sheet()).getByRole("radio", { name: "Mac" }).getAttribute("aria-checked")).toBe("true");
    expect(within(sheet()).getByRole("radio", { name: "iPhone" }).getAttribute("aria-checked")).toBe("false");
    expect(cardOf(t, c, "a1").classList.contains("picked")).toBe(true);
    expect(within(sheet()).queryByRole("button", { name: "Keep the other version" })).toBeNull();
    fireEvent.click(apply());
    expect(resolve.mock.calls).toEqual([[c.id, { side: "a1" }, DEFAULTS]]);
  });

  it("disables Apply while read-only", async () => {
    const { t, c } = await sprint();
    await shown(t);
    setUi({ dialog: { t: "choice", id: c.id } });
    expect(apply().disabled).toBe(false);
    act(() => t.session.setReadOnly(true));
    expect(apply().disabled).toBe(true);
    act(() => t.session.setReadOnly(false));
    expect(apply().disabled).toBe(false);
  });
});

describe("ChoiceSheet: cards match the desktop column", () => {
  it("n: card values", async () => {
    const t = await made(REVIEW, { clashes: [{ unit: "n:Review", mac: "Review A", iphone: "Review B" }] });
    const c = only(t);
    await shown(t);
    setUi({ dialog: { t: "choice", id: c.id } });
    const plan = t.session.view().plan;
    const subject = unitSubject("n:Review", plan);
    expect(subject).toBe(`“${nameOf(t, "Review")}”`);
    [
      ["Mac", "Review A"],
      ["iPhone", "Review B"],
    ].forEach(([label, value]) => {
      const key = keyOf(c, label);
      const card = cardOf(t, c, key);
      const side = c.sides.find((s) => s.key === key);
      if (side === undefined) throw new Error("no side");
      expect(one(".choice-side", card).textContent).toBe(label);
      expect(describeUnit("n:Review", side.values.get("n:Review"), plan, labelsOf(t))).toBe(`“${value}”`);
      expect(all(".choice-value", card).map((e) => e.textContent)).toContain(`${subject}: “${value}”`);
      expect(card.textContent).toBe(textOf(t, c, key, sideContent(t.session, c, { side: key }, DEFAULTS)));
    });
  });

  it("ct: card values", async () => {
    const t = await made(REVIEW, { clashes: [{ unit: "ct:2026-11-17", mac: { kind: "add", name: "Away" }, iphone: null }] });
    const c = only(t);
    await shown(t);
    setUi({ dialog: { t: "choice", id: c.id } });
    const plan = t.session.view().plan;
    c.sides.forEach((s) => {
      const card = cardOf(t, c, s.key);
      expect(card.textContent).toContain(describeUnit("ct:2026-11-17", s.values.get("ct:2026-11-17"), plan, labelsOf(t)));
      expect(one(".recal", card).textContent).toBe(impactText(t.session.previewResolve(c.id, { side: s.key }, DEFAULTS).preview));
      expect(card.textContent).toBe(textOf(t, c, s.key, sideContent(t.session, c, { side: s.key }, DEFAULTS)));
    });
  });

  it("b: card values", async () => {
    const t = await made(REVIEW, {
      clashes: [{ unit: "b:B1", mac: { name: "Before", at: "2026-11-09", dates: {} }, iphone: { name: "Kickoff", at: "2026-11-09", dates: {} } }],
    });
    const c = only(t);
    await shown(t);
    setUi({ dialog: { t: "choice", id: c.id } });
    const plan = t.session.view().plan;
    const texts = c.sides.map((s) => {
      const card = cardOf(t, c, s.key);
      expect(card.textContent).toContain(describeUnit("b:B1", s.values.get("b:B1"), plan, labelsOf(t)));
      return card.textContent;
    });
    expect(texts[0]).not.toBe(texts[1]);
  });

  it("two-item rename names each item", async () => {
    const t = await made(
      [
        { name: "Review", start: "2026-11-10", dur: 2 },
        { name: "Ship", start: "2026-11-12", dur: 1 },
      ],
      { clashes: [{ unit: ["n:Review", "n:Ship"], mac: ["Review A", "Ship A"], iphone: ["Review B", "Ship B"] }] },
    );
    const c = only(t);
    expect(c.kind).toBe("items");
    expect(c.units).toEqual(["n:Review", "n:Ship"]);
    expect(c.sides.map((s) => s.label).sort()).toEqual(["Mac", "iPhone"]);
    const mk = keyOf(c, "Mac");
    const ik = keyOf(c, "iPhone");
    const r = nameOf(t, "Review");
    const s = nameOf(t, "Ship");
    expect([["Review A", "Ship A"], ["Review B", "Ship B"]]).toContainEqual([r, s]);
    await shown(t);
    const resolve = vi.spyOn(t.session, "resolve");
    setUi({ dialog: { t: "choice", id: c.id } });
    expect(all(".choice-value", cardOf(t, c, mk)).map((e) => e.textContent)).toEqual([`“${r}”: “Review A”`, `“${s}”: “Ship A”`]);
    expect(all(".choice-value", cardOf(t, c, ik)).map((e) => e.textContent)).toEqual([`“${r}”: “Review B”`, `“${s}”: “Ship B”`]);
    expect(all(".pick-subject", sheet()).map((e) => e.textContent)).toEqual([`“${r}”`, `“${s}”`]);
    all(".pick-row", sheet()).forEach((row) => {
      const subject = one(".pick-subject", row);
      const select = one("select", row);
      expect(subject.id).not.toBe("");
      expect(select.getAttribute("aria-labelledby")).toBe(subject.id);
      expect(select.hasAttribute("aria-label")).toBe(false);
    });
    expect(pickOf(`“${r}”`)).toBe(one("select", all(".pick-row", sheet())[0]));
    fireEvent.click(within(sheet()).getByRole("radio", { name: "Mac" }));
    fireEvent.change(pickOf(`“${s}”`), { target: { value: ik } });
    fireEvent.click(apply());
    expect(resolve.mock.calls).toEqual([[c.id, { side: mk, perUnit: new Map([["n:Ship", ik]]) }, DEFAULTS]]);
    expect(within(one(".phone-list")).getByText("Review A")).toBeTruthy();
    expect(within(one(".phone-list")).getByText("Ship B")).toBeTruthy();
  });

  it("says so when a sync drops a per-item pick", async () => {
    const t = await made(
      [
        { name: "Review", start: "2026-11-10", dur: 2 },
        { name: "Ship", start: "2026-11-12", dur: 1 },
      ],
      { clashes: [{ unit: ["n:Review", "n:Ship"], mac: ["Review A", "Ship A"], iphone: ["Review B", "Ship B"] }] },
    );
    const c = only(t);
    const peer = await peerOf(t);
    await shown(t);
    setUi({ dialog: { t: "choice", id: c.id } });
    fireEvent.change(pickOf(`“${nameOf(t, "Ship")}”`), { target: { value: keyOf(c, "iPhone") } });
    expect(toastTexts()).toEqual([]);
    act(() => {
      peer.session.apply({ t: "rename", item: "Ship", name: "Ship C" });
      peer.sync();
    });
    await settle();
    const after = only(t);
    expect([after.id, after.units]).toEqual([c.id, ["n:Review"]]);
    expect(toastTexts()).toEqual(["Your pick for “Ship C” no longer applies."]);
    expect(badToasts()).toEqual([]);
    expect(all(".pick-subject", sheet()).map((e) => e.textContent)).toEqual([`“${nameOf(t, "Review")}”`]);
    const resolve = vi.spyOn(t.session, "resolve");
    fireEvent.click(within(sheet()).getByRole("radio", { name: "Mac" }));
    fireEvent.click(apply());
    expect(resolve.mock.calls).toEqual([[c.id, { side: keyOf(c, "Mac") }, DEFAULTS]]);
  });

  it("delete choice cards open with the side's sentence", async () => {
    const t = await made([
      { id: "S", name: "Sprint 4", kind: "group" },
      { name: "Review", parent: "S", start: "2026-11-10", dur: 2 },
    ]);
    const peer = await peerOf(t);
    t.session.apply({ t: "trash", items: ["S"] });
    peer.session.apply({ t: "rename", item: "Review", name: "Review B" });
    peer.sync();
    const c = only(t);
    expect(c.kind).toBe("delete");
    await shown(t);
    setUi({ dialog: { t: "choice", id: c.id } });
    const plan = t.session.view().plan;
    const mac = cardOf(t, c, keyOf(c, "Mac"));
    const phone = cardOf(t, c, keyOf(c, "iPhone"));
    expect(one(".choice-side", mac).textContent).toBe("“Sprint 4” stays in the Trash");
    expect(one(".choice-side", phone).textContent).toBe("“Sprint 4” is restored with the iPhone's edit");
    expect(all(".choice-value", mac).map((e) => e.textContent)).toContain("“Sprint 4”: in the Trash");
    expect(all(".choice-value", phone).map((e) => e.textContent)).toContain("“Sprint 4”: in the plan");
    c.sides.forEach((side) => {
      const expected = c.units.filter((u) => side.values.has(u)).map((u) => `${unitSubject(u, plan)}: ${describeUnit(u, side.values.get(u), plan, labelsOf(t))}`);
      expect(all(".choice-value", cardOf(t, c, side.key)).map((e) => e.textContent)).toEqual(expected);
    });
    expect(all(".pick-subject", sheet()).map((e) => e.textContent)).toEqual(c.units.map((u) => unitSubject(u, plan)));
    expect(new Set(all(".pick-subject", sheet()).map((e) => e.textContent))).toEqual(new Set(["“Sprint 4”", "“Review B”"]));
  });

  it("three sides, three cards", async () => {
    const t = await made([{ name: "Review", start: "2026-11-10", dur: 2 }]);
    const phone = await peerOf(t, "iphone");
    const pad = await peerOf(t, "ipad");
    t.session.apply({ t: "move", items: ["Review"], days: 1 });
    phone.session.apply({ t: "move", items: ["Review"], days: 2 });
    pad.session.apply({ t: "move", items: ["Review"], days: 3 });
    phone.sync();
    pad.sync();
    const cs = t.session.view().choices.filter((x) => x.units.includes("s:Review"));
    expect(cs).toHaveLength(1);
    const c = cs[0];
    expect(c.sides).toHaveLength(3);
    const registry = await shown(t);
    setUi({ dialog: { t: "choice", id: c.id } });
    const plan = t.session.view().plan;
    expect(cards().map((x) => one(".choice-side", x).textContent)).toEqual(orderedSides(c, registry.device.name).map((s) => sideText(c, s.key, plan)));
  });
});

describe("ChoiceBanner", () => {
  it("renders bannerText and a Choose button", () => {
    const side = (key: string, label: string): ChoiceSide => ({ key, label, actions: [], values: new Map<UnitKey, unknown>() });
    const choice: Choice = {
      id: "c1",
      kind: "items",
      units: ["s:Review"],
      items: ["Review"],
      sides: [side("x", "Mac — earlier copy"), side("m", "Mac"), side("i", "iPhone")],
    };
    const onChoose = vi.fn();
    render(<ChoiceBanner choice={choice} local="Mac" onChoose={onChoose} />);
    expect(one(".choice-banner .banner-text").textContent).toBe("Changed on Mac, iPhone and Mac — earlier copy. Choose which to keep.");
    expect(one(".choice-banner").classList.contains("bad")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Choose" }));
    expect(onChoose).toHaveBeenCalledTimes(1);
  });
});

describe("ChoiceSheet rows", () => {
  it("prints every row of an expanded card under its group, with outcomeLine", async () => {
    const { t, c } = await sprint();
    await shown(t);
    setUi({ dialog: { t: "choice", id: c.id } });
    const plan = t.session.view().plan;
    const content = sideContent(t.session, c, { side: "a1" }, DEFAULTS);
    const card = cardOf(t, c, "a1");
    expect(card.querySelector(".moves-line")).toBeNull();
    fireEvent.click(one(".choice-summary", card));
    const sections = groupRows(content.rows, plan);
    expect(all(".moves-title", card).map((e) => e.textContent)).toEqual(sections.map((x) => x.title));
    expect(all(".moves-line", card).map((e) => e.textContent)).toEqual(sections.flatMap((x) => x.rows.map((r) => outcomeLine(r, plan))));
  });
});
