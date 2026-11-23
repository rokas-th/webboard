import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useCallback, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readPlatform } from "../../platform";
import { fixedClock } from "../../services/clock";
import { Registry } from "../../store/registry";
import type { PlanSession } from "../../store/session";
import { IPAD, IPHONE, MAC, setPlatform, stubVisualViewport } from "../../test/platform";
import { MESA_SEED, testSession } from "../../test/session";
import { commandsSince, emitFromRust, hold, offeredSettings, resetTauri, tauri } from "../../test/tauriMock";
import { rowContext, type RowContext } from "../list/columns";
import { ListBar } from "../list/ListBar";
import { listModel } from "../list/model";
import { DEFAULT_LIST_PREFS, type ListPrefs } from "../list/prefs";
import { MoreMenu } from "../shell/MoreMenu";
import { PlanMenu } from "../shell/PlanMenu";
import { NewItemMenu } from "./NewItemMenu";
import { clearToasts, Toasts } from "./Toast";

vi.mock("@tauri-apps/api/core", () => import("../../test/tauriMock"));
vi.mock("@tauri-apps/api/event", () => import("../../test/tauriMock"));

const flows = vi.hoisted(() => ({ exported: [] as unknown[], imported: [] as unknown[] }));
vi.mock("../shell/fileFlows", () => ({
  exportFlow: (session: unknown) => {
    flows.exported.push(session);
    return Promise.resolve();
  },
  importFlow: (registry: unknown) => {
    flows.imported.push(registry);
    return Promise.resolve();
  },
}));

let unstub = (): void => undefined;

const held: { sessions: PlanSession[]; registries: Registry[] } = { sessions: [], registries: [] };

async function planned(): Promise<{ session: PlanSession; registry: Registry }> {
  const { session } = await testSession(MESA_SEED);
  held.sessions.push(session);
  Object.assign(tauri.answers, { settings_read: offeredSettings, settings_write: () => null, device_info: () => ({ deviceId: "mac", platform: readPlatform(window).os }) });
  const registry = await Registry.open({ clock: fixedClock("2026-11-09") });
  held.registries.push(registry);
  return { session, registry };
}

beforeEach(() => {
  window.localStorage.clear();
  resetTauri({});
  setPlatform(IPAD);
  unstub = stubVisualViewport();
  flows.exported.length = 0;
  flows.imported.length = 0;
});

afterEach(async () => {
  unstub();
  cleanup();
  clearToasts();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await Promise.all(held.sessions.splice(0).map((s) => s.close()));
  await Promise.all(held.registries.splice(0).map((r) => r.close()));
  window.localStorage.clear();
});

const settle = async (): Promise<void> => {
  await act(async () => {
    await new Promise<void>((r) => setTimeout(r, 0));
    await new Promise<void>((r) => setTimeout(r, 0));
  });
};

interface Sent {
  token: string;
  anchor: { x: number; y: number; width: number; height: number };
  sections: { title: string | null; rows: { id: string; title: string; checked: boolean }[] }[];
}

const asks = (): Sent[] => tauri.calls.filter((c) => c.cmd === "menu_show").map((c) => (c.args as { menu: Sent }).menu);

const lastAsk = (): Sent => {
  const all = asks();
  const last = all[all.length - 1];
  if (last === undefined) throw new Error("no menu_show was sent");
  return last;
};

const dismissed = (): unknown[] => tauri.calls.filter((c) => c.cmd === "menu_dismiss").map((c) => c.args);

const rowsOf = (sent: Sent): [string | null, [string, string, boolean][]][] => sent.sections.map((s) => [s.title, s.rows.map((r) => [r.id, r.title, r.checked])]);

const button = (name: string): HTMLElement => screen.getByRole("button", { name });

const choose = (id: string): void => {
  const { token } = lastAsk();
  act(() => {
    emitFromRust("menu-ended", { token });
    emitFromRust("menu-chosen", { token, id });
  });
};

