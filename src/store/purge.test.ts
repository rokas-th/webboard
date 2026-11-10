import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { Refused } from "../actions/intents";
import type { ActionId, DeviceId, Write } from "../log/types";
import { fixedClock } from "../services/clock";
import { AppError } from "../services/ipc";
import { act } from "../test/act";
import { argsOf, fail, headsOf, IX, ixAct, NOW, own, ip, remoteUpdate, seedIndex, seedPlan, SP, syncWorld, TODAY, type SyncWorld } from "../test/syncWorld";
import { hold, tauri, type Answer, type Call } from "../test/tauriMock";
import { decodeAction, encodeAction } from "./doc";
import { IndexDoc } from "./index-doc";
import { openPersisted } from "./persist";
import { PlanGone, Registry } from "./registry";

vi.mock("@tauri-apps/api/core", () => import("../test/tauriMock"));

const READ_ONLY = "This device was removed from the space; its plans are read-only.";
const NOT_TRASHED = "Move the plan to the Trash first.";
const UNKNOWN = "The server does not know this plan yet. Let it sync, then delete it again.";
const PENDING = "The plan is deleted, but the server has not erased its history yet. It tries again every minute.";
const PURGE_LABEL = "Delete plan forever";
const GONE_LABEL = "Follow a deletion on another device";
const CONNECT = "Connect to the space to delete this plan forever.";
const UNREAD_SPACE = "The plan list of a space on this device could not be read, so WebBoard cannot tell whether this plan belongs to it.";

const gone = (plan: string): Write => own("ip:" + plan, { gone: true });

const opened: Registry[] = [];

async function open(followWaitMs = 0): Promise<Registry> {
  const r = await Registry.open({ clock: fixedClock(TODAY, NOW), followWaitMs });
  opened.push(r);
  return r;
}

afterEach(async () => {
  await Promise.all(opened.splice(0).map((r) => r.close()));
});

const flush = async (): Promise<void> => {
  for (let i = 0; i < 6; i += 1) await new Promise<void>((r) => setTimeout(r, 0));
};

const docsOf = (from: number, cmd: string): unknown[] =>
  tauri.calls
    .slice(from)
    .filter((c) => c.cmd === cmd)
    .map((c) => argsOf(c).doc);

const xdoc = (c: Call): string | null => new Headers(c.options?.headers).get("x-doc");

const writesTo = (from: number, doc: string): Write[] =>
  tauri.calls
    .slice(from)
    .filter((c) => c.cmd === "store_append" && xdoc(c) === doc)
    .flatMap((c) => {
      if (!(c.args instanceof Uint8Array)) throw new Error("store_append carried no bytes");
      return Y.decodeUpdate(c.args).structs.flatMap((s) =>
        s instanceof Y.Item && typeof s.parentSub === "string" ? [...decodeAction(s.parentSub, s.content.getContent()[0]).w] : [],
      );
    });

const labelsTo = (from: number, doc: string): string[] =>
  tauri.calls
    .slice(from)
    .filter((c) => c.cmd === "store_append" && xdoc(c) === doc)
    .flatMap((c) => {
      if (!(c.args instanceof Uint8Array)) throw new Error("store_append carried no bytes");
      return Y.decodeUpdate(c.args).structs.flatMap((s) =>
        s instanceof Y.Item && typeof s.parentSub === "string" ? [decodeAction(s.parentSub, s.content.getContent()[0]).lbl] : [],
      );
    });

const namesOf = (w: SyncWorld): unknown => {
  const s = w.settings.value;
  if (typeof s !== "object" || s === null || !("names" in s)) throw new Error("settings hold no names");
  return s.names;
};

async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error("expected a rejection");
}

