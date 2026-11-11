import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fixedClock } from "../../services/clock";
import { Registry } from "../../store/registry";
import { SyncManager } from "../../sync/manager";
import { fakeFactory } from "../../test/fakeProvider";
import { setScreen } from "../../test/setup";
import { seededStore } from "../../test/shell";
import * as Y from "yjs";
import { encodeAction } from "../../store/doc";
import { act as stamp } from "../../test/act";
import { argsOf, fail, headsOf, ip, IX, ixAct, NOW, own, remoteUpdate, seedIndex, seedPlan, seedSpace, syncWorld, TODAY, type SyncWorld } from "../../test/syncWorld";
import { tauri, type Answer } from "../../test/tauriMock";
import { withSync } from "../../test/withSync";
import { clearToasts } from "../common/Toast";
import { PhoneShell } from "../phone/PhoneShell";
import { PurgeConfirm } from "./PurgeConfirm";
import { Shell } from "./Shell";

vi.mock("@tauri-apps/api/core", () => import("../../test/tauriMock"));

const UNKNOWN = "The server does not know this plan yet. Let it sync, then delete it again.";
const PENDING = "The plan is deleted, but the server has not erased its history yet. It tries again every minute.";
const REVOKED = "This device was removed from the space.";
const CAP = "This device has joined 500 plans, the most one device may join. Delete a plan forever from the Trash to free a place.";

const registries: Registry[] = [];

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(async () => {
  cleanup();
  clearToasts();
  vi.restoreAllMocks();
  await Promise.all(registries.splice(0).map((r) => r.close()));
  window.localStorage.clear();
  setScreen(1440, 900);
});

const deep = async (): Promise<void> => {
  await act(async () => {
    for (let i = 0; i < 12; i += 1) await new Promise<void>((r) => setTimeout(r, 0));
  });
};

const toastTexts = (): (string | null)[] => Array.from(document.querySelectorAll<HTMLElement>(".toasts .toast")).map((e) => e.textContent);

const badToasts = (): (string | null)[] => Array.from(document.querySelectorAll<HTMLElement>(".toasts .toast.bad")).map((e) => e.textContent);

const purges = (): unknown[] => tauri.calls.filter((c) => c.cmd === "sync_purge_plan" || c.cmd === "store_delete").map((c) => [c.cmd, argsOf(c).doc]);

type Form = "wide" | "phone";

const plansRoot = (form: Form): HTMLElement => {
  if (form === "wide") return screen.getByRole("navigation", { name: "Plans" });
  const sheet = screen.queryByRole("dialog", { name: "Plans" });
  if (sheet !== null) return sheet;
  const head = document.querySelector(".phone-head");
  if (!(head instanceof HTMLElement)) throw new Error("no phone top bar");
  fireEvent.click(within(head).getByRole("button", { name: "Plans" }));
  return screen.getByRole("dialog", { name: "Plans" });
};

const trashOf = (form: Form): HTMLElement => within(plansRoot(form)).getByRole("region", { name: "Trash" });

const deleteForever = async (form: Form, name: string): Promise<HTMLElement> => {
  const row = within(trashOf(form)).getByText(name).closest("li");
  if (!(row instanceof HTMLElement)) throw new Error("no Trash row " + name);
  act(() => {
    fireEvent.click(within(row).getByRole("button", { name: "Delete forever" }));
  });
  await deep();
  return screen.getByRole("dialog", { name: `Delete “${name}” forever?` });
};

const confirmIn = (d: HTMLElement): HTMLElement => {
  const buttons = within(d).getAllByRole("button", { name: "Delete forever" });
  const last = buttons[buttons.length - 1];
  if (last === undefined) throw new Error("no Delete forever button in the dialog");
  return last;
};