const zoomProps = () => ({
  zoom: "M" as const,
  onZoom: vi.fn(),
  onToday: vi.fn(),
  onSettings: vi.fn(),
  onPlan: vi.fn(),
  onSearch: vi.fn(),
  onFocusDropped: vi.fn(),
});

describe("the + menu on iOS", () => {
  it.each([IPHONE, IPAD])("sends the three new-item rows at its button and renders no HTML list (%o)", async (platform) => {
    setPlatform(platform);
    const picked: string[] = [];
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(300, 6, 44, 36));
    render(<NewItemMenu label="+" className="button-primary" disabled={false} onPick={(k) => picked.push(k)} />);
    expect(button("+").getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(button("+"));
    await settle();
    expect(document.querySelector(".plan-menu-list")).toBeNull();
    expect(button("+").getAttribute("aria-expanded")).toBe("true");
    expect(lastAsk().anchor).toEqual({ x: 300, y: 6, width: 44, height: 36 });
    expect(rowsOf(lastAsk())).toEqual([
      [
        null,
        [
          ["task", "New task", false],
          ["milestone", "New milestone", false],
          ["group", "New group", false],
        ],
      ],
    ]);
    choose("milestone");
    expect(picked).toEqual(["milestone"]);
    expect(button("+").getAttribute("aria-expanded")).toBe("false");
  });

  it("runs the pick when the choice arrives before the end, and stays open until the end", async () => {
    setPlatform(IPHONE);
    const picked: string[] = [];
    render(<NewItemMenu label="+" className="button-primary" disabled={false} onPick={(k) => picked.push(k)} />);
    fireEvent.click(button("+"));
    await settle();
    const { token } = lastAsk();
    act(() => emitFromRust("menu-chosen", { token, id: "group" }));
    expect(picked).toEqual(["group"]);
    expect(button("+").getAttribute("aria-expanded")).toBe("true");
    act(() => emitFromRust("menu-ended", { token }));
    expect(button("+").getAttribute("aria-expanded")).toBe("false");
    expect(picked).toEqual(["group"]);
  });

  it("runs the pick with the latest props", async () => {
    const first: string[] = [];
    const second: string[] = [];
    const { rerender } = render(<NewItemMenu label="+ New" className="button-primary" disabled={false} onPick={(k) => first.push(k)} />);
    fireEvent.click(button("+ New"));
    await settle();
    rerender(<NewItemMenu label="+ New" className="button-primary" disabled={false} onPick={(k) => second.push(k)} />);
    choose("task");
    expect([first, second]).toEqual([[], ["task"]]);
  });

  it("dismisses its menu on unmount and drops a later choice", async () => {
    const picked: string[] = [];
    const { unmount } = render(<NewItemMenu label="+ New" className="button-primary" disabled={false} onPick={(k) => picked.push(k)} />);
    fireEvent.click(button("+ New"));
    await settle();
    const { token } = lastAsk();
    unmount();
    await settle();
    expect(dismissed()).toEqual([{ token }]);
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    act(() => emitFromRust("menu-chosen", { token, id: "task" }));
    act(() => emitFromRust("menu-ended", { token }));
    expect(picked).toEqual([]);
    expect(info.mock.calls).toEqual([["NewItemMenu: dropped the native choice task, the menu was withdrawn"]]);
  });

  it("dismisses a menu still being shown once it is shown, when the host unmounts first", async () => {
    const shown = hold("menu_show");
    const { unmount } = render(<NewItemMenu label="+ New" className="button-primary" disabled={false} onPick={() => undefined} />);
    fireEvent.click(button("+ New"));
    await settle();
    unmount();
    expect(dismissed()).toEqual([]);
    shown.resolve(null);
    await settle();
    expect(dismissed()).toEqual([{ token: lastAsk().token }]);
  });

  it("shows a refused menu_show as a bad toast, closes, and never opens the HTML list", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    tauri.answers.menu_show = () => {
      throw { code: "menu.not_shown", message: "The menu cannot be shown: UIKit did not display it within 5000 ms." };
    };
    render(
      <>
        <NewItemMenu label="+ New" className="button-primary" disabled={false} onPick={() => undefined} />
        <Toasts />
      </>,
    );
    fireEvent.click(button("+ New"));
    await settle();
    expect(button("+ New").getAttribute("aria-expanded")).toBe("false");
    expect(document.querySelector(".plan-menu-list")).toBeNull();
    expect(screen.getByText("The menu cannot be shown: UIKit did not display it within 5000 ms.")).toBeTruthy();
    expect(screen.getByText("The menu cannot be shown: UIKit did not display it within 5000 ms.").closest(".toast.bad")).not.toBeNull();
  });

  it("shows a menu_show refused after Rust withdrew the shown menu as a bad toast, not as a replaced menu", async () => {
    setPlatform(IPHONE);
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const copied = vi.fn((_: string) => Promise.resolve());
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText: copied } });
    tauri.answers.menu_show = () => {
      emitFromRust("menu-ended", { token: lastAsk().token });
      throw { code: "menu.not_shown", message: "The menu cannot be shown: UIKit did not display it within 5000 ms." };
    };
    render(
      <>
        <NewItemMenu label="+" className="button-primary" disabled={false} onPick={() => undefined} />
        <Toasts />
      </>,
    );
    fireEvent.click(button("+"));
    await settle();
    expect(button("+").getAttribute("aria-expanded")).toBe("false");
    expect(info).not.toHaveBeenCalled();
    expect(errors).toHaveBeenCalledTimes(1);
    expect(screen.getByText("The menu cannot be shown: UIKit did not display it within 5000 ms.").closest(".toast.bad")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Copy details" }));
    await settle();
    expect(copied.mock.calls.map((c) => c[0].split("\n")[0])).toEqual(["menu.not_shown"]);
  });

  it("dismisses its menu when it becomes disabled, and drops a later choice", async () => {
    const picked: string[] = [];
    const { rerender } = render(<NewItemMenu label="+ New" className="button-primary" disabled={false} onPick={(k) => picked.push(k)} />);
    fireEvent.click(button("+ New"));
    await settle();
    const { token } = lastAsk();
    rerender(<NewItemMenu label="+ New" className="button-primary" disabled onPick={(k) => picked.push(k)} />);
    await settle();
    expect(dismissed()).toEqual([{ token }]);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    choose("task");
    expect(picked).toEqual([]);
  });

  it("shows no error when a second tap replaces a menu UIKit had not displayed yet", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const first = hold("menu_show");
    render(
      <>
        <NewItemMenu label="+ New" className="button-primary" disabled={false} onPick={() => undefined} />
        <Toasts />
      </>,
    );
    fireEvent.click(button("+ New"));
    await settle();
    fireEvent.click(button("+ New"));
    await settle();
    first.reject({ code: "menu.not_shown", message: "The menu cannot be shown: it was closed or replaced before UIKit displayed it." });
    await settle();
    expect(asks()).toHaveLength(2);
    expect(document.querySelector(".toast")).toBeNull();
    expect(errors).not.toHaveBeenCalled();
    expect(info.mock.calls.map((c) => c[0])).toEqual(["NewItemMenu: a menu replaced by a newer one was not shown"]);
    expect(button("+ New").getAttribute("aria-expanded")).toBe("true");
    choose("task");
    expect(button("+ New").getAttribute("aria-expanded")).toBe("false");
  });
});