function purgeWorld(o: { trashed?: boolean; moved?: boolean; localGone?: boolean; synced?: boolean; followed?: boolean; answers?: Record<string, Answer> } = {}): SyncWorld {
  const w = syncWorld({ names: { P: "Launch", L: "Alpha" }, answers: o.answers });
  seedIndex(w.mem, "local", [
    ixAct("l-n", [], [own("dn:dev-A", "Mac")], "dev-A", "Name device"),
    ixAct("l-L", ["l-n"], [ip("L", false)]),
    ixAct("l-Lt", ["l-L"], [ip("L", true)], "dev-A", "Move plan to Trash"),
    ...(o.localGone === true ? [ixAct("l-Lg", ["l-Lt"], [gone("L")], "dev-A", PURGE_LABEL)] : []),
    ...(o.moved === true ? [ixAct("l-P", ["l-n"], [ip("P", false)]), ixAct("l-Pt", ["l-P"], [ip("P", true)], "dev-A", "Move plan to Trash")] : []),
  ]);
  seedIndex(w.mem, IX, [
    ixAct("s-n", [], [own("dn:dev-A", "Mac")], "dev-A", "Name device"),
    ixAct("s-b", ["s-n"], [own("dn:dev-B", "iPhone")], "dev-B", "Name device"),
    ixAct("s-P", ["s-b"], [ip("P", false)]),
    ...(o.trashed === true ? [ixAct("s-Pt", ["s-P"], [ip("P", true)], "dev-A", "Move plan to Trash")] : []),
    ...(o.followed === true ? [ixAct("s-Pg", ["s-P"], [gone("P")], "dev-A", GONE_LABEL)] : []),
  ]);
  const p = seedPlan(w.mem, "P", "Launch", { items: ["A"] });
  seedPlan(w.mem, "L", "Alpha");
  const s = w.settings.value;
  if (o.synced === true && typeof s === "object" && s !== null) w.settings.value = { ...s, syncedHeads: { P: headsOf(p) } };
  return w;
}

async function spaceOpen(w: SyncWorld, followWaitMs = 0): Promise<Registry> {
  const r = await open(followWaitMs);
  await r.attachSpace(SP);
  await flush();
  expect(w.mem.docs.has("P")).toBe(true);
  return r;
}

async function remoteGone(r: Registry, plan: string, dev: DeviceId = "dev-B", id: ActionId = "r-g", lbl = PURGE_LABEL): Promise<void> {
  const ix = (await r.doc(IX)).ydoc;
  Y.applyUpdate(ix, remoteUpdate(ix, id, encodeAction(act(id, headsOf(ix), [gone(plan)], { dev, lbl }))));
  await flush();
}

async function remoteName(r: Registry, id: ActionId): Promise<void> {
  const ix = (await r.doc(IX)).ydoc;
  Y.applyUpdate(ix, remoteUpdate(ix, id, encodeAction(act(id, headsOf(ix), [own("dn:dev-C", "iPad")], { dev: "dev-C", lbl: "Name device" }))));
  await flush();
}

