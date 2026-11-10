import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import * as Y from "yjs";

import { buildFixtures } from "./layout-fixtures.mjs";
import { unframe } from "./seed-store.mjs";

const TOOL = fileURLToPath(new URL("./seed-store.mjs", import.meta.url));

const actionsOf = (update) => {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, update);
  return Object.fromEntries([...doc.getMap("actions").entries()]);
};

test("writes every doc of phone-choice as a seq 0 snapshot holding the fixture's actions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "seed-store-"));
  try {
    const run = spawnSync(process.execPath, [TOOL, "phone-choice", dir], { encoding: "utf8" });
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
      const [expected] = unframe(fixture.docs[doc]);
      assert.deepEqual(actionsOf(bytes.subarray(12)), actionsOf(expected));
    }
    assert.deepEqual(run.stdout.trim().split("\n").sort(), docs.map((d) => join(dir, "docs", d, "snapshot.bin")).sort());
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("refuses an unknown fixture and a doc folder that already exists", async () => {
  const dir = await mkdtemp(join(tmpdir(), "seed-store-"));
  try {
    const unknown = spawnSync(process.execPath, [TOOL, "no-such-fixture", dir], { encoding: "utf8" });
    assert.notEqual(unknown.status, 0);
    assert.match(unknown.stderr, /no fixture no-such-fixture/);
    assert.equal(spawnSync(process.execPath, [TOOL, "phone-choice", dir], { encoding: "utf8" }).status, 0);
    const again = spawnSync(process.execPath, [TOOL, "phone-choice", dir], { encoding: "utf8" });
    assert.notEqual(again.status, 0);
    assert.match(again.stderr, /EEXIST/);
    const usage = spawnSync(process.execPath, [TOOL], { encoding: "utf8" });
    assert.equal(usage.status, 2);
    assert.match(usage.stderr, /usage: node scripts\/seed-store.mjs <fixture> <dir>/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
