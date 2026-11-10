import * as Y from "yjs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InvokeArgs } from "@tauri-apps/api/core";
import { buildFixtures, encodeTuple, LONG_NAMES, orderKey, UNREADABLE_ID, UNREADABLE_LINE } from "../../scripts/layout-fixtures.mjs";
import { normalizeName } from "../actions/build";
import { LogState } from "../log/state";
import type { Action, Cause, DeviceId } from "../log/types";
import { choices, heldItems } from "../plan/choices";
import { projectPlan } from "../plan/project";
import { planRules } from "../plan/rules";
import { parseKey, validateWrite } from "../plan/units";
import { fixedClock } from "../services/clock";
import { decodeAction, encodeAction, PlanDoc } from "../store/doc";
import { Registry } from "../store/registry";
import { MESA_SEED } from "./session";
import { resetTauri, type Answer } from "./tauriMock";

vi.mock("@tauri-apps/api/core", () => import("./tauriMock"));

type Fixture = ReturnType<typeof buildFixtures>[string];

const FIXTURES = buildFixtures();

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
      return structuredClone(hit);
    }
    return structuredClone(value);
  };
}

function answersOf(f: Fixture): Record<string, Answer> {
  const docArg = (args: InvokeArgs | undefined): string => {
    if (!isRecord(args) || typeof args.doc !== "string") throw new Error("store_load without a doc");
    return args.doc;
  };
  return {
    ...Object.fromEntries(Object.entries(f.ipc).map(([cmd, v]) => [cmd, answerOf(v)])),
    store_load: (args) => {
      const bytes = f.docs[docArg(args)];
      if (bytes === undefined) throw new Error(`fixture has no doc ${docArg(args)}`);
      return bytes.slice().buffer;
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

const UNREADABLE_FIXTURES: ReadonlySet<string> = new Set(["unreadable", "sync-receiving"]);

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
      "blank-plan",
      "choices",
      "empty",
      "long-names",
      "mesa",
      "mesa-linux",
      "scale",
      "sync-dialog",
      "sync-receiving",
      "sync-removed",
      "sync-space",
      "two-choices",
      "unreadable",
    ]);
  });

  it("answers sync_status in every state, local only unless the state joins a space", () => {
    const joined = { space: { server: "https://probe.invalid", spaceId: "sp000000000", deviceId: "mac", deviceName: "Mac" }, revoked: false };
    const expected: Record<string, unknown> = { "sync-space": joined, "sync-receiving": joined, "sync-removed": { ...joined, revoked: true } };
    Object.entries(FIXTURES).forEach(([name, f]) => expect(f.ipc.sync_status, name).toEqual(expected[name] ?? { space: null, revoked: false }));
  });

  it("gives every space state its index doc and a ticket, and no other state either", () => {
    Object.entries(FIXTURES).forEach(([name, f]) => {
      const space = name === "sync-space" || name === "sync-receiving" || name === "sync-removed";
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

  it("opens every plan through the Registry with the fixture's answers, the plan names cached", async () => {
    for (const [name, f] of Object.entries(FIXTURES)) {
      resetTauri(answersOf(f));
      const registry = await Registry.open({ clock: fixedClock("2026-11-09") });
      try {
        expect(registry.device.name).toBe(name === "mesa-linux" ? "Linux" : "Mac");
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