describe("a row id the host does not know", () => {
  it.each([
    ["+ New", "epic", 'NewItemMenu: the native menu chose "epic", which is no item kind', async () => <NewItemMenu label="+ New" className="button-primary" disabled={false} onPick={() => undefined} />],
    ["More", "zoom-Y", 'MoreMenu: the native menu chose "zoom-Y", which is no row of the More menu', async () => <MoreMenu {...zoomProps()} />],
    ["Plan menu", "print", 'PlanMenu: the native menu chose "print", which is no row of the Plan menu', async () => <PlanMenu {...(await planned())} open onOpenChange={() => undefined} onOpen={() => undefined} />],
  ] as const)("is a bad toast from the %s menu, never a silent no-op", async (name, id, message, host) => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const shown = await host();
    render(
      <>
        {shown}
        <Toasts />
      </>,
    );
    fireEvent.click(button(name));
    await settle();
    const { token } = lastAsk();
    act(() => {
      emitFromRust("menu-ended", { token });
      emitFromRust("menu-chosen", { token, id });
    });
    expect(screen.getByText(message).closest(".toast.bad")).not.toBeNull();
    expect(errors).toHaveBeenCalledTimes(1);
  });
});

describe("the More menu on iOS", () => {
  it("sends Search… first, then the Zoom section with the current zoom checked, then Go to today, Settings and Plan", async () => {
    render(<MoreMenu {...zoomProps()} />);
    fireEvent.click(button("More"));
    await settle();
    expect(document.querySelector(".plan-menu-list")).toBeNull();
    expect(rowsOf(lastAsk())).toEqual([
      [null, [["search", "Search…", false]]],
      [
        "Zoom",
        [
          ["zoom-W", "Week", false],
          ["zoom-M", "Month", true],
          ["zoom-Q", "Quarter", false],
          ["zoom-F", "Fit", false],
        ],
      ],
      [
        null,
        [
          ["today", "Go to today", false],
          ["settings", "Settings", false],
          ["plan", "Plan", false],
        ],
      ],
    ]);
  });

  it("sends Settings alone when there is no zoom, today, plan or search", async () => {
    render(<MoreMenu {...zoomProps()} zoom={null} onToday={null} onPlan={null} onSearch={null} />);
    fireEvent.click(button("More"));
    await settle();
    expect(rowsOf(lastAsk())).toEqual([[null, [["settings", "Settings", false]]]]);
  });

  it.each([
    ["zoom-Q", "onZoom", ["Q"]],
    ["today", "onToday", []],
    ["settings", "onSettings", []],
    ["plan", "onPlan", []],
    ["search", "onSearch", []],
  ] as const)("runs %s through %s", async (id, handler, args) => {
    const p = zoomProps();
    render(<MoreMenu {...p} />);
    fireEvent.click(button("More"));
    await settle();
    choose(id);
    expect(p[handler].mock.calls).toEqual([args]);
    expect(button("More").getAttribute("aria-expanded")).toBe("false");
  });

  it("dismisses its menu when the row set changes, and drops its choice", async () => {
    const p = zoomProps();
    const { rerender } = render(<MoreMenu {...p} />);
    fireEvent.click(button("More"));
    await settle();
    const { token } = lastAsk();
    rerender(<MoreMenu {...p} zoom={null} />);
    await settle();
    expect(dismissed()).toEqual([{ token }]);
    choose("zoom-W");
    expect(p.onZoom).not.toHaveBeenCalled();
    expect(button("More").getAttribute("aria-expanded")).toBe("false");
  });

  it("drops Go to today chosen after its callback went away, since the row set change withdrew the menu", async () => {
    const p = zoomProps();
    const { rerender } = render(<MoreMenu {...p} />);
    fireEvent.click(button("More"));
    await settle();
    rerender(<MoreMenu {...p} onToday={null} />);
    await settle();
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    choose("today");
    expect(p.onToday).not.toHaveBeenCalled();
    expect(info.mock.calls).toEqual([["MoreMenu: dropped the native choice today, the menu was withdrawn"]]);
    expect(errors).not.toHaveBeenCalled();
  });

  it("refuses to render off iOS, where the toolbar never folds into More", () => {
    setPlatform(MAC);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(() => render(<MoreMenu {...zoomProps()} />)).toThrow("MoreMenu: rendered on macos, but only the iPad toolbar folds into More");
  });
});

