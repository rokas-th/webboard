import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import * as Y from "yjs";

import { buildFixtures } from "./layout-fixtures.mjs";
import { snapshotOf, unframe } from "./seed-store.mjs";

const TOOL = fileURLToPath(new URL("./seed-store.mjs", import.meta.url));

const docOf = (updates) => {
  const doc = new Y.Doc();
  updates.forEach((u) => Y.applyUpdate(doc, u));
  return doc;
};

const stateOf = (doc) => Object.fromEntries([...doc.share.keys()].sort().map((name) => [name, doc.getMap(name).toJSON()]));

const sameState = (actual, entries) => {
  const want = docOf(entries);
  const got = docOf([actual]);
  assert.ok(want.share.size > 0, "the expected doc holds no top-level type");
  assert.deepEqual([...got.share.keys()].sort(), [...want.share.keys()].sort());
  assert.deepEqual(stateOf(got), stateOf(want));
};

const frameOf = (entries, { flags = 0, lastSeq = entries.length } = {}) => {
  const out = new Uint8Array(13 + entries.reduce((n, e) => n + 4 + e.length, 0));
  const view = new DataView(out.buffer);
  view.setUint8(0, flags);
  view.setBigUint64(1, BigInt(lastSeq), true);
  view.setUint32(9, entries.length, true);
  entries.reduce((at, e) => {
    view.setUint32(at, e.length, true);
    out.set(e, at + 4);
    return at + 4 + e.length;
  }, 13);
  return out;
};

const twoUpdates = () => {
  const doc = new Y.Doc();
  const updates = [];
  doc.on("update", (u) => updates.push(u));
  doc.getMap("actions").set("a1", ["mac", "s1", 1, [], "Add item", []]);
  const notes = doc.getMap("notes");
  const text = new Y.Text();
  notes.set("Review", text);
  text.insert(0, "Bring the slides");
  doc.getMap("actions").set("a2", ["iphone", "s2", 2, ["a1"], "Rename", []]);
  return updates;
};

const tool = (args) => spawnSync(process.execPath, [TOOL, ...args], { encoding: "utf8" });

test("writes every doc of phone-choice as a seq 0 snapshot holding the frame's whole state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "seed-store-"));
  try {
    const run = tool(["phone-choice", dir]);
    assert.equal(run.status, 0, run.stderr);
    const fixture = buildFixtures()["phone-choice"];
    const docs = Object.keys(fixture.docs).sort();
    assert.deepEqual(docs, ["local", "planPhone01"]);
    assert.deepEqual((await readdir(join(dir, "docs"))).sort(), docs);
    for (const doc of docs) {
      assert.deepEqual(await readdir(join(dir, "docs", doc)), ["snapshot.bin"]);
      const bytes = await readFile(join(dir, "docs", doc, "snapshot.bin"));
      assert.equal(bytes.subarray(0, 4).toString("latin1"), "WBS1");
      assert.equal(bytes.readBigUInt64LE(4), 0n);
      sameState(bytes.subarray(12), unframe(doc, fixture.docs[doc]));
    }
    assert.deepEqual(run.stdout.trim().split("\n").sort(), docs.map((d) => join(dir, "docs", d, "snapshot.bin")).sort());
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("merges a multi-entry frame into one snapshot holding every entry's state", () => {
  const updates = twoUpdates();
  assert.ok(updates.length > 1);
  const bytes = Buffer.from(snapshotOf("planX", frameOf(updates)));
  assert.equal(bytes.subarray(0, 4).toString("latin1"), "WBS1");
  assert.equal(bytes.readBigUInt64LE(4), 0n);
  sameState(bytes.subarray(12), updates);
  assert.deepEqual(stateOf(docOf([bytes.subarray(12)])), {
    actions: { a1: ["mac", "s1", 1, [], "Add item", []], a2: ["iphone", "s2", 2, ["a1"], "Rename", []] },
    notes: { Review: "Bring the slides" },
  });
});

test("refuses a zero-length entry, an empty frame, a torn flag and a lastSeq off the entry count", () => {
  const [first, ...rest] = twoUpdates();
  assert.throws(() => snapshotOf("planX", frameOf([first, new Uint8Array(0), ...rest])), {
    message: `seed-store: doc planX: entry 1 of ${rest.length + 2} is empty`,
  });
  assert.throws(() => snapshotOf("planX", frameOf([new Uint8Array(0), first])), {
    message: "seed-store: doc planX: entry 0 of 2 is empty",
  });
  assert.throws(() => snapshotOf("planX", frameOf([])), { message: "seed-store: doc planX: the frame holds no entry" });
  assert.throws(() => snapshotOf("planX", frameOf([first], { flags: 1 })), {
    message: "seed-store: doc planX: flags are 1, expected 0 (a torn tail was repaired)",
  });
  assert.throws(() => snapshotOf("planX", frameOf([first], { lastSeq: 4 })), {
    message: "seed-store: doc planX: lastSeq is 4, expected the entry count 1",
  });
});

test("refuses an unknown fixture, missing arguments and an existing doc folder, before writing any doc", async () => {
  const dir = await mkdtemp(join(tmpdir(), "seed-store-"));
  try {
    const unknown = tool(["no-such-fixture", dir]);
    assert.notEqual(unknown.status, 0);
    assert.match(unknown.stderr, /no fixture no-such-fixture/);
    const usage = tool([]);
    assert.equal(usage.status, 2);
    assert.match(usage.stderr, /usage: node scripts\/seed-store.mjs <fixture> <dir>/);
    const order = Object.keys(buildFixtures()["phone-choice"].docs);
    assert.deepEqual(order, ["local", "planPhone01"]);
    await mkdir(join(dir, "docs", "planPhone01"), { recursive: true });
    const later = tool(["phone-choice", dir]);
    assert.notEqual(later.status, 0);
    assert.match(later.stderr, /seed-store: doc planPhone01: .*docs\/planPhone01 already exists/);
    assert.deepEqual((await readdir(join(dir, "docs"))).sort(), ["planPhone01"]);
    assert.deepEqual(await readdir(join(dir, "docs", "planPhone01")), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runs through a symlinked path", async () => {
  const dir = await mkdtemp(join(tmpdir(), "seed-store-"));
  try {
    const link = join(dir, "seed-link.mjs");
    await symlink(TOOL, link);
    const run = spawnSync(process.execPath, [link, "phone-choice", join(dir, "out")], { encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual((await readdir(join(dir, "out", "docs"))).sort(), ["local", "planPhone01"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
