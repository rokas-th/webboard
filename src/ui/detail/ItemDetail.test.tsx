import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Refused, type Built, type Intent } from "../../actions/intents";
import type { ItemId } from "../../domain/model";
import { NEWER_PLAN, type PlanSession } from "../../store/session";
import { fs, testSession, type SeedItem, type TestSession, type TestSessionOpts } from "../../test/session";
import { themed } from "../../test/theme";
import { clearToasts, Toasts } from "../common/Toast";
import { useReadOnly } from "../phone/readOnly";
import { OpenChoice } from "../run";
import { UiContext, type UiState } from "../state";
import { DetailContext, useDetail, type DetailApi } from "./DetailContext";
import { ItemModal } from "./ItemModal";
import { BACK_TO_MEDIUM, COLLAPSE_TEXT, detentText, EXPAND_FULL, ItemDetail, promoteText } from "./ItemDetail";

vi.mock("@tauri-apps/api/core", () => import("../../test/tauriMock"));

const sessions: PlanSession[] = [];

afterEach(async () => {
  cleanup();
  clearToasts();
  vi.restoreAllMocks();
  await Promise.all(sessions.splice(0).map((s) => s.close()));
});

const UI: UiState = {
  plan: null,
  view: "timeline",
  zoom: "W",
  selected: null,
  collapsed: new Set(),
  baseline: null,
  dialog: null,
  reveal: null,
  follow: null,
  naming: null,
  settings: null,
  settingsRow: null,
  settingsRoot: false,
  syncPane: null,
  sidebarOpen: true,
  sidebarWidth: null,
  query: "",
  searchAsk: 0,
  columnsAsk: 0,
};

const SEED: readonly SeedItem[] = [
  { id: "a", name: "A", start: "2026-11-10", dur: 3 },
  { id: "b", name: "B", start: "2026-11-16", dur: 2, deps: [fs("a")] },
  { id: "c", name: "C", start: "2026-11-20", dur: 1 },
  { id: "u", name: "Undated", horizon: "next" },
  { id: "free", name: "Free gate", kind: "milestone", start: "2026-11-24" },
  {
    id: "tied",
    name: "Tied gate",
    kind: "milestone",
    start: "2026-11-25",
    deps: [fs("c")],
  },
  { id: "g", name: "Group", kind: "group" },
];

type Container = "column" | "drawer" | "modal" | "sheet";

const made = async (): Promise<TestSession> => {
  const t = await testSession(SEED);
  sessions.push(t.session);
  return t;
};

const show = (
  t: TestSession,
  item: ItemId,
  o: {
    container?: Container;
    order?: readonly ItemId[];
    onClose?: () => void;
    readOnly?: boolean;
    command?: boolean;
  } = {},
) => {
  const step = vi.fn<(by: 1 | -1) => void>();
  const press = vi.fn<DetailApi["press"]>();
  const onExpand = vi.fn<() => void>();
  const api: DetailApi = { press, step, promote: vi.fn(), rename: vi.fn(), order: o.order ?? ["a", "b", "c"] };
  const container = o.container ?? "column";
  const text = container === "modal" ? COLLAPSE_TEXT : promoteText(o.command ?? true);
  render(
    themed(
      <OpenChoice.Provider value={vi.fn()}>
        <UiContext.Provider value={{ ui: { ...UI, selected: item }, setUi: vi.fn() }}>
          <DetailContext.Provider value={api}>
            <ItemDetail
              session={t.session}
              item={item}
              container={container}
              local="Mac"
              command={o.command ?? true}
              readOnly={o.readOnly ?? false}
              naming={false}
              onNamed={() => undefined}
              onExpand={onExpand}
              expandLabel={text.label}
              expandTitle={text.title}
              {...(o.onClose === undefined ? {} : { onClose: o.onClose })}
            />
          </DetailContext.Provider>
        </UiContext.Provider>
      </OpenChoice.Provider>,
    ),
  );
  return { step, press, onExpand };
};

const root = (): HTMLElement => {
  const el = document.querySelector("[data-detail]");
  if (!(el instanceof HTMLElement)) throw new Error("no detail");
  return el;
};

const head = (): HTMLElement => {
  const el = root().querySelector(":scope > .detail-head");
  if (!(el instanceof HTMLElement)) throw new Error("no detail head");
  return el;
};

const pos = (): string | null => head().querySelector(".detail-pos")?.textContent ?? null;

const buttonOf = (cls: string): HTMLButtonElement => {
  const el = head().querySelector(`.${cls}`);
  if (!(el instanceof HTMLButtonElement)) throw new Error(`no ${cls}`);
  return el;
};