describe("the plan head menu on iOS", () => {
  let made: { session: PlanSession; registry: Registry } | null = null;

  beforeEach(async () => {
    made = await planned();
  });

  const props = (): { session: PlanSession; registry: Registry } => {
    if (made === null) throw new Error("the plan head menu test has no session or registry");
    return made;
  };

  it("sends Export plan… and Import plan…, reports open and closed, and runs the chosen flow", async () => {
    const { session, registry } = props();
    const opened: boolean[] = [];
    const Host = () => {
      const [open, setOpen] = useState(false);
      const report = useCallback((o: boolean) => {
        opened.push(o);
        setOpen(o);
      }, []);
      return <PlanMenu session={session} registry={registry} open={open} onOpenChange={report} onOpen={() => undefined} />;
    };
    render(<Host />);
    fireEvent.click(button("Plan menu"));
    await settle();
    expect(document.querySelector(".plan-menu-list")).toBeNull();
    expect(button("Plan menu").getAttribute("aria-expanded")).toBe("true");
    expect(rowsOf(lastAsk())).toEqual([
      [
        null,
        [
          ["export", "Export plan…", false],
          ["import", "Import plan…", false],
        ],
      ],
    ]);
    choose("export");
    expect(flows.exported).toEqual([session]);
    expect(opened).toEqual([true, false]);
    fireEvent.click(button("Plan menu"));
    await settle();
    choose("import");
    expect(flows.imported).toEqual([registry]);
  });

  const Controlled = ({ opened, open }: { opened: boolean[]; open?: boolean }) => {
    const [own, setOwn] = useState(false);
    const report = useCallback(
      (o: boolean) => {
        opened.push(o);
        setOwn(o);
      },
      [opened],
    );
    return <PlanMenu {...props()} open={open ?? own} onOpenChange={report} onOpen={() => undefined} />;
  };

  it("dismisses its native menu when the parent closes it", async () => {
    const opened: boolean[] = [];
    const { rerender } = render(<Controlled opened={opened} />);
    fireEvent.click(button("Plan menu"));
    await settle();
    const { token } = lastAsk();
    expect(dismissed()).toEqual([]);
    rerender(<Controlled opened={opened} open={false} />);
    await settle();
    expect(dismissed()).toEqual([{ token }]);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    choose("export");
    expect(flows.exported).toEqual([]);
    expect(opened).toEqual([true, false]);
  });

  it("reports closed when menu_show is refused", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    tauri.answers.menu_show = () => {
      throw { code: "menu.not_shown", message: "The menu cannot be shown: UIKit did not display it within 5000 ms." };
    };
    const opened: boolean[] = [];
    render(<Controlled opened={opened} />);
    fireEvent.click(button("Plan menu"));
    await settle();
    expect(opened).toEqual([true, false]);
    expect(button("Plan menu").getAttribute("aria-expanded")).toBe("false");
  });

  it("reports closed again when the menu cannot even be asked for, and lets the error through", async () => {
    unstub();
    const opened: boolean[] = [];
    const reported: unknown[] = [];
    const onError = (e: ErrorEvent): void => {
      reported.push(e.error);
      e.preventDefault();
    };
    window.addEventListener("error", onError);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    render(<Controlled opened={opened} />);
    try {
      fireEvent.click(button("Plan menu"));
    } catch (e) {
      reported.push(e);
    } finally {
      window.removeEventListener("error", onError);
    }
    await settle();
    expect(reported.map((e) => (e instanceof Error ? e.message : String(e)))).toEqual(["PlanMenu: the window has no visual viewport to place the menu in"]);
    expect(opened).toEqual([true, false]);
    expect(asks()).toEqual([]);
  });
});

