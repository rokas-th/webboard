import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeNew } from "./write-new.mjs";

const BYTES = new Uint8Array([1, 2, 3, 4]);

const dir = () => mkdtempSync(join(tmpdir(), "write-new-"));

test("writes the bytes, checks the written file and leaves only the output", () => {
  const d = dir();
  const out = join(d, "plan.webboard");
  const seen = [];
  writeNew(out, BYTES, (bytes) => seen.push([...bytes]));
  assert.deepEqual([...readFileSync(out)], [...BYTES]);
  assert.deepEqual(seen, [[...BYTES]]);
  assert.deepEqual(readdirSync(d), ["plan.webboard"]);
});

test("checks a temp file in the output's directory, not the output", () => {
  const d = dir();
  const out = join(d, "plan.webboard");
  let checked;
  writeNew(out, BYTES, () => {
    checked = readdirSync(d);
  });
  assert.equal(checked.length, 1);
  assert.match(checked[0], /^\.plan\.webboard\.\d+\.tmp$/);
});

test("removes the temp file and writes nothing when the check fails", () => {
  const d = dir();
  const out = join(d, "plan.webboard");
  const failure = new Error("reads back wrong");
  assert.throws(
    () =>
      writeNew(out, BYTES, () => {
        throw failure;
      }),
    (e) => e === failure,
  );
  assert.deepEqual(readdirSync(d), []);
});

test("never overwrites an existing output and removes its temp file", () => {
  const d = dir();
  const out = join(d, "plan.webboard");
  writeFileSync(out, "keep");
  assert.throws(() => writeNew(out, BYTES, () => {}), { code: "EEXIST", syscall: "link" });
  assert.equal(readFileSync(out, "utf8"), "keep");
  assert.deepEqual(readdirSync(d), ["plan.webboard"]);
});

test("leaves a temp file it did not create alone", () => {
  const d = dir();
  const out = join(d, "plan.webboard");
  const temp = join(d, `.plan.webboard.${process.pid}.tmp`);
  writeFileSync(temp, "someone else's");
  assert.throws(() => writeNew(out, BYTES, () => {}), { code: "EEXIST", syscall: "open" });
  assert.equal(readFileSync(temp, "utf8"), "someone else's");
  assert.deepEqual(readdirSync(d), [`.plan.webboard.${process.pid}.tmp`]);
});

test("throws both errors when removing the temp file fails too", () => {
  const d = dir();
  const out = join(d, "plan.webboard");
  const failure = new Error("reads back wrong");
  const removal = new Error("cannot unlink");
  const broken = {
    ...fs,
    unlinkSync: () => {
      throw removal;
    },
  };
  assert.throws(
    () =>
      writeNew(
        out,
        BYTES,
        () => {
          throw failure;
        },
        broken,
      ),
    (e) => e instanceof AggregateError && e.errors[0] === failure && e.errors[1] === removal && /reads back wrong/.test(e.message) && e.message.includes(".tmp"),
  );
  assert.deepEqual(readdirSync(d), [`.plan.webboard.${process.pid}.tmp`]);
});
