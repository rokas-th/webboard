import { existsSync, realpathSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { argv, exit, stderr, stdout } from "node:process";
import { fileURLToPath } from "node:url";
import * as Y from "yjs";
import { buildFixtures } from "./layout-fixtures.mjs";

const MAGIC = new TextEncoder().encode("WBS1");

export function unframe(doc, bytes) {
  const fail = (what) => new Error(`seed-store: doc ${doc}: ${what}`);
  if (bytes.length < 13) throw fail(`a store_load frame needs 13 header bytes, this one has ${bytes.length}`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const flags = view.getUint8(0);
  const lastSeq = view.getBigUint64(1, true);
  const count = view.getUint32(9, true);
  if (flags !== 0) throw fail(`flags are ${flags}, expected 0 (a torn tail was repaired)`);
  if (count === 0) throw fail("the frame holds no entry");
  if (lastSeq !== BigInt(count)) throw fail(`lastSeq is ${lastSeq}, expected the entry count ${count}`);
  const entries = [];
  let at = 13;
  for (let i = 0; i < count; i += 1) {
    if (at + 4 > bytes.length) throw fail(`entry ${i} of ${count} starts past the end of the frame`);
    const len = view.getUint32(at, true);
    if (len === 0) throw fail(`entry ${i} of ${count} is empty`);
    if (at + 4 + len > bytes.length) throw fail(`entry ${i} of ${count} runs past the end of the frame`);
    entries.push(bytes.subarray(at + 4, at + 4 + len));
    at += 4 + len;
  }
  if (at !== bytes.length) throw fail(`${bytes.length - at} bytes follow the last entry of the frame`);
  return entries;
}

export function snapshotOf(doc, frame) {
  const updates = unframe(doc, frame);
  const body = updates.length === 1 ? updates[0] : Y.mergeUpdates(updates);
  const out = new Uint8Array(12 + body.length);
  out.set(MAGIC, 0);
  new DataView(out.buffer).setBigUint64(4, 0n, true);
  out.set(body, 12);
  return out;
}

export async function seedStore(fixtureName, dir) {
  const fixtures = buildFixtures();
  const fixture = fixtures[fixtureName];
  if (fixture === undefined) throw new Error(`seed-store: no fixture ${fixtureName}; the fixtures are ${Object.keys(fixtures).sort().join(", ")}`);
  const docs = join(dir, "docs");
  const plan = Object.entries(fixture.docs).map(([doc, frame]) => ({ doc, target: join(docs, doc), snapshot: snapshotOf(doc, frame) }));
  const taken = plan.find((p) => existsSync(p.target));
  if (taken !== undefined) throw new Error(`seed-store: doc ${taken.doc}: ${taken.target} already exists; nothing was written`);
  await mkdir(docs, { recursive: true });
  for (const p of plan) {
    await mkdir(p.target);
    await writeFile(join(p.target, "snapshot.bin"), p.snapshot);
  }
  return plan.map((p) => join(p.target, "snapshot.bin"));
}

if (argv[1] !== undefined && realpathSync(argv[1]) === fileURLToPath(import.meta.url)) {
  const [fixtureName, dir] = argv.slice(2);
  if (fixtureName === undefined || dir === undefined) {
    stderr.write("usage: node scripts/seed-store.mjs <fixture> <dir>\n");
    exit(2);
  }
  const written = await seedStore(fixtureName, dir);
  written.forEach((path) => stdout.write(`${path}\n`));
}