describe("the List's Filter and Group by on iOS", () => {
  const listBar = async (prefs: ListPrefs): Promise<{ ctx: RowContext; picked: ListPrefs[] }> => {
    const { session } = await planned();
    const ctx = rowContext(session.view(), (id) => session.note(id).toString());
    const picked: ListPrefs[] = [];
    render(<ListBar ctx={ctx} prefs={prefs} model={listModel(ctx, prefs, null)} searching={false} onPrefs={(next) => picked.push(next)} />);
    return { ctx, picked };
  };

  const listButton = (which: string): HTMLElement => {
    const el = document.querySelector(`[data-list="${which}"]`);
    if (!(el instanceof HTMLElement)) throw new Error(`no ${which} button`);
    return el;
  };

  it("sends Filter as the Step, Assignee, Kind and Group sections of checkable rows, a set chip ticked, and adds the chosen chip", async () => {
    const prefs: ListPrefs = { ...DEFAULT_LIST_PREFS, chips: [{ f: "kind", v: "task" }] };
    const { ctx, picked } = await listBar(prefs);
    fireEvent.click(listButton("filter"));
    await settle();
    expect(document.querySelector('[role="menu"]')).toBeNull();
    const sent = rowsOf(lastAsk());
    expect(sent.map(([title]) => title)).toEqual(["Step", "Assignee", "Kind", "Group"]);
    expect(sent[0][1]).toEqual([...ctx.board.steps.map((s): [string, string, boolean] => [`step:${s.id}`, s.name, false]), ["step:", "No step", false]]);
    expect(sent[1][1][sent[1][1].length - 1]).toEqual(["assignee:", "Unassigned", false]);
    expect(sent[2][1]).toEqual([
      ["kind:task", "Task", true],
      ["kind:milestone", "Milestone", false],
    ]);
    expect(sent[3][1][sent[3][1].length - 1]).toEqual(["group:", "Not in a group", false]);
    choose("kind:milestone");
    await settle();
    expect(picked.map((p) => p.chips)).toEqual([
      [
        { f: "kind", v: "task" },
        { f: "kind", v: "milestone" },
      ],
    ]);
  });

  it("sends Group by as one section of four checkable rows, the current grouping ticked, and applies the chosen one", async () => {
    const { picked } = await listBar(DEFAULT_LIST_PREFS);
    fireEvent.click(listButton("group"));
    await settle();
    expect(rowsOf(lastAsk())).toEqual([
      [
        "Group by",
        [
          ["outline", "Plan outline", true],
          ["step", "Step", false],
          ["assignee", "Assignee", false],
          ["none", "None", false],
        ],
      ],
    ]);
    choose("step");
    await settle();
    expect(picked.map((p) => p.group)).toEqual(["step"]);
  });
});

