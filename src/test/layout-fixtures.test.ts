import * as Y from "yjs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InvokeArgs } from "@tauri-apps/api/core";
import { buildFixtures, encodeTuple, LONG_NAMES, orderKey, OUT_OF_RANGE, STEP_GONE, STEP_QA, UNREADABLE_ID, UNREADABLE_LINE, UPDATE_CHECK_FAILED, UPDATE_VERSION } from "../../scripts/layout-fixtures.mjs";
import { normalizeName } from "../actions/build";
import { projectDefaults } from "../domain/defaults";
import { derive } from "../domain/derive";
import { projectPeople } from "../domain/people";
import { projectBoard } from "../domain/steps";
import { defaultNames, formerPeople } from "../plan/former";
import { LogState } from "../log/state";
import type { Action, Cause, DeviceId } from "../log/types";
import { choices, heldItems } from "../plan/choices";
import { projectPlan } from "../plan/project";
import { planRules } from "../plan/rules";
import { parseKey, validateWrite } from "../plan/units";
import { fixedClock } from "../services/clock";
import { decodeAction, encodeAction, PlanDoc } from "../store/doc";
import { indexRules } from "../store/index-doc";
import { SPACE_PREFIX } from "../store/plan-id";
import { Registry } from "../store/registry";
import { encodeLoad } from "./fixtures/store";
import { MESA_SEED } from "./session";
import { resetTauri, type Answer } from "./tauriMock";
import { parsePlatform } from "../platform";
import { setPlatform } from "./platform";
import { setScreen } from "./setup";

vi.mock("@tauri-apps/api/core", () => import("./tauriMock"));

type Fixture = ReturnType<typeof buildFixtures>[string];

const FIXTURES = buildFixtures();

const UIKIT = {
  appearance_set: { __byArg: "scheme", map: { light: null, dark: null, system: null } },
  haptic: { __byArg: "kind", map: { selection: null, light: null, medium: null, success: null, warning: null, error: null } },
  menu_show: null,
  menu_dismiss: null,
};

const fixture = (name: string): Fixture => {
  const f = FIXTURES[name];
  if (f === undefined) throw new Error(`no fixture ${name}`);
  return f;
};

interface Frame {
  flags: number;
  lastSeq: number;
  entries: Uint8Array[];
}

function readFrame(bytes: Uint8Array): Frame {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint32(9, true);
  const { entries, end } = Array.from({ length: count }).reduce<{ entries: Uint8Array[]; end: number }>(
    (acc) => {
      const len = view.getUint32(acc.end, true);
      acc.entries.push(bytes.subarray(acc.end + 4, acc.end + 4 + len));
      return { entries: acc.entries, end: acc.end + 4 + len };
    },
    { entries: [], end: 13 },
  );
  expect(end).toBe(bytes.length);
  return { flags: view.getUint8(0), lastSeq: Number(view.getBigUint64(1, true)), entries };
}

function ydocOf(f: Fixture, doc: string): Y.Doc {
  const bytes = f.docs[doc];
  if (bytes === undefined) throw new Error(`no doc ${doc}`);
  const ydoc = new Y.Doc();
  readFrame(bytes).entries.filter((e) => e.length > 0).forEach((e) => Y.applyUpdate(ydoc, e));
  return ydoc;
}

const rawActions = (ydoc: Y.Doc): [string, unknown][] => [...ydoc.getMap("actions").entries()];

