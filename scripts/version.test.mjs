import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, cp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const TOOL = join(REPO, "scripts", "version.mjs");
const CURRENT = JSON.parse(await readFile(join(REPO, "package.json"), "utf8")).version;
const CURRENT_RE = CURRENT.replaceAll(".", "\\.");
const NEXT = `${Number(CURRENT.split(".")[0]) + 1}.0.0`;
const NEXT_RE = NEXT.replaceAll(".", "\\.");

const FILES = [
  "package.json",
  "package-lock.json",
  "Cargo.lock",
  "src-tauri/tauri.conf.json",
  "src-tauri/Cargo.toml",
  "crates/webboard-core/Cargo.toml",
  "server/package.json",
  "server/package-lock.json",
];

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "webboard-version-"));
  await Promise.all(
    FILES.map(async (rel) => {
      await mkdir(join(root, dirname(rel)), { recursive: true });
      await cp(join(REPO, rel), join(root, rel));
    }),
  );
  return root;
}

function version(root, args) {
  return spawnSync(process.execPath, [TOOL, "--root", root, ...args], { encoding: "utf8" });
}

async function edit(root, rel, from, to) {
  const abs = join(root, rel);
  const text = await readFile(abs, "utf8");
  assert.ok(text.includes(from), `${rel} does not contain ${from}`);
  await writeFile(abs, text.replace(from, to));
}

test("--check passes when the eleven agree", async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));

  const r = version(root, ["--check"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`11 places agree on ${CURRENT_RE}`));
});

test("--check fails and names the file when one field drifts", async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));

  await edit(root, "src-tauri/tauri.conf.json", `"version": "${CURRENT}"`, `"version": "0.0.9"`);

  const r = version(root, ["--check"]);
  assert.notEqual(r.status, 0, "a drifted field must not pass --check");
  assert.match(r.stdout, /! 0\.0\.9 {2}src-tauri\/tauri\.conf\.json \(version\)/);
  assert.match(r.stderr, /1 of 11 places disagree/);
});

test("--check <semver> rejects a tree that agrees on the wrong version", async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));

  const r = version(root, ["--check", NEXT]);
  assert.notEqual(r.status, 0, `11 agreeing on ${CURRENT} is not ${NEXT}`);
  assert.match(r.stderr, new RegExp(`expected ${NEXT_RE}`));
});

test("writing sets the five sources and leaves the lockfiles for the regeneration", async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));

  const w = version(root, [NEXT, "--no-lock"]);
  assert.equal(w.status, 0, w.stderr);
  assert.equal((w.stdout.match(new RegExp(`${CURRENT_RE} -> ${NEXT_RE}`, "g")) ?? []).length, 5);

  for (const rel of ["package.json", "src-tauri/tauri.conf.json", "server/package.json"]) {
    assert.match(await readFile(join(root, rel), "utf8"), new RegExp(`"version": "${NEXT_RE}"`));
  }
  for (const rel of ["src-tauri/Cargo.toml", "crates/webboard-core/Cargo.toml"]) {
    assert.match(await readFile(join(root, rel), "utf8"), new RegExp(`\nversion = "${NEXT_RE}"`));
  }
  for (const rel of ["Cargo.lock", "package-lock.json", "server/package-lock.json"]) {
    assert.equal(await readFile(join(root, rel), "utf8"), await readFile(join(REPO, rel), "utf8"));
  }

  const c = version(root, ["--check"]);
  assert.notEqual(c.status, 0, "a stale lockfile must fail --check");
  assert.match(c.stderr, /6 of 11 places disagree/);
});

test("--check names server/package.json when only it is bumped", async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));

  await edit(root, "server/package.json", `"version": "${CURRENT}"`, `"version": "0.1.1"`);

  const r = version(root, ["--check"]);
  assert.notEqual(r.status, 0, "a bumped server/package.json must not pass --check");
  assert.match(r.stdout, /! 0\.1\.1 {2}server\/package\.json \(version\)/);
  assert.match(r.stderr, /1 of 11 places disagree/);
});

test("a value the tool cannot read fails loudly instead of reading as up to date", async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));

  await edit(root, "src-tauri/Cargo.toml", `\nversion = "${CURRENT}"`, `\nversion = "${CURRENT}-rc1"`);

  const r = version(root, ["--check"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /src-tauri\/Cargo\.toml: no \[package\] version matched/);
});

test("a value that matches twice fails loudly instead of picking one", async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));

  const lock = await readFile(join(root, "Cargo.lock"), "utf8");
  await writeFile(join(root, "Cargo.lock"), `${lock}\n[[package]]\nname = "webboard"\nversion = "${CURRENT}"\n`);

  const r = version(root, ["--check"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Cargo\.lock: package "webboard" matched more than once/);
});

test("a missing file is named, not skipped", async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));

  await rm(join(root, "Cargo.lock"));

  const r = version(root, ["--check"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /no such file: .*Cargo\.lock/);
});