async function localMounted(form: Form, failDelete = false): Promise<{ r: Registry; ids: string[] }> {
  if (form === "phone") setScreen(390, 844);
  const s = await seededStore(["Alpha", "Beta"], { trash: [0] });
  if (failDelete) s.mem.fail("store_delete", s.ids[0], { code: "store.io", message: "Could not remove /docs/A: Permission denied." });
  const clock = fixedClock("2026-11-09");
  const r = await Registry.open({ clock });
  registries.push(r);
  render(withSync(form === "wide" ? <Shell registry={r} clock={clock} /> : <PhoneShell registry={r} clock={clock} />));
  await deep();
  return { r, ids: s.ids };
}

async function spaceMounted(form: Form, answers: Record<string, Answer> = {}): Promise<{ r: Registry; w: SyncWorld }> {
  if (form === "phone") setScreen(390, 844);
  const w = syncWorld({ names: { P: "Launch", L: "Alpha", P2: "Pod" }, platform: form === "phone" ? "ios" : "macos", answers });
  seedSpace(w, { trashedP2: true });
  const clock = fixedClock(TODAY, NOW);
  const r = await Registry.open({ clock });
  registries.push(r);
  const el = withSync(form === "wide" ? <Shell registry={r} clock={clock} /> : <PhoneShell registry={r} clock={clock} />, { factory: fakeFactory() });
  tauri.answers.sync_status = () => w.status();
  render(el);
  await deep();
  return { r, w };
}

describe("Delete forever on another device while the plan is open", () => {
  it("lets go of the open plan and opens the next one", async () => {
    const { r } = await spaceMounted("wide");
    act(() => {
      fireEvent.click(within(screen.getByRole("navigation", { name: "Plans" })).getByRole("button", { name: /Launch/ }));
    });
    await deep();
    expect(screen.getByRole("navigation", { name: "Plans" }).querySelector('[aria-current="page"]')?.textContent).toContain("Launch");
    const ix = (await r.doc(IX)).ydoc;
    act(() => {
      Y.applyUpdate(ix, remoteUpdate(ix, "r-g", encodeAction(stamp("r-g", headsOf(ix), [own("ip:P", { gone: true })], { dev: "dev-B", lbl: "Delete plan forever" }))));
    });
    await deep();
    const current = screen.getByRole("navigation", { name: "Plans" }).querySelector('[aria-current="page"]')?.textContent ?? "";
    expect(current).not.toContain("Launch");
    expect(r.openSessions().map((s) => s.view().plan.id)).not.toContain("P");
    expect(badToasts()).toEqual(["“Launch” was deleted forever on another device. It is erased from this device too, including changes that had not synced."]);
  });
});

describe("Delete forever on another device while the plan is open on the phone", () => {
  it("lets go of the open plan", async () => {
    const { r } = await spaceMounted("phone");
    const plans = plansRoot("phone");
    act(() => {
      fireEvent.click(within(plans).getByRole("button", { name: /Launch/ }));
    });
    await deep();
    expect(r.openSessions().map((s) => s.view().plan.id)).toContain("P");
    expect(document.querySelector(".phone-plan-name")?.textContent).toBe("Launch");
    const ix = (await r.doc(IX)).ydoc;
    act(() => {
      Y.applyUpdate(ix, remoteUpdate(ix, "r-g", encodeAction(stamp("r-g", headsOf(ix), [own("ip:P", { gone: true })], { dev: "dev-B", lbl: "Delete plan forever" }))));
    });
    await deep();
    expect(r.openSessions().map((s) => s.view().plan.id)).not.toContain("P");
    expect(document.querySelector(".phone-plan-name")?.textContent).not.toBe("Launch");
    expect(badToasts()).toEqual(["“Launch” was deleted forever on another device. It is erased from this device too, including changes that had not synced."]);
  });
});