const ipcOf = (f: Fixture, cmd: string): unknown => {
  if (!(cmd in f.ipc)) throw new Error(`fixture answers no ${cmd}`);
  return f.ipc[cmd];
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function answerOf(value: unknown): Answer {
  return (args: InvokeArgs | undefined) => {
    if (isRecord(value) && typeof value.__byArg === "string" && isRecord(value.map)) {
      const arg = isRecord(args) ? args[value.__byArg] : undefined;
      const hit = value.map[String(arg)];
      if (hit === undefined) throw new Error(`fixture has no answer for ${value.__byArg} ${String(arg)}`);
      if (isRecord(hit) && "__reject" in hit) throw structuredClone(hit.__reject);
      return structuredClone(hit);
    }
    return structuredClone(value);
  };
}

const PLAN_ID = /^[A-Za-z0-9_-]{11}$/;

const isPlanId = (id: string): boolean => PLAN_ID.test(id) && !id.startsWith(SPACE_PREFIX);

function answersOf(f: Fixture, served: string[] = []): Record<string, Answer> {
  const docArg = (args: InvokeArgs | undefined): string => {
    if (!isRecord(args) || typeof args.doc !== "string") throw new Error("store_load without a doc");
    return args.doc;
  };
  return {
    ...Object.fromEntries(Object.entries(f.ipc).map(([cmd, v]) => [cmd, answerOf(v)])),
    store_load: (args) => {
      const id = docArg(args);
      const bytes = f.docs[id];
      if (bytes !== undefined) return bytes.slice().buffer;
      if (f.newDoc === undefined || !isPlanId(id) || served.length > 0) throw new Error(`fixture has no doc ${id}`);
      served.push(id);
      return f.newDoc.slice().buffer;
    },
  };
}

const DEVICES: ReadonlyMap<DeviceId, string> = new Map([
  ["mac", "Mac"],
  ["iphone", "iPhone"],
]);

function planDocs(f: Fixture): string[] {
  return Object.keys(f.docs).filter((d) => d !== "local" && !d.startsWith("ix-"));
}

const UNREADABLE_FIXTURES: ReadonlySet<string> = new Set(["unreadable", "unreadable-ios-pad", "unreadable-ios-phone", "sync-receiving"]);

function only<T>(xs: readonly T[]): T {
  expect(xs).toHaveLength(1);
  return xs[0];
}

function decoded(f: Fixture, doc: string) {
  const ydoc = ydocOf(f, doc);
  const actions: Action[] = [...new PlanDoc(ydoc).actions()];
  const log = new LogState(planRules);
  const delta = log.add(actions);
  expect(delta.refused).toEqual([]);
  const plan = projectPlan(doc, log);
  const cs = choices(log, plan, DEVICES);
  return { ydoc, actions, log, plan, cs, held: heldItems(cs, plan) };
}

const DEVICE_NAMES: Readonly<Record<string, string>> = { "mesa-linux": "Linux", "mesa-ios-phone": "iPhone", "mesa-ios-pad": "iPad", "mesa-steps-ios-pad": "iPad", "mesa-steps-ios-phone": "iPhone", "mesa-people-ios-pad": "iPad", "mesa-people-ios-phone": "iPhone", "mesa-defaults-ios-pad": "iPad", "mesa-defaults-ios-phone": "iPhone", "phone-status-ios": "iPhone", "phone-removed-banner-ios": "iPhone", "sync-removed-ios-pad": "iPad", "choices-ios-pad": "iPad", "unreadable-ios-pad": "iPad", "unreadable-ios-phone": "iPhone" };

const openRegistries: Registry[] = [];

afterEach(async () => {
  const closing = openRegistries.splice(0);
  await Promise.all(closing.map((r) => r.close()));
});

async function opened(f: Fixture, doc: string) {
  resetTauri(answersOf(f));
  const registry = await Registry.open({ clock: fixedClock("2026-11-09") });
  openRegistries.push(registry);
  const session = await registry.session(doc);
  return { registry, session };
}

const stringsOf = (v: unknown, what: string): string[] => {
  if (!Array.isArray(v) || !v.every((x): x is string => typeof x === "string")) throw new Error(`${what} is not a list of strings`);
  return v;
};

function readable(f: Fixture, doc: string) {
  const raws = rawActions(ydocOf(f, doc));
  const actions = raws.filter(([id]) => id !== UNREADABLE_ID).map(([id, raw]) => decodeAction(id, raw));
  const log = new LogState(planRules);
  const delta = log.add(actions);
  expect(delta.refused).toEqual([]);
  return { raws, actions, log, items: [...projectPlan(doc, log).items.keys()] };
}

const shapeOf = (plan: ReturnType<typeof projectPlan>) =>
  [...plan.items.values()]
    .map((i) => ({ id: i.id, kind: i.kind, name: i.name, parent: i.place.parent, schedule: i.schedule, trashed: i.trashed }))
    .sort((a, b) => (a.id < b.id ? -1 : 1));

const seedShape = () =>
  MESA_SEED.map((s) => {
    const id = s.id ?? s.name;
    const kind = s.kind ?? "task";
    return {
      id,
      kind,
      name: s.name,
      parent: s.parent ?? null,
      schedule:
        kind === "group"
          ? null
          : { start: s.start ?? null, dur: kind === "milestone" ? 0 : (s.dur ?? 3), status: s.status ?? "todo", progress: s.progress ?? 0, horizon: s.horizon ?? "later" },
      trashed: false,
    };
  }).sort((a, b) => (a.id < b.id ? -1 : 1));

const seedLinks = (): string[] => MESA_SEED.flatMap((s) => (s.deps ?? []).map((d) => `${d.from}>${s.id ?? s.name} ${d.type} ${d.lag}`)).sort();

const linksOf = (plan: ReturnType<typeof projectPlan>): string[] => [...plan.links.values()].map((l) => `${l.from}>${l.to} ${l.type} ${l.lag}`).sort();

describe("layout fixtures", () => {
  it("names the fixtures the probe states use", () => {
    expect(Object.keys(FIXTURES).sort()).toEqual([
      "all-trashed",
      "blank-plan",
      "choices",
      "choices-ios-pad",
      "converted",
      "converted-people",
      "empty",
      "example",
      "long-names",
      "mesa",
      "mesa-defaults",
      "mesa-defaults-ios-pad",
      "mesa-defaults-ios-phone",
      "mesa-ios-pad",
      "mesa-ios-phone",
      "mesa-linux",
      "mesa-people",
      "mesa-people-ios-pad",
      "mesa-people-ios-phone",
      "mesa-steps",
      "mesa-steps-ios-pad",
      "mesa-steps-ios-phone",
      "phone-choice",
      "phone-plans",
      "phone-removed-banner",
      "phone-removed-banner-ios",
      "phone-status",
      "phone-status-ios",
      "phone-sync-sheet",
      "scale",
      "scale-print",
      "sync-dialog",
      "sync-local",
      "sync-receiving",
      "sync-removed",
      "sync-removed-ios-pad",
      "sync-space",
      "two-choices",
      "unreadable",
      "unreadable-ios-pad",
      "unreadable-ios-phone",
      "update-available",
      "update-check-failed",
      "update-downloading",
    ]);
  });

  it("answers print_window only in the print state, on the scale plan", () => {
    expect(Object.entries(FIXTURES).filter(([, f]) => "print_window" in f.ipc).map(([name]) => name)).toEqual(["scale-print"]);
    expect(fixture("scale-print").ipc.print_window).toBeNull();
    expect(fixture("scale-print").docs).toEqual(fixture("scale").docs);
  });

  it("answers sync_status in every state, local only unless the state joins a space", () => {
    const joined = { space: { server: "https://probe.invalid", spaceId: "sp000000000", deviceId: "mac", deviceName: "Mac" }, revoked: false };
    const expected: Record<string, unknown> = { "sync-space": joined, "sync-local": joined, "sync-receiving": joined, "sync-removed": { ...joined, revoked: true }, "sync-removed-ios-pad": { ...joined, revoked: true }, "phone-removed-banner": { ...joined, revoked: true }, "phone-removed-banner-ios": { ...joined, revoked: true } };
    Object.entries(FIXTURES).forEach(([name, f]) => expect(f.ipc.sync_status, name).toEqual(expected[name] ?? { space: null, revoked: false }));
  });

  it("answers the text size zoom in every state", () => {
    expect(Object.entries(FIXTURES).filter(([, f]) => f.ipc["plugin:webview|set_webview_zoom"] !== null).map(([name]) => name)).toEqual([]);
  });

  it("answers the update check in every state with no update, except the update states, which are the mesa plan", () => {
    const UPDATE_STATES = ["update-available", "update-check-failed", "update-downloading"];
    Object.entries(FIXTURES)
      .filter(([name]) => !UPDATE_STATES.includes(name))
      .forEach(([name, f]) => {
        expect(f.ipc["plugin:updater|check"], name).toBeNull();
        expect("plugin:updater|download_and_install" in f.ipc, name).toBe(false);
      });
    const found = { rid: 1, currentVersion: "0.1.0", version: UPDATE_VERSION, date: "2026-11-09 08:00:00.0 +00:00:00", body: "", rawJson: {} };
    expect(fixture("update-available").ipc["plugin:updater|check"]).toEqual(found);
    expect(fixture("update-downloading").ipc["plugin:updater|check"]).toEqual(found);
    expect(fixture("update-check-failed").ipc["plugin:updater|check"]).toEqual({ __reject: UPDATE_CHECK_FAILED });
    expect(fixture("update-downloading").ipc["plugin:updater|download_and_install"]).toEqual({
      __channel: "onEvent",
      messages: [
        { event: "Started", data: { contentLength: 24 * 1024 * 1024 } },
        { event: "Progress", data: { chunkLength: 12 * 1024 * 1024 } },
      ],
    });
    UPDATE_STATES.forEach((name) => {
      expect(fixture(name).docs, name).toEqual(fixture("mesa").docs);
      expect(fixture(name).ipc, name).not.toBe(fixture("mesa").ipc);
    });
  });

  it("gives every space state its index doc and a ticket, and no other state either", () => {
    Object.entries(FIXTURES).forEach(([name, f]) => {
      const space = ["sync-space", "sync-local", "sync-receiving", "sync-removed", "sync-removed-ios-pad", "phone-removed-banner", "phone-removed-banner-ios"].includes(name);
      expect("ix-sp000000000" in f.docs, name).toBe(space);
      expect(f.ipc.sync_ticket, name).toEqual(space ? { ticket: "tk_probe", expiresAt: new Date(2026, 10, 9, 10, 0, 0, 0).getTime() } : undefined);
    });
  });

  it("issues a ticket that outlives the probe's pinned clock by an hour", () => {
    const pin = new Date(2026, 10, 9, 9, 0, 0, 0).getTime();
    const ticket: unknown = fixture("sync-space").ipc.sync_ticket;
    if (typeof ticket !== "object" || ticket === null || !("expiresAt" in ticket) || typeof ticket.expiresAt !== "number") throw new Error("sync-space answers no sync_ticket expiry");
    expect(ticket.expiresAt - pin).toBe(60 * 60 * 1000);
  });

  it("sync-dialog is the mesa plan, local only", () => {
    expect(fixture("sync-dialog")).not.toBe(fixture("mesa"));
    expect(fixture("sync-dialog").ipc).not.toBe(fixture("mesa").ipc);
    expect(fixture("sync-dialog")).toEqual(fixture("mesa"));
  });

  it("phone-sync-sheet is the mesa plan, local only, and phone-removed-banner is the removed space holding the mesa plan", async () => {
    expect(fixture("phone-sync-sheet")).not.toBe(fixture("mesa"));
    expect(fixture("phone-sync-sheet")).toEqual(fixture("mesa"));
    expect(fixture("phone-removed-banner").ipc).not.toBe(fixture("sync-removed").ipc);
    expect(fixture("phone-removed-banner").ipc).toEqual(fixture("sync-removed").ipc);
    const plans = (name: string): unknown => Object.fromEntries(Object.entries(fixture(name).docs).filter(([doc]) => doc !== "ix-sp000000000"));
    expect(plans("phone-removed-banner")).toEqual(plans("mesa"));
    const ix = new LogState(indexRules);
    expect(ix.add([...new PlanDoc(ydocOf(fixture("phone-removed-banner"), "ix-sp000000000")).actions()]).refused).toEqual([]);
    resetTauri(answersOf(fixture("phone-removed-banner")));
    const registry = await Registry.open({ clock: fixedClock("2026-11-09") });
    openRegistries.push(registry);
    expect(registry.plans().map((l) => [l.id, l.space])).toEqual([["planMesa001", null]]);
    await registry.attachSpace("sp000000000");
    expect(registry.plans().map((l) => [l.id, l.name, l.trashed, l.space])).toEqual([["planMesa001", "MESA 1.0", false, "sp000000000"]]);
  });

  it("sync-local is a space holding the mesa plan, with the example and two long-named plans on this device only", async () => {
    resetTauri(answersOf(fixture("sync-local")));
    const registry = await Registry.open({ clock: fixedClock("2026-11-09") });
    openRegistries.push(registry);
    await registry.attachSpace("sp000000000");
    await registry.warm();
    const listed = registry.plans().map((l) => [l.id, l.trashed, l.space, l.loaded, l.example]);
    expect(listed).toEqual([
      ["planExample", false, null, true, true],
      ["planLong001", false, null, true, false],
      ["planLongRtl", false, null, true, false],
      ["planMesa001", false, "sp000000000", true, false],
    ]);
  });

  it("shares no ipc answers object between states", () => {
    const all = Object.values(FIXTURES);
    expect(new Set(all.map((f) => f.ipc)).size).toBe(all.length);
  });

  it("the space states are their plain fixtures plus the space index", () => {
    const plain = (f: Fixture) => ({ ...f, docs: Object.fromEntries(Object.entries(f.docs).filter(([d]) => !d.startsWith("ix-"))) });
    expect(plain(fixture("sync-space")).docs).toEqual(fixture("mesa").docs);
    expect(plain(fixture("sync-removed")).docs).toEqual(fixture("mesa").docs);
    expect(plain(fixture("sync-receiving")).docs).toEqual(fixture("unreadable").docs);
  });

  it("mesa-linux is the mesa plan on a Linux device", () => {
    const mac = fixture("mesa");
    const linux = fixture("mesa-linux");
    expect(linux.docs).toEqual(mac.docs);
    expect(linux.ipc).toEqual({ ...mac.ipc, device_info: { deviceId: "linux", platform: "linux" } });
    expect(mac.ipc.device_info).toEqual({ deviceId: "mac", platform: "macos" });
  });

  it("the iOS variants are the mesa plan on an iPhone and an iPad, each with the matching platform global", () => {
    const mac = fixture("mesa");
    const phone = fixture("mesa-ios-phone");
    const pad = fixture("mesa-ios-pad");
    expect(phone.docs).toEqual(mac.docs);
    expect(pad.docs).toEqual(mac.docs);
    expect(phone.ipc).toEqual({ ...mac.ipc, device_info: { deviceId: "iphone", platform: "ios" }, ...UIKIT });
    expect(pad.ipc).toEqual({ ...mac.ipc, device_info: { deviceId: "ipad", platform: "ios" }, ...UIKIT });
    expect(phone.platform).toEqual({ os: "ios", idiom: "phone" });
    expect(pad.platform).toEqual({ os: "ios", idiom: "pad" });
  });

  it.each([
    ["phone-removed-banner-ios", "phone-removed-banner", "iphone", { os: "ios", idiom: "phone" }],
    ["sync-removed-ios-pad", "sync-removed", "ipad", { os: "ios", idiom: "pad" }],
    ["choices-ios-pad", "choices", "ipad", { os: "ios", idiom: "pad" }],
    ["unreadable-ios-pad", "unreadable", "ipad", { os: "ios", idiom: "pad" }],
    ["unreadable-ios-phone", "unreadable", "iphone", { os: "ios", idiom: "phone" }],
  ] as const)("%s is the %s fixture on iOS", (name, of, deviceId, platform) => {
    expect(fixture(name).docs).toEqual(fixture(of).docs);
    expect(fixture(name).ipc).toEqual({ ...fixture(of).ipc, device_info: { deviceId, platform: "ios" }, ...UIKIT });
    expect(fixture(name).platform).toEqual(platform);
  });

  it("phone-status-ios is the phone-status fixture on an iPhone", () => {
    expect(fixture("phone-status-ios").docs).toEqual(fixture("phone-status").docs);
    expect(fixture("phone-status-ios").ipc).toEqual({ ...fixture("phone-status").ipc, device_info: { deviceId: "iphone", platform: "ios" }, ...UIKIT });
    expect(fixture("phone-status-ios").platform).toEqual({ os: "ios", idiom: "phone" });
  });

  it("exactly the iOS fixtures answer appearance_set, haptic, menu_show and menu_dismiss, so a desktop state that sends any is unreached", () => {
    Object.entries(FIXTURES).forEach(([name, f]) => {
      const answered = Object.keys(f.ipc).filter((cmd) => cmd in UIKIT);
      expect([name, answered]).toEqual([name, f.platform.os === "ios" ? Object.keys(UIKIT) : []]);
    });
    expect(Object.values(FIXTURES).filter((f) => f.platform.os === "ios")).toHaveLength(14);
  });

  it("every fixture carries a platform global its device_info agrees with", () => {
    expect(fixture("mesa").platform).toEqual({ os: "macos", idiom: null });
    expect(fixture("empty").platform).toEqual({ os: "macos", idiom: null });
    expect(fixture("mesa-linux").platform).toEqual({ os: "linux", idiom: null });
    Object.entries(FIXTURES).forEach(([name, f]) => {
      expect([name, parsePlatform(Object.freeze({ ...f.platform }))]).toEqual([name, f.platform]);
      const device = ipcOf(f, "device_info");
      expect([name, isRecord(device) ? device.platform : device]).toEqual([name, f.platform.os]);
    });
  });

  it("frames every doc as store_load with flags 0 and lastSeq the entry count", () => {
    Object.values(FIXTURES).forEach((f) =>
      Object.values(f.docs).forEach((bytes) => {
        const frame = readFrame(bytes);
        expect(frame.flags).toBe(0);
        expect(frame.lastSeq).toBe(frame.entries.length);
      }),
    );
  });

  it("lists exactly its docs in store_list", () => {
    Object.values(FIXTURES).forEach((f) => expect([...stringsOf(ipcOf(f, "store_list"), "store_list")].sort()).toEqual(Object.keys(f.docs).sort()));
  });

  it("writes only unit keys parseKey reads and values validateWrite accepts", () => {
    Object.entries(FIXTURES).forEach(([name, f]) =>
      planDocs(f).forEach((doc) =>
        rawActions(ydocOf(f, doc)).forEach(([id, raw]) => {
          if (UNREADABLE_FIXTURES.has(name) && id === UNREADABLE_ID) return;
          decodeAction(id, raw).w.forEach((w) => {
            expect(() => parseKey(w.u)).not.toThrow();
            validateWrite(w);
          });
        }),
      ),
    );
  });

  it("gives every item a note, as a create does", () => {
    Object.values(FIXTURES).forEach((f) =>
      planDocs(f).forEach((doc) => {
        const notes = ydocOf(f, doc).getMap("notes");
        readable(f, doc).items.forEach((item) => expect(notes.get(item)).toBeInstanceOf(Y.Text));
      }),
    );
  });

  it("decodes every action but the one unreadable tuple, and the log refuses none of them", () => {
    Object.entries(FIXTURES).forEach(([name, f]) =>
      planDocs(f).forEach((doc) => {
        const { raws, log } = readable(f, doc);
        expect(raws.some(([id]) => id === UNREADABLE_ID)).toBe(UNREADABLE_FIXTURES.has(name));
        if (!UNREADABLE_FIXTURES.has(name)) expect(log.pending).toEqual([]);
      }),
    );
  });

  it("phone-plans lists mesa's and long-names' plan docs untrashed and one plan in the Trash", () => {
    const f = fixture("phone-plans");
    const ydoc = ydocOf(f, "local");
    const log = new LogState(indexRules);
    const delta = log.add([...new PlanDoc(ydoc).actions()]);
    expect(delta.refused).toEqual([]);
    const listings = [...log.units()].filter(([u]) => u.startsWith("ip:")).map(([u, st]) => [u.slice(3), st.value]);
    expect(listings).toHaveLength(3);
    expect(listings.filter(([, v]) => isRecord(v) && v.t === true)).toHaveLength(1);
    const live = listings.filter(([, v]) => isRecord(v) && v.t === false).map(([id]) => String(id));
    expect(live.sort()).toEqual(["planLong001", "planMesa001"]);
    live.forEach((id) => expect(() => decoded(f, id)).not.toThrow());
    expect(decoded(f, "planLong001").plan.name).toBe(LONG_NAMES[0]);
  });

  it("all-trashed holds one plan, its listing in the Trash", async () => {
    resetTauri(answersOf(fixture("all-trashed")));
    const registry = await Registry.open({ clock: fixedClock("2026-11-09") });
    openRegistries.push(registry);
    expect(registry.plans().map((p) => ({ name: p.name, trashed: p.trashed }))).toEqual([{ name: "MESA 1.0", trashed: true }]);
  });

  it("empty has no plan and blank-plan has one with no items", () => {
    expect(planDocs(fixture("empty"))).toEqual([]);
    const blank = decoded(fixture("blank-plan"), only(planDocs(fixture("blank-plan"))));
    expect(blank.plan.items.size).toBe(0);
    expect(blank.cs).toEqual([]);
  });

  it("mesa holds the mockup's items and links in 40 actions", async () => {
    const f = fixture("mesa");
    const doc = only(planDocs(f));
    const d = decoded(f, doc);
    expect(shapeOf(d.plan)).toEqual(seedShape());
    expect(linksOf(d.plan)).toEqual(seedLinks());
    expect(d.actions).toHaveLength(40);
    expect(d.cs).toEqual([]);
    expect(d.log.pending).toEqual([]);
    const { session } = await opened(f, doc);
    expect(session.history()).toHaveLength(40);
    expect(session.view().unreadable).toEqual([]);
    expect(session.view().plan.calendar.holidays.size).toBe(2);
  });

  it("mesa-steps is mesa plus one action that renames Next to Review with a limit of 2, adds QA and places six items, one in a deleted step", () => {
    const f = fixture("mesa-steps");
    const doc = only(planDocs(f));
    const d = decoded(f, doc);
    const base = decoded(fixture("mesa"), only(planDocs(fixture("mesa"))));
    expect(d.actions).toHaveLength(41);
    expect(shapeOf(d.plan)).toEqual(shapeOf(base.plan));
    expect(d.cs).toEqual([]);
    expect([...d.plan.workflow.steps]).toEqual([
      ["next", { n: "Review", c: "violet", o: "a1", l: 2 }],
      [STEP_QA, { n: "QA", c: "sky", o: "a15" }],
    ]);
    expect(Object.fromEntries(d.plan.workflow.items)).toEqual({ t2: "now", t3: "next", t4: "now", t5: STEP_QA, t10: "next", u2: STEP_GONE });
    const derived = derive(d.plan, d.held, "2026-11-09");
    const board = projectBoard(d.plan, derived);
    expect(board.mode).toBe("steps");
    expect(board.columns.map((c) => [c.step === null ? null : c.step.name, c.items.length])).toEqual([
      [null, 1],
      ["Now", 2],
      ["Review", 3],
      ["QA", 1],
      ["Later", 13],
      ["Done", 2],
    ]);
    expect(fixture("mesa-steps-ios-pad").docs).toEqual(f.docs);
    expect(fixture("mesa-steps-ios-pad").ipc).toEqual({ ...f.ipc, device_info: { deviceId: "ipad", platform: "ios" }, ...UIKIT });
    expect(fixture("mesa-steps-ios-pad").platform).toEqual({ os: "ios", idiom: "pad" });
    expect(fixture("mesa-steps-ios-phone").docs).toEqual(f.docs);
    expect(fixture("mesa-steps-ios-phone").ipc).toEqual({ ...f.ipc, device_info: { deviceId: "iphone", platform: "ios" }, ...UIKIT });
    expect(fixture("mesa-steps-ios-phone").platform).toEqual({ os: "ios", idiom: "phone" });
  });

  it("mesa-people is mesa plus three actions that add four people, assign three open cards and remove Dana Lee, who stays on t4 as a former person", () => {
    const f = fixture("mesa-people");
    const doc = only(planDocs(f));
    const d = decoded(f, doc);
    const base = decoded(fixture("mesa"), only(planDocs(fixture("mesa"))));
    expect(d.actions).toHaveLength(base.actions.length + 3);
    expect(shapeOf(d.plan)).toEqual(shapeOf(base.plan));
    expect(d.cs).toEqual([]);
    expect([...d.plan.people.persons]).toEqual([
      ["ana", { n: "Ana Ruiz", i: "AR", c: "coral", o: "a2" }],
      ["dana", null],
      ["mira", { n: "Mira Okafor", i: "MO", c: "violet", o: "a0" }],
      ["ole", { n: "Ole Berg", i: "OB", c: "lime", o: "a1" }],
    ]);
    const people = projectPeople(d.plan, formerPeople(d.log, d.plan));
    expect(people.people.map((p) => p.name)).toEqual(["Mira Okafor", "Ole Berg", "Ana Ruiz"]);
    expect([...people.assignees].map(([item, list]) => [item, list.map((a) => (a.kind === "live" ? a.person.initials : `former ${a.initials ?? "?"} ${a.name ?? "?"}`))])).toEqual([
      ["t2", ["MO", "AR"]],
      ["t3", ["OB"]],
      ["t4", ["former DL Dana Lee"]],
    ]);
    const board = projectBoard(d.plan, derive(d.plan, d.held, "2026-11-09"));
    const open = board.columns.filter((c) => c.step === null || !c.step.completes).flatMap((c) => c.items.map((i) => i.id));
    expect(["t2", "t3", "t4"].filter((id) => !open.includes(id))).toEqual([]);
    expect(fixture("mesa-people-ios-pad").docs).toEqual(f.docs);
    expect(fixture("mesa-people-ios-pad").ipc).toEqual({ ...f.ipc, device_info: { deviceId: "ipad", platform: "ios" }, ...UIKIT });
    expect(fixture("mesa-people-ios-pad").platform).toEqual({ os: "ios", idiom: "pad" });
    expect(fixture("mesa-people-ios-phone").docs).toEqual(f.docs);
    expect(fixture("mesa-people-ios-phone").ipc).toEqual({ ...f.ipc, device_info: { deviceId: "iphone", platform: "ios" }, ...UIKIT });
    expect(fixture("mesa-people-ios-phone").platform).toEqual({ os: "ios", idiom: "phone" });
  });

  it("mesa-defaults is mesa-people plus one action that stores defaults of 5 days, undated, the removed Dana Lee, Commission and the first open step", () => {
    const f = fixture("mesa-defaults");
    const doc = only(planDocs(f));
    const d = decoded(f, doc);
    const base = decoded(fixture("mesa-people"), only(planDocs(fixture("mesa-people"))));
    expect(d.actions).toHaveLength(base.actions.length + 1);
    expect(shapeOf(d.plan)).toEqual(shapeOf(base.plan));
    expect(d.cs).toEqual([]);
    expect(d.plan.defaults).toEqual({ dur: 5, dated: false, who: "dana", group: "g2", step: null });
    expect(projectDefaults(d.plan, defaultNames(d.log, d.plan))).toEqual({
      dur: 5,
      dated: false,
      who: null,
      group: "g2",
      step: null,
      stored: { dur: 5, dated: false, who: "dana", group: "g2", step: null },
      gone: [{ field: "who", id: "dana", name: "Dana Lee", why: "removed" }],
    });
    expect(fixture("mesa-defaults-ios-pad").docs).toEqual(f.docs);
    expect(fixture("mesa-defaults-ios-pad").ipc).toEqual({ ...f.ipc, device_info: { deviceId: "ipad", platform: "ios" }, ...UIKIT });
    expect(fixture("mesa-defaults-ios-pad").platform).toEqual({ os: "ios", idiom: "pad" });
    expect(fixture("mesa-defaults-ios-phone").docs).toEqual(f.docs);
    expect(fixture("mesa-defaults-ios-phone").ipc).toEqual({ ...f.ipc, device_info: { deviceId: "iphone", platform: "ios" }, ...UIKIT });
    expect(fixture("mesa-defaults-ios-phone").platform).toEqual({ os: "ios", idiom: "phone" });
  });

  it("scale holds 1,000 items and 2,000 links with nothing pending", () => {
    const f = fixture("scale");
    const d = decoded(f, only(planDocs(f)));
    expect(d.plan.items.size).toBe(1000);
    expect(d.plan.links.size).toBe(2000);
    expect(d.log.pending).toEqual([]);
    expect(d.cs).toEqual([]);
  });

  it("choices yields an items, a delete and a calendar choice; the items choice has three sides", () => {
    const f = fixture("choices");
    const d = decoded(f, only(planDocs(f)));
    expect(d.cs.map((c) => c.kind).sort()).toEqual(["calendar", "delete", "items"]);
    const items = only(d.cs.filter((c) => c.kind === "items"));
    expect(items.units).toEqual(["s:t3"]);
    expect(items.sides).toHaveLength(3);
    expect(new Set(items.sides.map((s) => s.label))).toEqual(new Set(["Mac", "iPhone", "Mac — earlier copy"]));
    expect([...d.held]).toEqual(["t3"]);
  });

  it("lists every long-names plan and item name in LONG_NAMES, which the probe's clip check judges", () => {
    const f = fixture("long-names");
    const names = planDocs(f).flatMap((doc) => {
      const d = decoded(f, doc);
      return [d.plan.name, ...[...d.plan.items.values()].map((i) => i.name)];
    });
    expect(names.filter((n) => !LONG_NAMES.includes(n))).toEqual([]);
    expect([...LONG_NAMES].sort()).toEqual([...new Set(names)].sort());
  });

  it("long-names stores 300-character, emoji, right-to-left and once-multi-line names on one line", () => {
    const f = fixture("long-names");
    const names = planDocs(f).flatMap((doc) => {
      const d = decoded(f, doc);
      return [d.plan.name, ...[...d.plan.items.values()].map((i) => i.name)];
    });
    names.forEach((n) => {
      expect(n).toBe(normalizeName(n));
      expect(n).not.toMatch(/[\n\r\t]/);
    });
    expect(names.some((n) => n.length >= 300)).toBe(true);
    expect(names.some((n) => /\p{Extended_Pictographic}/u.test(n))).toBe(true);
    expect(names.some((n) => /[֐-ࣿ]/.test(n))).toBe(true);
    expect(names).toContain(normalizeName("Kick-off notes\nfrom the vendor workshop\r\n\tsecond line kept"));
    expect(names.filter((n) => n.length >= 300).length).toBeGreaterThanOrEqual(2);
  });

  it("unreadable is mesa plus one iPhone action decodeAction refuses and one child of it", async () => {
    const f = fixture("unreadable");
    const doc = only(planDocs(f));
    const { raws, actions, log } = readable(f, doc);
    const bad = only(raws.filter(([id]) => id === UNREADABLE_ID));
    expect(Array.isArray(bad[1]) && bad[1][0]).toBe("iphone");
    expect(() => decodeAction(UNREADABLE_ID, bad[1])).toThrow(`Action ${UNREADABLE_ID} has a malformed lbl`);
    expect(actions).toHaveLength(raws.length - 1);
    const child = only(actions.filter((a) => a.par.includes(UNREADABLE_ID)));
    expect(child.dev).toBe("iphone");
    expect(log.pending).toEqual([child.id]);
    const { session } = await opened(f, doc);
    const view = session.view();
    expect(shapeOf(view.plan)).toEqual(seedShape());
    expect(view.unreadable).toHaveLength(1);
    expect(view.unreadable[0].id).toBe(UNREADABLE_ID);
    expect(view.unreadable[0].message).toBe(UNREADABLE_LINE);
    expect(view.unreadable[0].message).toBe(`A change from iPhone could not be read: Action ${UNREADABLE_ID} has a malformed lbl. Update WebBoard on this device.`);
    expect(view.pending).toBe(1);
  });

  it("phone-choice is Step 2's fixture: one items choice over Review and Ship, holding both, nothing pending", async () => {
    const f = fixture("phone-choice");
    const doc = only(planDocs(f));
    const d = decoded(f, doc);
    const items = only(d.cs);
    expect(items.kind).toBe("items");
    expect([...items.units].sort()).toEqual(["s:Review", "s:Ship"]);
    expect(new Set(items.sides.map((s) => s.label))).toEqual(new Set(["Mac", "iPhone"]));
    expect([...d.held].sort()).toEqual(["Review", "Ship"]);
    expect(d.log.pending).toEqual([]);
    expect(d.plan.items.get("S")?.name).toBe("Sprint 4");
    const start = (id: string): string | null | undefined => d.plan.items.get(id)?.schedule?.start;
    expect([start("Review"), start("Ship"), start("Build")]).toEqual(["2026-11-19", "2026-11-19", "2026-11-23"]);
    const { session } = await opened(f, doc);
    expect(session.view().pending).toBe(0);
    expect(session.view().held.size).toBe(2);
    const mac = items.sides.find((s) => s.label === "Mac");
    if (mac === undefined) throw new Error("no Mac side");
    const rp = session.previewResolve(items.id, { side: mac.key }, { pushFromPredecessors: true, returnPushed: true });
    expect(rp.rows.map((r) => [r.item, r.shift])).toEqual([
      ["Review", -3],
      ["Ship", -3],
      ["Build", -3],
    ]);
  });

  it("two-choices is mesa plus an n: clash and a ct: clash, holding nothing", async () => {
    const f = fixture("two-choices");
    const doc = only(planDocs(f));
    const d = decoded(f, doc);
    expect(d.cs).toHaveLength(2);
    expect(d.cs.map((c) => parseKey(only(c.units)).kind).sort()).toEqual(["ct", "n"]);
    expect([...d.held]).toEqual([]);
    const { session } = await opened(f, doc);
    expect(session.view().choices).toHaveLength(2);
    expect(session.view().held.size).toBe(0);
  });

  it("phone-status holds one early conflict on Build, holiday years through 2030, and an item in 2031 whose year is out of range", async () => {
    const f = fixture("phone-status");
    const doc = only(planDocs(f));
    const d = decoded(f, doc);
    expect(d.plan.name).toBe(LONG_NAMES[0]);
    expect([...d.plan.calendar.holidays.keys()].sort()).toEqual([2026, 2027, 2028, 2029, 2030]);
    expect(d.plan.items.get("C")?.schedule?.start).toBe("2031-03-04");
    expect(d.cs).toEqual([]);
    const year = answerOf(ipcOf(f, "holidays_year"));
    const rejected = ((): unknown => {
      try {
        year({ region: d.plan.calendar.region, year: 2031, fresh: false });
      } catch (e) {
        return e;
      }
      throw new Error("holidays_year 2031 answered");
    })();
    expect(rejected).toEqual(OUT_OF_RANGE);
    expect(OUT_OF_RANGE.code).toBe("holidays.out_of_range");
    const { session } = await opened(f, doc);
    const broken = session.view().derived.conflicts.filter((c) => c.kind !== "dayoff");
    const first = only(broken);
    expect(first.kind === "early" && first.succ).toBe("B");
  });

  it("records the example plan as offered in every fixture but example, a first start with no plans whose one new plan doc loads empty", async () => {
    Object.entries(FIXTURES)
      .filter(([name]) => name !== "example")
      .forEach(([name, f]) => {
        expect(f.ipc.settings_read, name).toMatchObject({ exampleOffered: true });
        expect(f.newDoc, name).toBeUndefined();
      });
    const f = fixture("example");
    if (f.newDoc === undefined) throw new Error("the example fixture has no new doc");
    expect([...f.newDoc]).toEqual([...new Uint8Array(encodeLoad({ lastSeq: 0 }))]);
    expect(readFrame(f.newDoc)).toEqual({ flags: 0, lastSeq: 0, entries: [new Uint8Array()] });
    expect(f.ipc.settings_read).toEqual({ v: 1, lastRegion: { src: "openholidays", country: "CH", subdivision: "CH-ZH" }, names: {} });
    expect(Object.keys(f.docs)).toEqual(["local"]);
    expect({ ...f.ipc, settings_read: null }).toEqual({ ...fixture("empty").ipc, settings_read: null });
    const served: string[] = [];
    const answers = answersOf(f, served);
    const load = answers.store_load;
    if (load === undefined) throw new Error("no store_load answer");
    resetTauri(answers);
    const registry = await Registry.open({ clock: fixedClock("2026-11-09") });
    openRegistries.push(registry);
    const [only] = registry.plans();
    expect(registry.plans().map((p) => [p.name, p.trashed, p.space])).toEqual([["Example: Website relaunch", false, null]]);
    const view = (await registry.session(only.id)).view();
    expect(view.derived.conflicts).toEqual([]);
    expect(view.derived.missingYears).toEqual([]);
    expect(served).toEqual([only.id]);
    expect(() => load({ doc: "planOther01" })).toThrow("fixture has no doc planOther01");
    const fresh = answersOf(f).store_load;
    if (fresh === undefined) throw new Error("no store_load answer");
    ["ix-sp000000", "probe", "local-copy"].forEach((doc) => expect(() => fresh({ doc })).toThrow(`fixture has no doc ${doc}`));
    expect(() => answersOf(fixture("empty")).store_load?.({ doc: "planOther01" })).toThrow("fixture has no doc planOther01");
  });

  it("opens every plan through the Registry with the fixture's answers, the plan names cached", async () => {
    for (const [name, f] of Object.entries(FIXTURES).filter(([n]) => n !== "example")) {
      resetTauri(answersOf(f));
      setPlatform(f.platform);
      if (name === "mesa-ios-phone" || name === "mesa-steps-ios-phone" || name === "mesa-people-ios-phone" || name === "mesa-defaults-ios-phone") setScreen(390, 844);
      if (name === "mesa-ios-pad" || name === "mesa-steps-ios-pad" || name === "mesa-people-ios-pad" || name === "mesa-defaults-ios-pad") setScreen(834, 1194);
      const registry = await Registry.open({ clock: fixedClock("2026-11-09") });
      try {
        expect(registry.device.name).toBe(DEVICE_NAMES[name] ?? "Mac");
        if ("ix-sp000000000" in f.docs) await registry.attachSpace("sp000000000");
        expect(registry.plans().map((p) => p.id).sort()).toEqual(planDocs(f).sort());
        for (const doc of planDocs(f)) {
          const session = await registry.session(doc);
          expect(registry.plans().find((p) => p.id === doc)?.name).toBe(session.view().plan.name);
        }
      } finally {
        await registry.close();
      }
    }
  });

  it("encodes each cause letter and meta exactly as encodeAction does, and decodeAction reads them back", () => {
    const causes: Cause[] = ["own", "push", "recalendar", "undo", "revert", "resolution"];
    const base = { dev: "mac", ses: "sesMacSetup", at: 1_762_000_000_000, par: ["mesaM000000"], lbl: "Encoded" };
    const cases: Action[] = [
      ...causes.map((c, n): Action => ({ id: `enc${n}`, ...base, w: [{ u: `n:t${n}`, v: `name ${n}`, c }] })),
      { id: "encMeta", ...base, w: [{ u: "n:t9", v: "undone", c: "undo" }], meta: { undo: "mesaM000001" } },
    ];
    cases.forEach((a) => {
      const raw = encodeTuple(a);
      expect(raw).toEqual(encodeAction(a));
      const back = decodeAction(a.id, raw);
      expect(back.w.map((w) => w.c)).toEqual(a.w.map((w) => w.c));
      expect(back.meta).toEqual(a.meta);
      expect(back).toEqual(a);
    });
    expect(() => encodeTuple({ ...base, w: [{ u: "n:t1", v: "x", c: "bogus" }] })).toThrow("layout fixtures: unknown cause bogus");
  });

  it("orders siblings with keys up to 62 + 62x62 and refuses one past them", () => {
    expect(orderKey(0)).toBe("a0");
    expect(orderKey(61)).toBe("az");
    expect(orderKey(62)).toBe("b00");
    expect(orderKey(62 + 62 * 62 - 1)).toBe("bzz");
    expect(() => orderKey(62 + 62 * 62)).toThrow(`layout fixtures: orderKey ${62 + 62 * 62} out of range`);
  });

  it("answers holidays_year for CH-ZH 2026 and 2027 exactly as the plans store them", () => {
    const f = fixture("mesa");
    const d = decoded(f, only(planDocs(f)));
    const year = answerOf(ipcOf(f, "holidays_year"));
    [2026, 2027].forEach((y) => {
      const answer = year({ region: d.plan.calendar.region, year: y, fresh: false });
      const stored = d.plan.calendar.holidays.get(y);
      expect(isRecord(answer) && answer.days).toEqual(stored?.days);
      expect(stored?.region).toBe("oh:CH:CH-ZH");
    });
  });
});