describe("IndexDoc: delete forever", () => {
  it("a purge absorbs a concurrent restore from another log, and the first writer is kept", async () => {
    const w = syncWorld();
    const common = [ixAct("c1", [], [ip("P", false)]), ixAct("c2", ["c1"], [ip("P", true)], "dev-A", "Move plan to Trash")] as const;
    w.mem.seed("ix-B", Y.encodeStateAsUpdate(seedIndex(w.mem, "local", common)));
    const ydocs = new Map<string, Y.Doc>();
    const persist = async (id: string) => {
      const d = await openPersisted(id);
      ydocs.set(id, d.ydoc);
      return d;
    };
    const a = await IndexDoc.open("local", "dev-A", persist);
    const b = await IndexDoc.open("ix-B", "dev-B", persist);
    a.purgePlan("P");
    b.restorePlan("P");
    b.trashPlan("P");
    b.restorePlan("P");
    const ya = ydocs.get("local");
    const yb = ydocs.get("ix-B");
    if (ya === undefined || yb === undefined) throw new Error("docs not opened");
    const toB = Y.encodeStateAsUpdate(ya, Y.encodeStateVector(yb));
    const toA = Y.encodeStateAsUpdate(yb, Y.encodeStateVector(ya));
    Y.applyUpdate(yb, toB);
    Y.applyUpdate(ya, toA);
    expect(a.plans()).toEqual([]);
    expect(b.plans()).toEqual([]);
    expect([...a.gone()]).toEqual([["P", "dev-A"]]);
    expect([...b.gone()]).toEqual([["P", "dev-A"]]);
    expect(a.unreadable()).toEqual([]);
    b.purgePlan("P");
    expect([...b.gone()]).toEqual([["P", "dev-A"]]);
    await a.close();
    await b.close();
  });

  it("writes the tombstone once under its own label, and a purge of a gone plan writes nothing", async () => {
    const w = syncWorld();
    seedIndex(w.mem, "local", [ixAct("c1", [], [ip("P", false)])]);
    const ix = await IndexDoc.open("local", "dev-A", openPersisted);
    const from = tauri.calls.length;
    ix.purgePlan("P");
    ix.purgePlan("P");
    await flush();
    expect(writesTo(from, "local")).toEqual([gone("P")]);
    const sent = tauri.calls.slice(from).filter((c) => c.cmd === "store_append");
    if (!(sent[0].args instanceof Uint8Array)) throw new Error("no bytes");
    const labels = Y.decodeUpdate(sent[0].args).structs.flatMap((s) =>
      s instanceof Y.Item && typeof s.parentSub === "string" ? [decodeAction(s.parentSub, s.content.getContent()[0]).lbl] : [],
    );
    expect(labels).toEqual([PURGE_LABEL]);
    expect(() => ix.purgePlan("Q")).toThrow("Plan Q is not listed in local");
    await ix.close();
  });

  it("names the device that deleted the plan, never one that only followed the deletion", async () => {
    const w = syncWorld();
    seedIndex(w.mem, "local", [
      ixAct("c1", [], [ip("P", false)]),
      ixAct("c2", ["c1"], [gone("P")], "dev-A", GONE_LABEL),
      ixAct("c3", ["c1"], [ip("Q", false)]),
      ixAct("c4", ["c3"], [gone("Q")], "dev-C", GONE_LABEL),
      ixAct("c5", ["c3"], [gone("Q")], "dev-B", PURGE_LABEL),
    ]);
    const ix = await IndexDoc.open("local", "dev-A", openPersisted);
    expect(ix.plans()).toEqual([]);
    expect([...ix.gone()]).toEqual([
      ["P", null],
      ["Q", "dev-B"],
    ]);
    const from = tauri.calls.length;
    ix.markGone("P");
    ix.markGone("Q");
    ix.purgePlan("Q");
    await flush();
    expect(writesTo(from, "local")).toEqual([]);
    ix.purgePlan("P");
    await flush();
    expect(writesTo(from, "local")).toEqual([gone("P")]);
    expect(labelsTo(from, "local")).toEqual([PURGE_LABEL]);
    expect(ix.gone().get("P")).toBe("dev-A");
    await ix.close();
  });

  it("a gone plan cannot be added, trashed or restored again", async () => {
    const w = syncWorld();
    seedIndex(w.mem, "local", [ixAct("c1", [], [ip("P", false)]), ixAct("c2", ["c1"], [gone("P")], "dev-B", PURGE_LABEL)]);
    const ix = await IndexDoc.open("local", "dev-A", openPersisted);
    expect(ix.plans()).toEqual([]);
    expect(ix.lists("P")).toBe(true);
    expect(ix.lists("Q")).toBe(false);
    expect(() => ix.addPlan("P")).toThrow("Plan P was deleted forever");
    expect(() => ix.trashPlan("P")).toThrow("Plan P was deleted forever");
    expect(() => ix.restorePlan("P")).toThrow("Plan P was deleted forever");
    await ix.close();
  });

  it("reads { gone: false } and a tombstone with other keys as malformed", async () => {
    const w = syncWorld();
    seedIndex(w.mem, "local", [
      ixAct("c1", [], [ip("P", false)]),
      ixAct("c2", ["c1"], [own("dn:dev-B", "iPhone")], "dev-B", "Name device"),
      ixAct("c3", ["c2"], [own("ip:P", { gone: false })], "dev-B", PURGE_LABEL),
      ixAct("c4", ["c2"], [own("ip:P", { gone: true, t: true })], "dev-B", PURGE_LABEL),
    ]);
    const ix = await IndexDoc.open("local", "dev-A", openPersisted);
    expect(ix.plans()).toEqual([{ id: "P", trashed: false }]);
    expect(ix.gone().size).toBe(0);
    expect(ix.unreadable().map((u) => u.message)).toEqual([
      "A change to the plan list from iPhone could not be read: Malformed value for “ip:P”. Update WebBoard on this device.",
      "A change to the plan list from iPhone could not be read: Malformed value for “ip:P”. Update WebBoard on this device.",
    ]);
    await ix.close();
  });
  it("reads a tombstone or a listing for a plan list or the store probe as malformed", async () => {
    const w = syncWorld();
    seedIndex(w.mem, "local", [
      ixAct("c1", [], [ip("P", false)]),
      ixAct("c2", ["c1"], [own("dn:dev-B", "iPhone")], "dev-B", "Name device"),
      ixAct("c3", ["c2"], [gone("local")], "dev-B", PURGE_LABEL),
      ixAct("c4", ["c2"], [gone("ix-x")], "dev-B", PURGE_LABEL),
      ixAct("c5", ["c2"], [gone("probe")], "dev-B", PURGE_LABEL),
      ixAct("c6", ["c2"], [ip("ix-x", false)], "dev-B", "Add plan"),
    ]);
    const ix = await IndexDoc.open("local", "dev-A", openPersisted);
    expect(ix.plans()).toEqual([{ id: "P", trashed: false }]);
    expect(ix.gone().size).toBe(0);
    expect(ix.unreadable().map((u) => u.message)).toEqual([
      "A change to the plan list from iPhone could not be read: Unknown unit key “ip:local”. Update WebBoard on this device.",
      "A change to the plan list from iPhone could not be read: Unknown unit key “ip:ix-x”. Update WebBoard on this device.",
      "A change to the plan list from iPhone could not be read: Unknown unit key “ip:probe”. Update WebBoard on this device.",
      "A change to the plan list from iPhone could not be read: Unknown unit key “ip:ix-x”. Update WebBoard on this device.",
    ]);
    expect(() => ix.markGone("local")).toThrow("Plan local is not listed in local");
    await ix.close();
  });
});