describe("Delete forever of a moved plan whose space is not attached", () => {
  it("says to connect to the space and offers no delete", async () => {
    const w = syncWorld({ names: { P: "Launch" } });
    seedIndex(w.mem, "local", [
      ixAct("l-n", [], [own("dn:dev-A", "Mac")], "dev-A", "Name device"),
      ixAct("l-P", ["l-n"], [ip("P", false)]),
      ixAct("l-Pt", ["l-P"], [ip("P", true)], "dev-A", "Move plan to Trash"),
    ]);
    seedIndex(w.mem, IX, [ixAct("s-P", [], [ip("P", true)])]);
    seedPlan(w.mem, "P", "Launch");
    const r = await Registry.open({ clock: fixedClock(TODAY, NOW) });
    registries.push(r);
    await deep();
    const purgePlan = vi.spyOn(r, "purgePlan");
    render(withSync(<PurgeConfirm registry={r} id="P" onClose={() => undefined} />));
    const d = screen.getByRole("dialog", { name: "Delete “Launch” forever?" });
    expect(d.textContent).toContain("Connect to the space to delete this plan forever.");
    expect(d.textContent).not.toContain("is erased from this device");
    expect(within(d).queryByRole("button", { name: "Delete forever" })).toBeNull();
    expect(purgePlan).not.toHaveBeenCalled();
  });
});