describe("ItemDetail's header", () => {
  it("heads the inspector column with kind, position, previous, next and a close X, over the item's body", async () => {
    const t = await made();
    const onClose = vi.fn();
    show(t, "b", { onClose });
    expect([root().className, root().dataset.detail, root().dataset.detailItem, root().tabIndex]).toEqual(["panel detail", "column", "b", -1]);
    expect([...head().children].map((c) => c.className)).toEqual(["kind", "detail-pos mono", "detail-prev", "detail-next", "detail-expand", "inspector-close"]);
    expect([head().querySelector(".kind")?.textContent, pos()]).toEqual(["TASK", "2 / 3"]);
    const prev = buttonOf("detail-prev");
    const next = buttonOf("detail-next");
    expect([prev.getAttribute("aria-label"), prev.title, prev.disabled, next.getAttribute("aria-label"), next.title, next.disabled]).toEqual([
      "Previous item",
      "Previous (↑ or K)",
      false,
      "Next item",
      "Next (↓ or J)",
      false,
    ]);
    expect(root().lastElementChild?.className).toBe("detail-body");
    expect(root().querySelectorAll(".detail-body .kind")).toHaveLength(0);
    fireEvent.click(within(head()).getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it.each<Container>(["drawer", "modal", "sheet"])("has no X of its own in the %s", async (container) => {
    const t = await made();
    show(t, "b", { container });
    expect([root().dataset.detail, [...head().children].map((c) => c.className)]).toEqual([container, ["kind", "detail-pos mono", "detail-prev", "detail-next", "detail-expand"]]);
  });

  it.each<readonly [Container, boolean, string, string]>([
    ["column", true, "Open as modal", "Open as modal (Space, ⌘↓)"],
    ["drawer", true, "Open as modal", "Open as modal (Space, ⌘↓)"],
    ["drawer", false, "Open as modal", "Open as modal (Space, Ctrl ↓)"],
    ["modal", true, "Back to the inspector", "Back to the inspector (Space)"],
  ])("labels the expand button in the %s (command keys %s) and runs it", async (container, command, label, title) => {
    const t = await made();
    const { onExpand } = show(t, "b", { container, command, onClose: () => undefined });
    const expand = buttonOf("detail-expand");
    expect([expand.getAttribute("aria-label"), expand.title]).toEqual([label, title]);
    fireEvent.click(expand);
    expect(onExpand).toHaveBeenCalledTimes(1);
  });

  it("labels the phone sheet's expand by its detent, pointing inward at full height", async () => {
    expect([detentText("medium"), detentText("large")]).toEqual([
      { label: EXPAND_FULL, title: EXPAND_FULL },
      { label: BACK_TO_MEDIUM, title: BACK_TO_MEDIUM },
    ]);
    expect([EXPAND_FULL, BACK_TO_MEDIUM]).toEqual(["Expand to full height", "Back to medium height"]);
    const t = await made();
    const glyph = (): string | null | undefined => buttonOf("detail-expand").querySelector("polyline")?.getAttribute("points");
    const drawn = (container: Container, label: string): string | null | undefined => {
      cleanup();
      render(
        themed(
          <OpenChoice.Provider value={vi.fn()}>
            <UiContext.Provider value={{ ui: { ...UI, selected: "b" }, setUi: vi.fn() }}>
              <DetailContext.Provider value={{ press: vi.fn(), step: vi.fn(), promote: vi.fn(), rename: vi.fn(), order: ["b"] }}>
                <ItemDetail
                  session={t.session}
                  item="b"
                  container={container}
                  local="Mac"
                  command
                  readOnly={false}
                  naming={false}
                  onNamed={() => undefined}
                  onExpand={() => undefined}
                  expandLabel={label}
                  expandTitle={label}
                />
              </DetailContext.Provider>
            </UiContext.Provider>
          </OpenChoice.Provider>,
        ),
      );
      expect(buttonOf("detail-expand").getAttribute("aria-label")).toBe(label);
      return glyph();
    };
    const outward = drawn("sheet", EXPAND_FULL);
    const inward = drawn("sheet", BACK_TO_MEDIUM);
    const modal = drawn("modal", COLLAPSE_TEXT.label);
    expect([outward === inward, inward === modal]).toEqual([false, true]);
  });

  it("disables previous on the first item and next on the last, and shows – outside the order", async () => {
    const t = await made();
    const read = (): [string | null, boolean, boolean] => [pos(), buttonOf("detail-prev").disabled, buttonOf("detail-next").disabled];
    show(t, "a", { container: "drawer" });
    expect(read()).toEqual(["1 / 3", true, false]);
    cleanup();
    show(t, "c", { container: "drawer" });
    expect(read()).toEqual(["3 / 3", false, true]);
    cleanup();
    show(t, "u", { container: "drawer" });
    expect(read()).toEqual(["– / 3", false, false]);
    cleanup();
    show(t, "u", { container: "drawer", order: [] });
    expect(read()).toEqual(["– / 0", true, true]);
  });

  it("steps back and forth from its previous and next buttons", async () => {
    const t = await made();
    const { step } = show(t, "b", { container: "drawer" });
    fireEvent.click(buttonOf("detail-next"));
    fireEvent.click(buttonOf("detail-prev"));
    expect(step.mock.calls).toEqual([[1], [-1]]);
  });

  it("names the kind of a milestone and a group", async () => {
    const t = await made();
    show(t, "free", { container: "drawer" });
    expect(head().querySelector(".kind")?.textContent).toBe("MILESTONE");
    cleanup();
    show(t, "g", { container: "drawer" });
    expect(head().querySelector(".kind")?.textContent).toBe("GROUP");
  });

  it("throws, naming the item, when the item is not in the plan, and when a column has no close", async () => {
    const t = await made();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(() => show(t, "nope", { container: "drawer" })).toThrow("ItemDetail: no item nope");
    cleanup();
    expect(() => show(t, "a", { container: "column" })).toThrow("ItemDetail: the column holding a needs a close");
  });

  it("useDetail throws without a provider", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    function Bare() {
      useDetail();
      return null;
    }
    expect(() => render(<Bare />)).toThrow("useDetail needs a DetailContext provider");
  });

  it("ItemModal throws, naming the item, when it is not in the plan", async () => {
    const t = await made();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const api: DetailApi = { press: vi.fn(), step: vi.fn(), promote: vi.fn(), rename: vi.fn(), order: [] };
    expect(() =>
      render(
        themed(
          <OpenChoice.Provider value={vi.fn()}>
            <UiContext.Provider value={{ ui: { ...UI, selected: "nope" }, setUi: vi.fn() }}>
              <DetailContext.Provider value={api}>
                <ItemModal
                  session={t.session}
                  item="nope"
                  local="Mac"
                  command
                  readOnly={false}
                  naming={false}
                  memo={null}
                  onNamed={() => undefined}
                  onRename={() => undefined}
                  onClose={() => undefined}
                />
              </DetailContext.Provider>
            </UiContext.Provider>
          </OpenChoice.Provider>,
        ),
      ),
    ).toThrow("ItemModal: no item nope");
  });
});

describe("ItemDetail's body", () => {
  const field = (name: string): HTMLElement => {
    const el = root().querySelector(`[data-detail-field="${name}"]`);
    if (!(el instanceof HTMLElement)) throw new Error(`no field ${name}`);
    return el;
  };

  it("marks each control of a dated task with its field", async () => {
    const t = await made();
    show(t, "b", { container: "drawer" });
    const fields = [...root().querySelectorAll("[data-detail-field]")].map((el) => (el instanceof HTMLElement ? [el.dataset.detailField, el.tagName.toLowerCase()] : []));
    expect(fields).toEqual([
      ["name", "input"],
      ["start", "input"],
      ["dur", "input"],
      ["end", "input"],
      ["status", "select"],
      ["assignees", "div"],
      ["progress", "input"],
      ["group", "select"],
      ["deps", "select"],
      ["note", "textarea"],
    ]);
  });

  it("offers Horizon on an undated task, writes it, and offers none on a dated task or a group", async () => {
    const t = await made();
    show(t, "u", { container: "drawer" });
    const horizon = field("horizon");
    if (!(horizon instanceof HTMLSelectElement)) throw new Error("Horizon is not a select");
    expect([screen.getByLabelText("Horizon"), horizon.value, [...horizon.options].map((o) => [o.value, o.textContent])]).toEqual([
      horizon,
      "next",
      [
        ["now", "Now"],
        ["next", "Next"],
        ["later", "Later"],
      ],
    ]);
    const apply = vi.spyOn(t.session, "apply");
    act(() => {
      fireEvent.change(horizon, { target: { value: "later" } });
    });
    expect(apply.mock.calls).toEqual([[{ t: "schedule", item: "u", set: { horizon: "later" } }]]);
    cleanup();
    show(t, "a", { container: "drawer" });
    expect(screen.queryByLabelText("Horizon")).toBeNull();
    cleanup();
    show(t, "g", { container: "drawer" });
    expect(screen.queryByLabelText("Horizon")).toBeNull();
  });

  it("shows Horizon as text read-only", async () => {
    const t = await made();
    show(t, "u", { container: "drawer", readOnly: true });
    expect([root().querySelector('[data-detail-field="horizon"]'), root().textContent]).toEqual([null, expect.stringContaining("HorizonNext")]);
  });

  it("lets a milestone without live predecessors take its status, and derives it with them", async () => {
    const t = await made();
    show(t, "free", { container: "drawer" });
    const status = field("status");
    if (!(status instanceof HTMLSelectElement)) throw new Error("Status is not a select");
    expect([status.value, [...status.options].map((o) => o.textContent)]).toEqual(["todo", ["Not started", "In progress", "Done"]]);
    const apply = vi.spyOn(t.session, "apply");
    act(() => {
      fireEvent.change(status, { target: { value: "done" } });
    });
    expect(apply.mock.calls).toEqual([[{ t: "schedule", item: "free", set: { status: "done" } }]]);
    cleanup();
    show(t, "tied", { container: "drawer" });
    expect(root().querySelector('[data-detail-field="status"]')).toBeNull();
    expect(root().textContent).toContain("open · from its predecessors");
  });

  it("lets a milestone take its status when its only predecessor link is part of a loop, as derive ignores it", async () => {
    const t = await testSession([
      { id: "lap", name: "Lap", start: "2026-11-10", dur: 2, deps: [fs("ring")] },
      { id: "ring", name: "Ring gate", kind: "milestone", start: "2026-11-20", status: "doing", deps: [fs("lap")] },
    ]);
    sessions.push(t.session);
    show(t, "ring", { container: "drawer" });
    const status = field("status");
    if (!(status instanceof HTMLSelectElement)) throw new Error("Status is not a select");
    expect([status.value, t.session.view().derived.status.get("ring")]).toEqual(["doing", "doing"]);
  });
});

describe("ItemDetail's body, from the phone's item sheet", () => {
  const REVIEW: SeedItem = { name: "Review", start: "2026-11-13", dur: 3 };
  const SHIP: SeedItem = { name: "Ship", start: "2026-11-18", dur: 1, deps: [fs("Review")] };

  function Live(p: { session: PlanSession; item: ItemId }) {
    const readOnly = useReadOnly(p.session);
    const text = detentText("medium");
    return (
      <ItemDetail
        session={p.session}
        item={p.item}
        container="sheet"
        local="Mac"
        command
        readOnly={readOnly}
        naming={false}
        onNamed={() => undefined}
        onExpand={() => undefined}
        expandLabel={text.label}
        expandTitle={text.title}
      />
    );
  }

  const live = async (seed: readonly SeedItem[], opts?: TestSessionOpts): Promise<TestSession> => {
    const t = await testSession(seed, opts);
    sessions.push(t.session);
    return t;
  };

  const shown = (t: TestSession, item: ItemId) => {
    const apply = vi.spyOn(t.session, "apply");
    const api: DetailApi = { press: vi.fn(), step: vi.fn(), promote: vi.fn(), rename: vi.fn(), order: [] };
    render(
      themed(
        <OpenChoice.Provider value={vi.fn()}>
          <UiContext.Provider value={{ ui: { ...UI, selected: item }, setUi: vi.fn() }}>
            <DetailContext.Provider value={api}>
              <Live session={t.session} item={item} />
            </DetailContext.Provider>
          </UiContext.Provider>
          <Toasts />
        </OpenChoice.Provider>,
      ),
    );
    return { apply };
  };

  const inDetail = () => within(root());
  const button = (name: string): HTMLElement => inDetail().getByRole("button", { name });
  const noButton = (name: string): HTMLElement | null => inDetail().queryByRole("button", { name });
  const intents = (apply: { mock: { calls: Intent[][] } }): Intent[] => apply.mock.calls.map((c) => c[0]);
  const toasts = (): (string | null)[] => Array.from(document.querySelectorAll<HTMLElement>(".toasts .toast")).map((e) => e.textContent);
  const toastPairs = (): (string | null)[][] => Array.from(document.querySelectorAll<HTMLElement>(".toasts .toast")).map((e) => [e.textContent, e.className]);
  const field = (label: string): HTMLInputElement => {
    const el = inDetail().getByLabelText(label);
    if (!(el instanceof HTMLInputElement)) throw new Error(label + " is not an input");
    return el;
  };
  const depRow = (from: string): HTMLElement => {
    const el = root().querySelector(`[data-dep="${from}"]`);
    if (!(el instanceof HTMLElement)) throw new Error("no dependency row from " + from);
    return el;
  };
  const lagField = (row: HTMLElement): HTMLInputElement => {
    const el = within(row).getByRole("spinbutton", { name: "Lag" });
    if (!(el instanceof HTMLInputElement)) throw new Error("no lag field");
    return el;
  };
  const typeSelect = (row: HTMLElement): HTMLSelectElement => {
    const el = within(row).getByRole("combobox", { name: "Dependency type" });
    if (!(el instanceof HTMLSelectElement)) throw new Error("no dependency type select");
    return el;
  };
  const typed = (el: HTMLInputElement, value: string, end: "Enter" | "Escape" | "blur"): void => {
    act(() => {
      el.focus();
      fireEvent.change(el, { target: { value } });
    });
    act(() => {
      if (end === "blur") el.blur();
      else fireEvent.keyDown(el, { key: end });
    });
  };

  it("asks for the number pad on the duration and leaves every lag field as it is", async () => {
    const t = await live([REVIEW, SHIP]);
    shown(t, "Ship");
    const mode = (el: Element): [string | null, string | null] => [el.getAttribute("type"), el.getAttribute("inputmode")];
    expect(mode(field("Duration"))).toEqual(["number", "numeric"]);
    expect(mode(lagField(depRow("Review")))).toEqual(["number", null]);
    expect(["enterkeyhint", "autocapitalize", "autocorrect", "spellcheck"].map((a) => field("Name").getAttribute(a))).toEqual(["done", "sentences", "off", "false"]);
  });

  it("types a duration and an end date as one resize each, and refuses an end on a day off", async () => {
    const t = await live([REVIEW]);
    const { apply } = shown(t, "Review");
    expect([field("Duration").value, field("End").value]).toEqual(["3", "2026-11-17"]);
    typed(field("Duration"), "5", "Enter");
    expect(intents(apply)).toEqual([{ t: "resize", item: "Review", dur: 5 }]);
    expect(field("End").value).toBe("2026-11-19");
    typed(field("End"), "2026-11-23", "Enter");
    expect(intents(apply)[1]).toEqual({ t: "resize", item: "Review", dur: 7 });
    expect(field("Duration").value).toBe("7");
    clearToasts();
    typed(field("End"), "2026-11-22", "Enter");
    expect(toasts()).toEqual(["22 Nov is not a working day. Pick a working day for the end."]);
    typed(field("End"), "2026-11-12", "blur");
    expect(toasts()).toEqual(["22 Nov is not a working day. Pick a working day for the end.", "The end cannot come before the start, 13 Nov."]);
    typed(field("Duration"), "9", "Escape");
    expect([field("Duration").value, field("End").value]).toEqual(["7", "2026-11-23"]);
    expect(apply).toHaveBeenCalledTimes(2);
  });

  it("toasts and writes nothing when the browser holds an end date it cannot read", async () => {
    const t = await live([REVIEW]);
    const { apply } = shown(t, "Review");
    Object.defineProperty(field("End"), "validity", { configurable: true, value: { badInput: true } });
    clearToasts();
    typed(field("End"), "", "Enter");
    expect([field("End").value, toasts()]).toEqual(["2026-11-17", ["The date is not complete. Enter a day, month and year."]]);
    expect(apply).not.toHaveBeenCalled();
  });

  it("types a dependency's lag through the link intent and refuses one that is not whole", async () => {
    const t = await live([REVIEW, SHIP]);
    const { apply } = shown(t, "Ship");
    typed(lagField(depRow("Review")), "-2", "Enter");
    expect(intents(apply)).toEqual([{ t: "link", from: "Review", to: "Ship", type: "FS", lag: -2 }]);
    clearToasts();
    typed(lagField(depRow("Review")), "1.5", "blur");
    expect(toasts()).toEqual(["Lag must be a whole number of working days."]);
    expect([lagField(depRow("Review")).value, apply.mock.calls.length]).toEqual(["-2", 1]);
  });

  it("shows no End field on an unscheduled task, and text in place of every field while read-only", async () => {
    const t = await live([REVIEW, { name: "Loose" }]);
    shown(t, "Loose");
    expect(root().querySelector('[data-detail-field="end"]')).toBeNull();
    cleanup();
    t.session.setReadOnly(true);
    shown(t, "Review");
    expect(root().querySelectorAll("input")).toHaveLength(0);
    expect(root().textContent).toContain("3 working days");
    expect(root().textContent).toContain("End17 Nov");
  });

  it("disables Longer at the longest task", async () => {
    const t = await live([{ name: "Long", start: "2026-11-16", dur: 3650 }]);
    shown(t, "Long");
    expect(button("Longer by one working day").hasAttribute("disabled")).toBe(true);
    expect(button("Shorter by one working day").hasAttribute("disabled")).toBe(false);
  });

  it("disables Shorter at one day and has no duration stepper on a milestone", async () => {
    const t = await live([{ name: "One", start: "2026-11-13", dur: 1 }, { name: "M", kind: "milestone", start: "2026-11-20", deps: [fs("One")] }]);
    shown(t, "One");
    expect(button("Shorter by one working day").hasAttribute("disabled")).toBe(true);
    cleanup();
    shown(t, "M");
    expect(noButton("Longer by one working day")).toBeNull();
    expect(noButton("Shorter by one working day")).toBeNull();
    expect(root().querySelector('[data-detail-field="status"]')).toBeNull();
    expect(root().textContent).toContain("open · from its predecessors");
  });

  it("edits a dependency's lag, type and existence", async () => {
    const t = await live([REVIEW, SHIP]);
    const { apply } = shown(t, "Ship");
    expect(lagField(depRow("Review")).value).toBe("0");
    fireEvent.change(typeSelect(depRow("Review")), { target: { value: "FS" } });
    expect(apply).toHaveBeenCalledTimes(0);
    fireEvent.click(within(depRow("Review")).getByRole("button", { name: "More lag" }));
    expect(intents(apply)).toEqual([{ t: "link", from: "Review", to: "Ship", type: "FS", lag: 1 }]);
    fireEvent.click(within(depRow("Review")).getByRole("button", { name: "Less lag" }));
    expect(intents(apply)[1]).toEqual({ t: "link", from: "Review", to: "Ship", type: "FS", lag: 0 });
    fireEvent.change(typeSelect(depRow("Review")), { target: { value: "SS" } });
    expect(intents(apply)[2]).toEqual({ t: "link", from: "Review", to: "Ship", type: "SS", lag: 0 });
    fireEvent.click(within(depRow("Review")).getByRole("button", { name: "Remove dependency" }));
    expect(intents(apply)[3]).toEqual({ t: "unlink", link: "Review>Ship" });
    expect(apply).toHaveBeenCalledTimes(4);
    expect(root().querySelector('[data-dep="Review"]')).toBeNull();
  });

  it("a refused dependency edit shows one bad toast and changes nothing", async () => {
    const t = await live([REVIEW, SHIP]);
    const { apply } = shown(t, "Ship");
    const message = "This link would close a loop: “Review” → “Ship” → “Review”.";
    apply.mockImplementationOnce(() => {
      throw new Refused(message);
    });
    const before = t.session.history().length;
    fireEvent.click(within(depRow("Review")).getByRole("button", { name: "More lag" }));
    expect(toastPairs()).toEqual([[message, "toast bad"]]);
    expect(t.session.history().length).toBe(before);
    expect(lagField(depRow("Review")).value).toBe("0");
  });

  it("throws for a live scheduled item with no derived start", async () => {
    const t = await live([REVIEW]);
    const v = t.session.view();
    const start = new Map(v.derived.start);
    start.delete("Review");
    vi.spyOn(t.session, "view").mockReturnValue({ ...v, derived: { ...v.derived, start } });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(() => shown(t, "Review")).toThrow(new Error("EndField: scheduled item Review has no derived start or end"));
  });

  it("binds the note to a textarea", async () => {
    const t = await live([REVIEW]);
    shown(t, "Review");
    const area = inDetail().getByRole("textbox", { name: "Notes" });
    if (!(area instanceof HTMLTextAreaElement)) throw new Error("the note is not a textarea");
    area.value = "Bring the build";
    fireEvent.input(area);
    expect(t.session.note("Review").toString()).toBe("Bring the build");
    act(() => {
      t.session.note("Review").insert(0, "> ");
    });
    expect(area.value).toBe("> Bring the build");
  });

  it("a group shows its progress and no schedule controls", async () => {
    const t = await live([
      { name: "QA", kind: "group" },
      { name: "T1", parent: "QA", start: "2026-11-09", dur: 2, progress: 40 },
      { name: "T2", parent: "QA", start: "2026-11-09", dur: 3, status: "done", progress: 100 },
      { name: "E", kind: "group" },
    ]);
    shown(t, "QA");
    expect(inDetail().getByText("Progress 76 %")).toBeTruthy();
    ["Longer by one working day", "Shorter by one working day"].forEach((n) => expect([n, noButton(n)]).toEqual([n, null]));
    expect(root().querySelector('[data-detail-field="status"]')).toBeNull();
    expect(root().querySelector('[data-detail-field="deps"]')).toBeNull();
    expect(root().querySelector('input[type="range"]')).toBeNull();
    cleanup();
    shown(t, "E");
    expect(inDetail().queryByText(/Progress/)).toBeNull();
  });

  it("drops every writing control while read-only and brings them back", async () => {
    const t = await live([REVIEW, SHIP, { name: "Notes", start: "2026-11-09", dur: 1 }]);
    const { apply } = shown(t, "Ship");
    act(() => t.session.setReadOnly(true));
    ["Longer by one working day", "Shorter by one working day", "More lag", "Less lag", "Remove dependency", "Move up", "Move down", "Unschedule", "Delete"].forEach((n) =>
      expect([n, noButton(n)]).toEqual([n, null]),
    );
    expect(root().querySelector('[data-detail-field="status"]')).toBeNull();
    expect(within(depRow("Review")).queryByRole("combobox", { name: "Dependency type" })).toBeNull();
    expect(within(depRow("Review")).getByText("FS")).toBeTruthy();
    expect(within(depRow("Review")).getByText("0d")).toBeTruthy();
    expect(inDetail().getByText("Not started")).toBeTruthy();
    const area = inDetail().getByRole("textbox", { name: "Notes" });
    expect(area instanceof HTMLTextAreaElement && area.readOnly).toBe(true);
    expect(apply).toHaveBeenCalledTimes(0);
    act(() => t.session.setReadOnly(false));
    expect(button("Longer by one working day")).toBeTruthy();
  });

  it("read-only on a newer plan", async () => {
    const t = await live([REVIEW, SHIP], { raw: { x1: ["iphone", "s1", 0, [], 42, []] } });
    expect(t.session.readOnlyReason).toBe(NEWER_PLAN);
    const { apply } = shown(t, "Ship");
    ["Longer by one working day", "Shorter by one working day", "More lag", "Less lag", "Remove dependency", "Unschedule", "Delete"].forEach((n) => expect([n, noButton(n)]).toEqual([n, null]));
    expect(root().querySelector('[data-detail-field="status"]')).toBeNull();
    expect(inDetail().queryByRole("combobox", { name: "Dependency type" })).toBeNull();
    expect(root().querySelectorAll("input")).toHaveLength(0);
    const area = inDetail().getByRole("textbox", { name: "Notes" });
    expect(area instanceof HTMLTextAreaElement && area.readOnly).toBe(true);
    expect(apply).toHaveBeenCalledTimes(0);
  });

  it("edits report through useRun", async () => {
    const t = await live([REVIEW, SHIP]);
    const { apply } = shown(t, "Review");
    fireEvent.click(button("Longer by one working day"));
    const result = apply.mock.results[0];
    if (result === undefined || result.type !== "return") throw new Error("apply did not return");
    const built: Built = result.value;
    expect(built.preview.movedLater).toBe(1);
    expect(toasts()).toEqual([built.toast]);
  });

  it("fix actions always show", async () => {
    const t = await live([REVIEW, { name: "Sat", start: "2026-11-14", dur: 1 }, { name: "Ship", start: "2026-11-16", dur: 1, deps: [fs("Review")] }]);
    const sat = shown(t, "Sat");
    expect(inDetail().getByText("Starts on a day off — shown from Mon 16 Nov")).toBeTruthy();
    fireEvent.click(button("Snap to next working day"));
    expect(intents(sat.apply)).toEqual([{ t: "snap", item: "Sat" }]);
    cleanup();
    const ship = shown(t, "Ship");
    fireEvent.click(button("Push “Ship” to Wed 18 Nov"));
    const [intent] = intents(ship.apply);
    expect(intent?.t === "fix" && intent.how === "push" && intent.conflict.kind === "early" && intent.conflict.succ === "Ship").toBe(true);
    cleanup();
    shown(t, "Review");
    expect(root().querySelector(".conflicts")).toBeNull();
  });

  it("fix actions read-only", async () => {
    const t = await live([REVIEW, { name: "Sat", start: "2026-11-14", dur: 1 }, { name: "Ship", start: "2026-11-16", dur: 1, deps: [fs("Review")] }]);
    const sat = shown(t, "Sat");
    act(() => t.session.setReadOnly(true));
    expect(noButton("Snap to next working day")).toBeNull();
    act(() => t.session.setReadOnly(false));
    expect(button("Snap to next working day")).toBeTruthy();
    cleanup();
    const ship = shown(t, "Ship");
    act(() => t.session.setReadOnly(true));
    expect(noButton("Push “Ship” to Wed 18 Nov")).toBeNull();
    act(() => t.session.setReadOnly(false));
    expect(button("Push “Ship” to Wed 18 Nov")).toBeTruthy();
    expect([sat.apply.mock.calls.length, ship.apply.mock.calls.length]).toEqual([0, 0]);
  });

  describe("editing", () => {
    const EDIT_SEED: readonly SeedItem[] = [
      { id: "S4", name: "Sprint 4", kind: "group" },
      { name: "QA", kind: "group", parent: "S4" },
      { name: "Test", parent: "QA", start: "2026-11-10", dur: 1 },
      { name: "Review", parent: "S4", start: "2026-11-10", dur: 2 },
      { name: "Notes", horizon: "now" },
    ];
    const EMPTY_NAME = "The name is empty. Type at least one character.";
    const nameField = (): HTMLInputElement => {
      const el = inDetail().getByRole("textbox", { name: "Name" });
      if (!(el instanceof HTMLInputElement)) throw new Error("no name input");
      return el;
    };
    const select = (name: string): HTMLSelectElement => {
      const el = inDetail().getByRole("combobox", { name });
      if (!(el instanceof HTMLSelectElement)) throw new Error("no select " + name);
      return el;
    };
    const newest = (t: TestSession): string | undefined => t.session.history()[0]?.label;

    it("renames on Enter or blur, refuses an empty name and fires only on a change", async () => {
      const t = await live(EDIT_SEED);
      const { apply } = shown(t, "Review");
      const name = nameField();
      expect(name.value).toBe("Review");
      act(() => name.focus());
      fireEvent.blur(name);
      fireEvent.change(name, { target: { value: "Review " } });
      fireEvent.keyDown(name, { key: "Enter" });
      expect(apply).toHaveBeenCalledTimes(0);
      expect(toasts()).toEqual([]);
      const before = t.session.history().length;
      fireEvent.change(nameField(), { target: { value: "   " } });
      fireEvent.keyDown(nameField(), { key: "Enter" });
      expect(t.session.history().length).toBe(before);
      expect(toastPairs()).toEqual([[EMPTY_NAME, "toast bad"]]);
      expect(nameField().value).toBe("Review");
      clearToasts();
      apply.mockClear();
      fireEvent.change(nameField(), { target: { value: "Review 2" } });
      fireEvent.keyDown(nameField(), { key: "Enter" });
      expect(intents(apply)).toEqual([{ t: "rename", item: "Review", name: "Review 2" }]);
      expect(newest(t)).toBe("Renamed “Review” to “Review 2”");
      fireEvent.change(nameField(), { target: { value: "Review 3" } });
      fireEvent.blur(nameField());
      expect(intents(apply)[1]).toEqual({ t: "rename", item: "Review", name: "Review 3" });
      expect(apply).toHaveBeenCalledTimes(2);
    });

    it("offers groupOptions' labels in the Group picker and places into a group or the top level", async () => {
      const t = await live(EDIT_SEED);
      shown(t, "S4");
      expect([...select("Group").options].map((o) => o.textContent)).toEqual(["Top level"]);
      cleanup();
      const { apply } = shown(t, "Review");
      const group = select("Group");
      expect([...group.options].map((o) => o.textContent)).toEqual(["Top level", "Sprint 4", "Sprint 4 › QA"]);
      expect(group.selectedOptions[0]?.textContent).toBe("Sprint 4");
      fireEvent.change(group, { target: { value: "S4" } });
      expect(apply).toHaveBeenCalledTimes(0);
      fireEvent.change(select("Group"), { target: { value: "QA" } });
      expect(intents(apply)).toEqual([{ t: "place", item: "Review", parent: "QA", after: "Test" }]);
      expect(newest(t)).toBe("Moved “Review” into “QA”");
      fireEvent.change(select("Group"), { target: { value: "" } });
      expect(intents(apply)[1]).toEqual({ t: "place", item: "Review", parent: null, after: "Notes" });
      expect(newest(t)).toBe("Moved “Review” to the top level");
      expect(apply).toHaveBeenCalledTimes(2);
    });

    it("does not offer a trashed group", async () => {
      const t = await live(EDIT_SEED);
      act(() => {
        t.session.apply({ t: "trash", items: ["QA"] });
      });
      shown(t, "Review");
      expect([...select("Group").options].map((o) => o.textContent)).toEqual(["Top level", "Sprint 4"]);
    });

    it("unschedules a scheduled task, and shows no Unschedule on an unscheduled item or a group", async () => {
      const t = await live(EDIT_SEED);
      const { apply } = shown(t, "Review");
      fireEvent.click(button("Unschedule"));
      expect(intents(apply)).toEqual([{ t: "schedule", item: "Review", set: { start: null } }]);
      expect(newest(t)).toBe("Unscheduled “Review”");
      cleanup();
      shown(t, "Notes");
      expect(noButton("Unschedule")).toBeNull();
      cleanup();
      shown(t, "S4");
      expect(noButton("Unschedule")).toBeNull();
    });

    it("shows a refused Unschedule's message", async () => {
      const t = await live(EDIT_SEED);
      const { apply } = shown(t, "Review");
      apply.mockImplementationOnce(() => {
        throw new Refused("Refused for the test.");
      });
      fireEvent.click(button("Unschedule"));
      expect(toasts()).toEqual(["Refused for the test."]);
    });

    it("moves an undated item between Now, Next and Later, and shows no Horizon on a dated item or a group", async () => {
      const t = await live(EDIT_SEED);
      const { apply } = shown(t, "Notes");
      const horizon = select("Horizon");
      expect([...horizon.options].map((o) => o.textContent)).toEqual(["Now", "Next", "Later"]);
      expect(horizon.selectedOptions[0]?.textContent).toBe("Now");
      fireEvent.change(horizon, { target: { value: "now" } });
      expect(apply).toHaveBeenCalledTimes(0);
      fireEvent.change(select("Horizon"), { target: { value: "next" } });
      expect(intents(apply)).toEqual([{ t: "schedule", item: "Notes", set: { horizon: "next" } }]);
      expect(newest(t)).toBe("Moved “Notes” to Next");
      expect(toasts()).toEqual(["Moved “Notes” to Next."]);
      cleanup();
      shown(t, "Review");
      expect(inDetail().queryByRole("combobox", { name: "Horizon" })).toBeNull();
      cleanup();
      shown(t, "S4");
      expect(inDetail().queryByRole("combobox", { name: "Horizon" })).toBeNull();
    });

    it("Delete moves the item to the Trash", async () => {
      const t = await live(EDIT_SEED);
      const { apply } = shown(t, "Review");
      fireEvent.click(button("Delete"));
      expect(intents(apply)).toEqual([{ t: "trash", items: ["Review"] }]);
      expect(toasts()).toEqual(["Moved “Review” to the Trash. Undo brings it back."]);
    });

    it("reorders among siblings with Move up and Move down", async () => {
      const t = await live(EDIT_SEED);
      const notes = shown(t, "Notes");
      fireEvent.click(button("Move up"));
      expect(intents(notes.apply)).toEqual([{ t: "place", item: "Notes", parent: null, after: null }]);
      expect(newest(t)).toBe("Reordered “Notes”");
      expect(notes.apply).toHaveBeenCalledTimes(1);
      cleanup();
      const t2 = await live(EDIT_SEED);
      const qa = shown(t2, "QA");
      expect(button("Move up").hasAttribute("disabled")).toBe(true);
      fireEvent.click(button("Move down"));
      expect(intents(qa.apply)).toEqual([{ t: "place", item: "QA", parent: "S4", after: "Review" }]);
      expect(qa.apply).toHaveBeenCalledTimes(1);
      cleanup();
      shown(t2, "S4");
      expect(button("Move up").hasAttribute("disabled")).toBe(true);
      cleanup();
      const t3 = await live(EDIT_SEED);
      shown(t3, "Review");
      expect(button("Move down").hasAttribute("disabled")).toBe(true);
      cleanup();
      shown(t3, "Notes");
      expect(button("Move down").hasAttribute("disabled")).toBe(true);
    });
  });
});