describe("Registry: delete forever", () => {
  it("a space purge asks the server, then writes the tombstone, erases the files and forgets the name, with no notice", async () => {
    const w = purgeWorld({ trashed: true });
    const r = await spaceOpen(w);
    await r.doc("P");
    const from = tauri.calls.length;
    await r.purgePlan("P");
    await flush();
    const cmds = tauri.calls.slice(from).map((c) => c.cmd);
    expect(cmds.indexOf("sync_purge_plan")).toBeLessThan(cmds.indexOf("store_delete"));
    expect(docsOf(from, "sync_purge_plan")).toEqual(["P"]);
    expect(docsOf(from, "store_delete")).toEqual(["P"]);
    expect(writesTo(from, IX)).toEqual([gone("P")]);
    expect(writesTo(from, "local")).toEqual([]);
    expect(w.mem.docs.has("P")).toBe(false);
    expect(r.plans().map((p) => p.id)).toEqual(["L"]);
    expect(r.isGone("P")).toBe(true);
    expect(namesOf(w)).toEqual({ L: "Alpha" });
    expect(r.takeGoneNotices()).toEqual([]);
  });

  it("a refused server purge changes nothing here and rethrows with the server's message", async () => {
    const w = purgeWorld({ trashed: true, answers: { sync_purge_plan: fail({ code: "sync.unknown_plan", message: UNKNOWN }) } });
    const r = await spaceOpen(w);
    const from = tauri.calls.length;
    const e = await rejection(r.purgePlan("P"));
    await flush();
    expect(e).toBeInstanceOf(AppError);
    expect(e).toMatchObject({ code: "sync.unknown_plan", message: UNKNOWN });
    expect(docsOf(from, "store_delete")).toEqual([]);
    expect(writesTo(from, IX)).toEqual([]);
    expect(r.plans().find((p) => p.id === "P")).toMatchObject({ trashed: true, space: SP });
    expect(r.isGone("P")).toBe(false);
  });

  it("a purge the server has recorded but not erased yet still erases here, then rethrows", async () => {
    const w = purgeWorld({ trashed: true, answers: { sync_purge_plan: fail({ code: "sync.purge_pending", message: PENDING }) } });
    const r = await spaceOpen(w);
    const from = tauri.calls.length;
    const e = await rejection(r.purgePlan("P"));
    await flush();
    expect(e).toMatchObject({ code: "sync.purge_pending", message: PENDING });
    expect(writesTo(from, IX)).toEqual([gone("P")]);
    expect(docsOf(from, "store_delete")).toEqual(["P"]);
    expect(r.plans().map((p) => p.id)).toEqual(["L"]);
    expect(r.takeGoneNotices()).toEqual([]);
  });

  it("a local plan is erased with no server call", async () => {
    const w = purgeWorld();
    const r = await spaceOpen(w);
    const from = tauri.calls.length;
    await r.purgePlan("L");
    await flush();
    expect(docsOf(from, "sync_purge_plan")).toEqual([]);
    expect(writesTo(from, "local")).toEqual([gone("L")]);
    expect(docsOf(from, "store_delete")).toEqual(["L"]);
    expect(r.plans().map((p) => p.id)).toEqual(["P"]);
    expect(namesOf(w)).toEqual({ P: "Launch" });
    expect(r.takeGoneNotices()).toEqual([]);
  });

  it("refuses a plan that is not in the Trash, and a space plan while read-only", async () => {
    const w = purgeWorld();
    const r = await spaceOpen(w);
    const from = tauri.calls.length;
    const live = await rejection(r.purgePlan("P"));
    expect(live).toBeInstanceOf(Refused);
    expect(live).toMatchObject({ message: NOT_TRASHED });
    r.trashPlan("P");
    r.setSpaceReadOnly(true);
    const locked = await rejection(r.purgePlan("P"));
    expect(locked).toBeInstanceOf(Refused);
    expect(locked).toMatchObject({ message: READ_ONLY });
    await flush();
    expect(docsOf(from, "sync_purge_plan")).toEqual([]);
    expect(docsOf(from, "store_delete")).toEqual([]);
    expect(writesTo(from, IX)).toEqual([ip("P", true)]);
  });

  it("erases a stored plan the plan list says is gone when it starts, and never adopts it", async () => {
    const w = purgeWorld({ localGone: true });
    const r = await open();
    await flush();
    expect(docsOf(0, "store_delete")).toEqual(["L"]);
    expect(writesTo(0, "local")).toEqual([]);
    expect(w.mem.docs.has("L")).toBe(false);
    expect(r.plans()).toEqual([]);
    expect(r.takeGoneNotices()).toEqual([]);
    expect(namesOf(w)).toEqual({ P: "Launch" });
  });

  it("follows a purge on another device: erases the plan and names that device", async () => {
    const w = purgeWorld({ trashed: true, synced: true });
    const r = await spaceOpen(w);
    const from = tauri.calls.length;
    await remoteGone(r, "P");
    expect(docsOf(from, "store_delete")).toEqual(["P"]);
    expect(r.plans().map((p) => p.id)).toEqual(["L"]);
    expect(r.takeGoneNotices()).toEqual([{ text: "“Launch” was deleted forever on iPhone. It is erased from this device too.", bad: false }]);
    expect(r.takeGoneNotices()).toEqual([]);
  });

  it("says when the erased copy held changes that had not synced, and keeps that notice until dismissed", async () => {
    const w = purgeWorld({ trashed: true });
    const r = await spaceOpen(w);
    const from = tauri.calls.length;
    await remoteGone(r, "P");
    expect(docsOf(from, "store_delete")).toEqual(["P"]);
    expect(r.takeGoneNotices()).toEqual([
      { text: "“Launch” was deleted forever on iPhone. It is erased from this device too, including changes that had not synced.", bad: true },
    ]);
  });

  it("a 4410 or 410 before any tombstone erases the plan and says another device deleted it", async () => {
    const w = purgeWorld();
    const r = await spaceOpen(w);
    const from = tauri.calls.length;
    await r.markGone("P");
    await flush();
    expect(writesTo(from, IX)).toEqual([gone("P")]);
    expect(docsOf(from, "store_delete")).toEqual(["P"]);
    expect(r.plans().map((p) => p.id)).toEqual(["L"]);
    expect(r.takeGoneNotices().map((n) => n.text)).toEqual([
      "“Launch” was deleted forever on another device. It is erased from this device too, including changes that had not synced.",
    ]);
  });

  it("a moved plan whose space entry is gone leaves the list and is marked gone in the local list too", async () => {
    const w = purgeWorld({ moved: true, trashed: true });
    const r = await spaceOpen(w);
    expect(r.plans().find((p) => p.id === "P")).toMatchObject({ space: SP, trashed: true });
    const from = tauri.calls.length;
    await remoteGone(r, "P");
    expect(r.plans().map((p) => p.id)).toEqual(["L"]);
    expect(writesTo(from, "local")).toEqual([gone("P")]);
    expect(docsOf(from, "store_delete")).toEqual(["P"]);
  });

  it("a later plan-list change erases nothing again and adds no notice", async () => {
    const w = purgeWorld({ trashed: true });
    const r = await spaceOpen(w);
    await remoteGone(r, "P");
    expect(r.takeGoneNotices()).toHaveLength(1);
    const from = tauri.calls.length;
    await remoteName(r, "r-n");
    expect(docsOf(from, "store_delete")).toEqual([]);
    expect(r.takeGoneNotices()).toEqual([]);
  });

  it("files that cannot be removed keep the name and say so once", async () => {
    const w = purgeWorld({ trashed: true });
    w.mem.fail("store_delete", "P", { code: "store.io", message: "Could not remove /docs/P: Permission denied." });
    const r = await spaceOpen(w);
    const from = tauri.calls.length;
    await remoteGone(r, "P");
    expect(docsOf(from, "store_delete")).toEqual(["P"]);
    expect(namesOf(w)).toEqual({ P: "Launch", L: "Alpha" });
    expect(r.takeGoneNotices()).toEqual([
      {
        text: "“Launch” was deleted forever on iPhone, including changes that had not synced, but its files on this device could not be removed: Could not remove /docs/P: Permission denied. Restart WebBoard to try again.",
        bad: true,
      },
    ]);
    await remoteName(r, "r-n");
    expect(docsOf(from, "store_delete")).toEqual(["P"]);
    expect(r.takeGoneNotices()).toEqual([]);
  });

  it("names the device that deleted the plan when a device that followed it wrote its tombstone first", async () => {
    const w = purgeWorld({ trashed: true, synced: true });
    const r = await spaceOpen(w);
    await remoteName(r, "r-n");
    const ix = (await r.doc(IX)).ydoc;
    Y.applyUpdate(ix, remoteUpdate(ix, "r-c", encodeAction(act("r-c", headsOf(ix), [gone("P")], { dev: "dev-C", lbl: GONE_LABEL }))));
    Y.applyUpdate(ix, remoteUpdate(ix, "r-b", encodeAction(act("r-b", headsOf(ix), [gone("P")], { dev: "dev-B", lbl: PURGE_LABEL }))));
    await flush();
    expect(r.takeGoneNotices()).toEqual([{ text: "“Launch” was deleted forever on iPhone. It is erased from this device too.", bad: false }]);
  });

  it("a tombstone from a device that only followed the deletion names no device", async () => {
    const w = purgeWorld({ trashed: true, synced: true });
    const r = await spaceOpen(w);
    await remoteName(r, "r-n");
    await remoteGone(r, "P", "dev-C", "r-c", GONE_LABEL);
    expect(r.takeGoneNotices()).toEqual([{ text: "“Launch” was deleted forever on another device. It is erased from this device too.", bad: false }]);
  });

  it("a 4410 or 410 writes its tombstone under its own label", async () => {
    const w = purgeWorld();
    const r = await spaceOpen(w);
    const from = tauri.calls.length;
    await r.markGone("P");
    await flush();
    expect(labelsTo(from, IX)).toEqual([GONE_LABEL]);
  });

  it("says so when it cannot read the erased copy to check for changes that had not synced", async () => {
    const w = purgeWorld({ trashed: true, synced: true });
    w.mem.fail("store_load", "P", { code: "store.corrupt", message: "The log of P is damaged." });
    const r = await spaceOpen(w);
    const from = tauri.calls.length;
    await remoteGone(r, "P");
    expect(docsOf(from, "store_delete")).toEqual(["P"]);
    expect(r.takeGoneNotices()).toEqual([
      {
        text: "“Launch” was deleted forever on iPhone. It is erased from this device too. WebBoard could not read it to check for changes that had not synced: The log of P is damaged.",
        bad: true,
      },
    ]);
  });

  it("after a restart still tells a deletion it followed, with the changes that had not synced", async () => {
    purgeWorld({ trashed: true, followed: true });
    const r = await open();
    await flush();
    expect(docsOf(0, "store_delete")).toEqual(["P"]);
    expect(r.takeGoneNotices()).toEqual([
      { text: "“Launch” was deleted forever on another device. It is erased from this device too, including changes that had not synced.", bad: true },
    ]);
  });

  it("an own purge whose files cannot be removed rejects with that, and queues no second notice", async () => {
    const w = purgeWorld();
    w.mem.fail("store_delete", "L", { code: "store.io", message: "Could not remove /docs/L: Permission denied." });
    const r = await spaceOpen(w);
    const e = await rejection(r.purgePlan("L"));
    expect(e).toBeInstanceOf(AppError);
    expect(e).toMatchObject({
      code: "store.io",
      message: "“Alpha” was deleted forever, but its files on this device could not be removed: Could not remove /docs/L: Permission denied. Restart WebBoard to try again.",
    });
    expect(r.plans().map((p) => p.id)).toEqual(["P"]);
    expect(r.takeGoneNotices()).toEqual([]);
  });

  it("refuses a moved plan while its space is stored here but not attached", async () => {
    const w = purgeWorld({ moved: true, trashed: true });
    const r = await open();
    await flush();
    expect(r.plans().find((p) => p.id === "P")).toMatchObject({ trashed: true, space: null });
    expect(r.purgeRefusal("P")).toBe(CONNECT);
    expect(r.purgeRefusal("L")).toBeNull();
    const from = tauri.calls.length;
    const e = await rejection(r.purgePlan("P"));
    await flush();
    expect(e).toBeInstanceOf(Refused);
    expect(e).toMatchObject({ message: CONNECT });
    expect(docsOf(from, "sync_purge_plan")).toEqual([]);
    expect(docsOf(from, "store_delete")).toEqual([]);
    expect(writesTo(from, "local")).toEqual([]);
    expect(r.isGone("P")).toBe(false);
    expect(w.mem.docs.has("P")).toBe(true);
  });

  it("purges a moved plan through the server once its space is attached", async () => {
    const w = purgeWorld({ moved: true, trashed: true });
    const r = await spaceOpen(w);
    expect(r.purgeRefusal("P")).toBeNull();
    const from = tauri.calls.length;
    await r.purgePlan("P");
    await flush();
    expect(docsOf(from, "sync_purge_plan")).toEqual(["P"]);
    expect(docsOf(from, "store_delete")).toEqual(["P"]);
    expect(w.mem.docs.has("P")).toBe(false);
  });

  it("a tombstone for a plan list from another device leaves every plan list open and erases nothing", async () => {
    const w = purgeWorld({ trashed: true });
    const r = await spaceOpen(w);
    const from = tauri.calls.length;
    await remoteGone(r, "local");
    await remoteGone(r, IX, "dev-B", "r-g2");
    expect(docsOf(from, "store_delete")).toEqual([]);
    expect(r.attachedSpace()).toBe(SP);
    expect(r.plans().map((p) => p.id)).toEqual(["L", "P"]);
    expect(r.indexUnreadable()).toHaveLength(2);
    r.restorePlan("L");
    expect(r.plans().find((p) => p.id === "L")).toMatchObject({ trashed: false });
    expect(r.takeGoneNotices()).toEqual([]);
  });

  it("refuses a local purge while a stored space's plan list cannot be read, and allows it once that list opens", async () => {
    const w = purgeWorld({ moved: true, trashed: true });
    w.mem.fail("store_load", IX, { code: "store.io", message: "Disk full." });
    const r = await open();
    await flush();
    expect(r.purgeRefusal("L")).toBe(UNREAD_SPACE);
    expect(r.purgeRefusal("P")).toBe(UNREAD_SPACE);
    const from = tauri.calls.length;
    const e = await rejection(r.purgePlan("P"));
    await flush();
    expect(e).toBeInstanceOf(Refused);
    expect(e).toMatchObject({ message: UNREAD_SPACE });
    expect(docsOf(from, "store_delete")).toEqual([]);
    expect(writesTo(from, "local")).toEqual([]);
    expect(w.mem.docs.has("P")).toBe(true);
    w.mem.recover("store_load", IX);
    await r.retryIndex();
    await flush();
    expect(r.purgeRefusal("L")).toBeNull();
    expect(r.purgeRefusal("P")).toBe(CONNECT);
  });

  it("a 4410 while warm is part-way through loads nothing of the erased plan again", async () => {
    const w = purgeWorld();
    const r = await spaceOpen(w);
    const held = hold("store_load");
    const warming = r.warm();
    await flush();
    await r.markGone("P");
    await flush();
    const from = tauri.calls.length;
    held.resolve(w.mem.answers.store_load({ doc: "L" }));
    await warming;
    await flush();
    expect(docsOf(from, "store_load")).toEqual([]);
    expect(w.mem.docs.has("P")).toBe(false);
    await expect(r.doc("P")).rejects.toBeInstanceOf(PlanGone);
  });

  it("a load in flight when its plan is erased does not load it again", async () => {
    const w = purgeWorld();
    const r = await spaceOpen(w);
    const bytes = w.mem.answers.store_load({ doc: "L" });
    const held = hold("store_load");
    const loading = r.doc("L");
    await flush();
    await r.purgePlan("L");
    await flush();
    const from = tauri.calls.length;
    held.resolve(bytes);
    const e = await rejection(loading);
    await flush();
    expect(e).toBeInstanceOf(PlanGone);
    expect(docsOf(from, "store_load")).toEqual([]);
    expect(w.mem.docs.has("L")).toBe(false);
    expect(r.failures().has("L")).toBe(false);
  });

  it("a 4410 waits for the deleting device's entry and names that device", async () => {
    const w = purgeWorld({ trashed: true, synced: true });
    const r = await spaceOpen(w, 5000);
    const from = tauri.calls.length;
    await r.markGone("P");
    await flush();
    expect(docsOf(from, "store_delete")).toEqual(["P"]);
    expect(r.takeGoneNotices()).toEqual([]);
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
    await remoteGone(r, "P");
    expect(r.takeGoneNotices()).toEqual([{ text: "“Launch” was deleted forever on iPhone. It is erased from this device too.", bad: false }]);
    await remoteName(r, "r-n");
    expect(r.takeGoneNotices()).toEqual([]);
  });

  it("a 4410 with no named entry says another device once the wait ends", async () => {
    const w = purgeWorld({ trashed: true, synced: true });
    const r = await spaceOpen(w, 30);
    await r.markGone("P");
    await flush();
    expect(r.takeGoneNotices()).toEqual([]);
    await new Promise<void>((resolve) => setTimeout(resolve, 40));
    expect(r.takeGoneNotices()).toEqual([{ text: "“Launch” was deleted forever on another device. It is erased from this device too.", bad: false }]);
  });
});
