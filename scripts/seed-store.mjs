import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { argv, exit, stderr, stdout } from "node:process";
import { fileURLToPath } from "node:url";
import * as Y from "yjs";
import { buildFixtures } from "./layout-fixtures.mjs";

const MAGIC = new TextEncoder().encode("WBS1");

export function unframe(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 13) throw new Error(`seed-store: a store_load frame needs 13 header bytes, this one has ${bytes.length}`);
  const count = view.getUint32(9, true);
  const entries = [];
  let at = 13;
  for (let i = 0; i < count; i += 1) {
    if (at + 4 > bytes.length) throw new Error(`seed-store: entry ${i} of ${count} starts past the end of the frame`);
    const len = view.getUint32(at, true);
    if (at + 4 + len > bytes.length) throw new Error(`seed-store: entry ${i} of ${count} runs past the end of the frame`);
    entries.push(bytes.subarray(at + 4, at + 4 + len));
    at += 4 + len;
  }
  if (at !== bytes.length) throw new Error(`seed-store: ${bytes.length - at} bytes follow the last entry of the frame`);
  return entries;
}

export function snapshotOf(frame) {
  const updates = unframe(frame).filter((e) => e.length > 0);
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
  await mkdir(docs, { recursive: true });
  const written = [];
  for (const [doc, frame] of Object.entries(fixture.docs)) {
    const target = join(docs, doc);
    await mkdir(target);
    await writeFile(join(target, "snapshot.bin"), snapshotOf(frame));
    written.push(join(target, "snapshot.bin"));
  }
  return written;
}

if (argv[1] === fileURLToPath(import.meta.url)) {
  const [fixtureName, dir] = argv.slice(2);
  if (fixtureName === undefined || dir === undefined) {
    stderr.write("usage: node scripts/seed-store.mjs <fixture> <dir>\n");
    exit(2);
  }
  const written = await seedStore(fixtureName, dir);
  written.forEach((path) => stdout.write(`${path}\n`));
}