describe.each<Form>(["wide", "phone"])("Delete forever (%s)", (form) => {
  it("files that cannot be removed close the dialog with that one error and no success toast", async () => {
    await localMounted(form, true);
    const d = await deleteForever(form, "Alpha");
    act(() => {
      fireEvent.click(confirmIn(d));
    });
    await deep();
    expect(toastTexts()).toEqual([
      "“Alpha” was deleted forever, but its files on this device could not be removed: Could not remove /docs/A: Permission denied. Restart WebBoard to try again.",
    ]);
    expect(badToasts()).toHaveLength(1);
    expect(screen.queryByRole("dialog", { name: "Delete “Alpha” forever?" })).toBeNull();
  });

  it("names the plan, says it cannot be undone, and Cancel deletes nothing", async () => {
    const { r } = await localMounted(form);
    const purgePlan = vi.spyOn(r, "purgePlan");
    const d = await deleteForever(form, "Alpha");
    expect(d.textContent).toContain("“Alpha” is erased from this device. This cannot be undone.");
    act(() => {
      fireEvent.click(within(d).getByRole("button", { name: "Cancel" }));
    });
    await deep();
    expect(screen.queryByRole("dialog", { name: "Delete “Alpha” forever?" })).toBeNull();
    expect(purgePlan).not.toHaveBeenCalled();
    expect(purges()).toEqual([]);
    expect(within(trashOf(form)).getByText("Alpha")).toBeTruthy();
  });

  it("confirming erases a local plan and says so", async () => {
    const { r, ids } = await localMounted(form);
    const purgePlan = vi.spyOn(r, "purgePlan");
    const d = await deleteForever(form, "Alpha");
    act(() => {
      fireEvent.click(confirmIn(d));
    });
    await deep();
    expect(purgePlan.mock.calls).toEqual([[ids[0], false]]);
    expect(purges()).toEqual([["store_delete", ids[0]]]);
    expect(screen.queryByRole("dialog", { name: "Delete “Alpha” forever?" })).toBeNull();
    expect(toastTexts()).toEqual(["Deleted “Alpha” forever."]);
    expect(within(plansRoot(form)).queryByRole("region", { name: "Trash" })).toBeNull();
    expect(r.plans().map((p) => p.name)).toEqual(["Beta"]);
  });

  it("a space plan's dialog says the server and every device lose it, and confirming purges it there", async () => {
    const { r } = await spaceMounted(form);
    const d = await deleteForever(form, "Pod");
    expect(d.textContent).toContain("“Pod” and its whole history are erased from the server and from every device in the space. This cannot be undone.");
    act(() => {
      fireEvent.click(confirmIn(d));
    });
    await deep();
    expect(purges()).toEqual([
      ["sync_purge_plan", "P2"],
      ["store_delete", "P2"],
    ]);
    expect(toastTexts()).toEqual(["Deleted “Pod” forever."]);
    expect(r.plans().map((p) => p.id)).not.toContain("P2");
  });

  it("a space purge connects again the plans the server's plan cap stopped", async () => {
    const retry = vi.spyOn(SyncManager.prototype, "retryCapped");
    await spaceMounted(form);
    const d = await deleteForever(form, "Pod");
    act(() => {
      fireEvent.click(confirmIn(d));
    });
    await deep();
    expect(toastTexts()).toEqual(["Deleted “Pod” forever."]);
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("a plan the plan cap kept off the server is deleted forever here when the server does not know it", async () => {
    const { r, w } = await spaceMounted(form, {
      sync_purge_plan: fail({ code: "sync.unknown_plan", message: UNKNOWN }),
      sync_ticket: (args) => {
        if (argsOf({ args }).doc === "P2") throw { code: "sync.too_many_plans", message: CAP };
        return w.ticket("x");
      },
    });
    const purgePlan = vi.spyOn(r, "purgePlan");
    const d = await deleteForever(form, "Pod");
    act(() => {
      fireEvent.click(confirmIn(d));
    });
    await deep();
    expect(purgePlan.mock.calls).toEqual([["P2", true]]);
    expect(purges()).toEqual([
      ["sync_purge_plan", "P2"],
      ["store_delete", "P2"],
    ]);
    expect(toastTexts()).toEqual(["Deleted “Pod” forever."]);
    expect(r.plans().map((p) => p.id)).not.toContain("P2");
  });

  it("a purge refused because this device was removed tells sync, which turns the space read-only", async () => {
    await spaceMounted(form, { sync_purge_plan: fail({ code: "sync.revoked", message: REVOKED }) });
    const d = await deleteForever(form, "Pod");
    act(() => {
      fireEvent.click(confirmIn(d));
    });
    await deep();
    expect(badToasts()).toEqual([REVOKED]);
    expect(tauri.calls.filter((c) => c.cmd === "sync_mark_revoked")).toHaveLength(1);
  });

  it("a purge the server does not know yet shows its message, keeps the dialog and leaves the plan in the Trash", async () => {
    const { r } = await spaceMounted(form, { sync_purge_plan: fail({ code: "sync.unknown_plan", message: UNKNOWN }) });
    const d = await deleteForever(form, "Pod");
    act(() => {
      fireEvent.click(confirmIn(d));
    });
    await deep();
    expect(badToasts()).toEqual([UNKNOWN]);
    expect(screen.getByRole("dialog", { name: "Delete “Pod” forever?" })).toBeTruthy();
    expect(purges()).toEqual([["sync_purge_plan", "P2"]]);
    expect(r.plans().find((p) => p.id === "P2")).toMatchObject({ trashed: true });
  });

  it("a purge on another device is told here once, as an error that stays when the copy held unsynced changes", async () => {
    const { r } = await spaceMounted(form);
    const ix = (await r.doc(IX)).ydoc;
    act(() => {
      Y.applyUpdate(ix, remoteUpdate(ix, "r-g", encodeAction(stamp("r-g", headsOf(ix), [own("ip:P2", { gone: true })], { dev: "dev-B", lbl: "Delete plan forever" }))));
    });
    await deep();
    expect(badToasts()).toEqual(["“Pod” was deleted forever on another device. It is erased from this device too, including changes that had not synced."]);
    expect(r.plans().map((p) => p.id)).not.toContain("P2");
    act(() => {
      Y.applyUpdate(ix, remoteUpdate(ix, "r-n", encodeAction(stamp("r-n", headsOf(ix), [own("dn:dev-C", "iPad")], { dev: "dev-C", lbl: "Name device" }))));
    });
    await deep();
    expect(badToasts()).toHaveLength(1);
  });

  it("a purge still pending on the server closes the dialog with its message", async () => {
    await spaceMounted(form, { sync_purge_plan: fail({ code: "sync.purge_pending", message: PENDING }) });
    const d = await deleteForever(form, "Pod");
    act(() => {
      fireEvent.click(confirmIn(d));
    });
    await deep();
    expect(badToasts()).toEqual([PENDING]);
    expect(screen.queryByRole("dialog", { name: "Delete “Pod” forever?" })).toBeNull();
  });
});