describe("the HTML menus on macOS", () => {
  beforeEach(() => setPlatform(MAC));

  it("opens the + list and never asks for a native menu", () => {
    const picked: string[] = [];
    render(<NewItemMenu label="+ New" className="button-primary" disabled={false} onPick={(k) => picked.push(k)} />);
    fireEvent.click(button("+ New"));
    fireEvent.click(screen.getByRole("menuitem", { name: "New group" }));
    expect(picked).toEqual(["group"]);
    expect(tauri.calls.map((c) => c.cmd)).toEqual([]);
  });

  it("lists Export, Import and Print in the plan head list", async () => {
    const { session: plan, registry: plans } = await planned();
    const from = tauri.calls.length;
    let open = false;
    const { rerender } = render(<PlanMenu session={plan} registry={plans} open={open} onOpenChange={(o) => (open = o)} onOpen={() => undefined} onPrint={() => undefined} />);
    fireEvent.click(button("Plan menu"));
    rerender(<PlanMenu session={plan} registry={plans} open={open} onOpenChange={(o) => (open = o)} onOpen={() => undefined} onPrint={() => undefined} />);
    expect(screen.getAllByRole("menuitem").map((b) => b.textContent)).toEqual(["Export plan…", "Import plan…", "Print…"]);
    expect(commandsSince(from)).toEqual([]);
  });
});
