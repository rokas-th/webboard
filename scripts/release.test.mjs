import { test } from "node:test";
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readdir, readFile, rename, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { gzipSync } from "node:zlib";

import { tarEntries, tarNames } from "./release.mjs";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const TOOL = join(REPO, "scripts", "release.mjs");
const TAURI = join(REPO, "node_modules", ".bin", "tauri");
const CURRENT = JSON.parse(await readFile(join(REPO, "package.json"), "utf8")).version;
const [MAJOR, MINOR, PATCH] = CURRENT.split(".").map(Number);
const NEXT = `${MAJOR}.${MINOR}.${PATCH + 1}`;
const PASSWORD = "release-test-password";
const MAC = join("target", "release", "bundle", "macos");
const DEB = join("target", "release", "bundle", "deb");
const RELEASES = join("server", "public", "releases");
const TARBALL = `WebBoard_${CURRENT}_aarch64.app.tar.gz`;
const DEB_NAME = `WebBoard_${CURRENT}_amd64.deb`;
const RFC3339_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

const VERSION_FILES = [
  "package.json",
  "package-lock.json",
  "Cargo.lock",
  "src-tauri/tauri.conf.json",
  "src-tauri/Cargo.toml",
  "crates/webboard-core/Cargo.toml",
  "server/package.json",
  "server/package-lock.json",
  "src-tauri/gen/apple/project.yml",
];

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", ...opts });
  if (r.error !== undefined) throw r.error;
  return r;
}

function must(cmd, args, opts = {}) {
  const r = run(cmd, args, opts);
  assert.equal(r.status, 0, `${cmd} ${args.join(" ")} failed: ${r.stderr}`);
  return r;
}

const SCRATCH = await mkdtemp(join(tmpdir(), "webboard-release-keys-"));

async function keypair(name) {
  const path = join(SCRATCH, name);
  must(TAURI, ["signer", "generate", "--ci", "-p", PASSWORD, "-w", path], { input: "" });
  return { path, pub: (await readFile(`${path}.pub`, "utf8")).trim() };
}

const KEY = await keypair("k");
const OTHER = await keypair("other");

test.after(async () => {
  await rm(SCRATCH, { recursive: true, force: true });
});

function sign(key, file) {
  must(TAURI, ["signer", "sign", "-f", key.path, "-p", PASSWORD, file], { input: "" });
}

function release(root, ...args) {
  return run(process.execPath, [TOOL, ...args, "--root", root]);
}

async function appTree(dir, version) {
  await mkdir(join(dir, "WebBoard.app", "Contents", "MacOS"), { recursive: true });
  await writeFile(
    join(dir, "WebBoard.app", "Contents", "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n<dict>\n\t<key>CFBundleShortVersionString</key>\n\t<string>${version}</string>\n</dict>\n</plist>\n`,
  );
  await writeFile(join(dir, "WebBoard.app", "Contents", "MacOS", "webboard"), "binary");
}

async function tarOf(out, dir, entries) {
  must("tar", ["-czf", out, "-C", dir, ...entries], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
}

const ROOTS = [];

test.after(async () => {
  await Promise.all(ROOTS.map((r) => rm(r, { recursive: true, force: true })));
});

async function project(o = {}) {
  const root = await mkdtemp(join(tmpdir(), "webboard-release-"));
  ROOTS.push(root);
  await Promise.all(
    VERSION_FILES.map(async (rel) => {
      await mkdir(join(root, dirname(rel)), { recursive: true });
      await cp(join(REPO, rel), join(root, rel));
    }),
  );
  const confPath = join(root, "src-tauri", "tauri.conf.json");
  const conf = JSON.parse(await readFile(confPath, "utf8"));
  conf.plugins.updater.pubkey = o.pubkey ?? KEY.pub;
  await writeFile(confPath, JSON.stringify(conf, null, 2));
  const mac = join(root, MAC);
  const deb = join(root, DEB);
  await mkdir(mac, { recursive: true });
  await mkdir(deb, { recursive: true });
  const stage = join(root, "stage");
  await appTree(stage, CURRENT);
  const tarball = join(mac, o.tarballName ?? TARBALL);
  await tarOf(tarball, stage, ["WebBoard.app"]);
  const debFile = join(deb, o.debName ?? DEB_NAME);
  await writeFile(debFile, "!<arch>\ndebian-binary   fixture\n");
  sign(KEY, tarball);
  sign(o.debKey ?? KEY, debFile);
  return { root, tarball, deb: debFile, releases: join(root, RELEASES) };
}

const failsWith = (r, ...parts) => {
  assert.equal(r.status, 1, `expected exit 1, got ${r.status}: ${r.stdout}${r.stderr}`);
  parts.forEach((p) => assert.ok(r.stderr.includes(p), `stderr lacks ${JSON.stringify(p)}:\n${r.stderr}`));
};

test("manifest writes latest.json with exactly two platforms, copies both artifacts and the first-install .deb", async () => {
  const p = await project();
  const r = release(p.root, "manifest", CURRENT, "--notes", "Faster timeline.");
  assert.equal(r.status, 0, r.stderr);
  const latest = JSON.parse(await readFile(join(p.releases, "latest.json"), "utf8"));
  assert.deepEqual(Object.keys(latest), ["version", "notes", "pub_date", "platforms"]);
  assert.equal(latest.version, CURRENT);
  assert.equal(latest.notes, "Faster timeline.");
  assert.match(latest.pub_date, RFC3339_UTC);
  assert.ok(Math.abs(Date.parse(latest.pub_date) - Date.now()) < 60_000);
  assert.deepEqual(latest.platforms, {
    "darwin-aarch64": {
      signature: (await readFile(`${p.tarball}.sig`, "utf8")).trim(),
      url: `https://webboard.rokass.org/releases/${CURRENT}/${TARBALL}`,
    },
    "linux-x86_64-deb": {
      signature: (await readFile(`${p.deb}.sig`, "utf8")).trim(),
      url: `https://webboard.rokass.org/releases/${CURRENT}/${DEB_NAME}`,
    },
  });
  assert.deepEqual((await readdir(join(p.releases, CURRENT))).sort(), [DEB_NAME, TARBALL].sort());
  assert.deepEqual(await readFile(join(p.releases, CURRENT, TARBALL)), await readFile(p.tarball));
  assert.deepEqual(await readFile(join(p.releases, CURRENT, DEB_NAME)), await readFile(p.deb));
  assert.deepEqual(await readFile(join(p.releases, "WebBoard_amd64.deb")), await readFile(p.deb));
  assert.deepEqual((await readdir(p.releases)).sort(), [CURRENT, "WebBoard_amd64.deb", "latest.json"].sort());
});

test("manifest keeps the new version and the one before it, and deletes older ones", async () => {
  const p = await project();
  await Promise.all(
    ["0.0.1", "0.0.2", "0.0.10"].map(async (v) => {
      await mkdir(join(p.releases, v), { recursive: true });
      await writeFile(join(p.releases, v, "old.bin"), v);
    }),
  );
  assert.ok(MAJOR > 0 || MINOR > 0, "the repo version must be above 0.0.x for this fixture");
  const r = release(p.root, "manifest", CURRENT, "--notes", "n");
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual((await readdir(p.releases)).sort(), ["0.0.10", CURRENT, "WebBoard_amd64.deb", "latest.json"].sort());
  assert.equal(await readFile(join(p.releases, "0.0.10", "old.bin"), "utf8"), "0.0.10");
});

test("manifest refuses when releases already holds a newer version", async () => {
  const p = await project();
  await mkdir(join(p.releases, NEXT), { recursive: true });
  failsWith(release(p.root, "manifest", CURRENT, "--notes", "n"), `already holds ${NEXT}, newer than ${CURRENT}`);
});

test("a missing .sig names the file and owner step R2", async () => {
  const p = await project();
  await rm(`${p.deb}.sig`);
  failsWith(release(p.root, "manifest", CURRENT, "--notes", "n"), `${p.deb}.sig is missing`, `run owner step R2: npx tauri signer sign -f ~/.tauri/webboard.key ${p.deb}`);
});

test("a .sig made with another key than tauri.conf.json's pubkey is refused by key id", async () => {
  const p = await project({ debKey: OTHER });
  failsWith(release(p.root, "manifest", CURRENT, "--notes", "n"), `${p.deb}.sig was signed with key`, "but the pubkey in src-tauri/tauri.conf.json is key", "owner step R2");
});

function rewriteSig(file, edit) {
  return readFile(file, "utf8").then((text) => {
    const lines = Buffer.from(text.trim(), "base64").toString("utf8").split("\n");
    return writeFile(file, Buffer.from(edit(lines).join("\n")).toString("base64"));
  });
}

test("a .sig of another file made with the right key is refused, naming both files and owner step R2", async () => {
  const p = await project();
  const other = join(p.root, "other.deb");
  await writeFile(other, "!<arch>\nanother build\n");
  sign(KEY, other);
  await cp(`${other}.sig`, `${p.deb}.sig`);
  failsWith(release(p.root, "manifest", CURRENT, "--notes", "n"), `${p.deb}.sig is not a signature of ${p.deb}`, `run owner step R2: npx tauri signer sign -f ~/.tauri/webboard.key ${p.deb}`);
  assert.equal(await readdir(p.releases).catch((e) => e.code), "ENOENT");
});

test("a .sig whose trusted comment was edited is refused", async () => {
  const p = await project();
  await rewriteSig(`${p.tarball}.sig`, (lines) => lines.map((l) => (l.startsWith("trusted comment: ") ? `${l}x` : l)));
  failsWith(release(p.root, "manifest", CURRENT, "--notes", "n"), `${p.tarball}.sig`, "trusted comment", "owner step R2");
});

test("a .sig in another minisign algorithm than the prehashed ED is refused, naming it", async () => {
  const p = await project();
  await rewriteSig(`${p.deb}.sig`, (lines) => {
    const raw = Buffer.from(lines[1], "base64");
    raw.write("Ed", 0, "latin1");
    return [lines[0], raw.toString("base64"), ...lines.slice(2)];
  });
  failsWith(release(p.root, "manifest", CURRENT, "--notes", "n"), `${p.deb}.sig uses the minisign algorithm "Ed"`, '"ED"');
});

test("manifest clears an earlier attempt's files from releases/<v>/", async () => {
  const p = await project();
  await mkdir(join(p.releases, CURRENT), { recursive: true });
  await writeFile(join(p.releases, CURRENT, "WebBoard_0.0.9_amd64.deb"), "from an earlier attempt");
  const r = release(p.root, "manifest", CURRENT, "--notes", "n");
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual((await readdir(join(p.releases, CURRENT))).sort(), [DEB_NAME, TARBALL].sort());
});

test("an empty pubkey is refused and names owner step R1", async () => {
  const p = await project({ pubkey: "" });
  failsWith(release(p.root, "manifest", CURRENT, "--notes", "n"), "plugins.updater.pubkey", "is empty: run owner step R1");
});

test("a version other than version:check's is refused", async () => {
  const p = await project();
  failsWith(release(p.root, "manifest", NEXT, "--notes", "n"), `${NEXT} is not the version every place`, `node scripts/version.mjs ${NEXT}`);
});

test("an artifact whose name carries another version is refused", async () => {
  const p = await project();
  const renamed = join(dirname(p.deb), `WebBoard_${NEXT}_amd64.deb`);
  await rename(p.deb, renamed);
  await rename(`${p.deb}.sig`, `${renamed}.sig`);
  failsWith(release(p.root, "manifest", CURRENT, "--notes", "n"), `${renamed} is version ${NEXT}, not ${CURRENT}`);
  const q = await project({ tarballName: `WebBoard_${NEXT}_aarch64.app.tar.gz` });
  failsWith(release(q.root, "manifest", CURRENT, "--notes", "n"), `WebBoard_${NEXT}_aarch64.app.tar.gz is version ${NEXT}, not ${CURRENT}`);
});

test("an artifact over 25 MiB is refused", async () => {
  const p = await project();
  await truncate(p.deb, 25 * 1024 * 1024 + 1);
  failsWith(release(p.root, "manifest", CURRENT, "--notes", "n"), `${p.deb} is ${25 * 1024 * 1024 + 1} bytes, over the 25 MiB`);
});

test("a tarball whose top-level entry is not WebBoard.app/ is refused", async () => {
  const p = await project();
  const stage = join(p.root, "other");
  await mkdir(join(stage, "Other.app"), { recursive: true });
  await writeFile(join(stage, "Other.app", "x"), "x");
  await appTree(stage, CURRENT);
  await tarOf(p.tarball, stage, ["WebBoard.app", "Other.app"]);
  sign(KEY, p.tarball);
  failsWith(release(p.root, "manifest", CURRENT, "--notes", "n"), `${p.tarball} holds Other.app/`, "node scripts/release.mjs tarball");
});

test("a tarball holding an AppleDouble ._ entry is refused", async () => {
  const p = await project();
  const stage = join(p.root, "doubled");
  await appTree(stage, CURRENT);
  await writeFile(join(stage, "WebBoard.app", "Contents", "._Info.plist"), "appledouble");
  await tarOf(p.tarball, stage, ["WebBoard.app"]);
  sign(KEY, p.tarball);
  failsWith(release(p.root, "manifest", CURRENT, "--notes", "n"), "AppleDouble entry WebBoard.app/Contents/._Info.plist");
});

test("two .deb files are refused rather than guessed between", async () => {
  const p = await project();
  await writeFile(join(dirname(p.deb), "WebBoard_0.0.1_amd64.deb"), "old");
  failsWith(release(p.root, "manifest", CURRENT, "--notes", "n"), "holds 2 .deb files", "remove all but the one to publish");
});

test("manifest needs notes and a version", async () => {
  const p = await project();
  failsWith(release(p.root, "manifest", CURRENT), "manifest needs --notes");
  failsWith(release(p.root, "manifest", "--notes", "n"), "usage: node scripts/release.mjs manifest");
});

const onMac = { skip: process.platform !== "darwin" ? "tarball packs with the Mac's bsdtar" : false };

test("tarball packs the built WebBoard.app as the single top-level entry with no AppleDouble entries", onMac, async (t) => {
  const p = await project();
  await rm(p.tarball);
  await rm(`${p.tarball}.sig`);
  await writeFile(join(p.root, MAC, "WebBoard_0.0.1_aarch64.app.tar.gz"), "old");
  await writeFile(join(p.root, MAC, "WebBoard_0.0.1_aarch64.app.tar.gz.sig"), "old");
  await appTree(join(p.root, MAC), CURRENT);
  const marked = join(p.root, MAC, "WebBoard.app", "Contents", "MacOS", "webboard");
  must("xattr", ["-w", "org.rokass.webboard.test", "marked", marked]);
  const plain = join(p.root, "plain.tar.gz");
  must("/usr/bin/tar", ["-czf", plain, "-C", join(p.root, MAC), "WebBoard.app"]);
  const plainList = tarNames(await readFile(plain));
  assert.ok(plainList.includes("WebBoard.app/Contents/MacOS/._webboard"), `plain bsdtar wrote no ._ entry for the marked file, so this test proves nothing: ${plainList.join(", ")}`);
  t.diagnostic(
    must("tar", ["-tzf", plain]).stdout.includes("._")
      ? "note: this host's tar -t lists ._ entries"
      : "note: this host's tar -t hides the ._ entries tarNames reads, which is why release.mjs reads the headers itself",
  );

  const r = release(p.root, "tarball");
  assert.equal(r.status, 0, r.stderr);
  const out = join(p.root, MAC, TARBALL);
  const list = tarNames(await readFile(out));
  assert.ok(list.length >= 3);
  assert.equal(list[0].replace(/\/$/, ""), "WebBoard.app");
  assert.deepEqual(list.filter((e) => e !== "WebBoard.app/" && !e.startsWith("WebBoard.app/")), []);
  assert.deepEqual(list.filter((e) => e.split("/").some((part) => part.startsWith("._"))), []);
  assert.ok(list.includes("WebBoard.app/Contents/MacOS/webboard"));
  assert.deepEqual((await readdir(join(p.root, MAC))).filter((n) => n.endsWith(".tar.gz") || n.endsWith(".sig")), [TARBALL]);
});

test("tarball refuses a built app whose version is not the repo's", onMac, async () => {
  const p = await project();
  await appTree(join(p.root, MAC), NEXT);
  failsWith(release(p.root, "tarball"), `is version ${NEXT}, but the repo is ${CURRENT}`);
});

test("tarNames reads every header name, pax and ustar alike", async () => {
  const dir = await mkdtemp(join(tmpdir(), "webboard-tarnames-"));
  ROOTS.push(dir);
  const deep = join(dir, "WebBoard.app", "Contents", "Resources", "a".repeat(90), "b".repeat(90));
  await mkdir(deep, { recursive: true });
  await writeFile(join(deep, "c".repeat(60)), "x");
  const out = join(dir, "t.tar.gz");
  must("tar", ["-czf", out, "-C", dir, "WebBoard.app"]);
  const names = tarNames(await readFile(out));
  assert.ok(names.includes(`WebBoard.app/Contents/Resources/${"a".repeat(90)}/${"b".repeat(90)}/${"c".repeat(60)}`), names.join("\n"));
});

const GNU_MAGIC = "ustar  \0";
const USTAR_MAGIC = "ustar\u000000";

function header({ name, size, magic, at345 = "" }) {
  const b = Buffer.alloc(512);
  b.write(name, 0, "latin1");
  b.write("0000644\0", 100, "latin1");
  b.write("0000000\0", 108, "latin1");
  b.write("0000000\0", 116, "latin1");
  b.write(typeof size === "string" ? size : `${size.toString(8).padStart(11, "0")}\0`, 124, "latin1");
  b.write("15100000000\0", 136, "latin1");
  b.write("        ", 148, "latin1");
  b.write("0", 156, "latin1");
  b.write(magic, 257, "latin1");
  b.write(at345, 345, "latin1");
  const sum = b.reduce((a, x) => a + x, 0);
  b.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "latin1");
  return b;
}

const archive = (...blocks) => gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
const body = (text) => Buffer.concat([Buffer.from(text), Buffer.alloc(512 - text.length)]);

test("tarNames reads the ustar prefix, and ignores what a GNU header keeps at the same offset", () => {
  assert.deepEqual(tarNames(archive(header({ name: "webboard", size: 0, magic: USTAR_MAGIC, at345: "WebBoard.app/Contents/MacOS" }))), ["WebBoard.app/Contents/MacOS/webboard"]);
  assert.deepEqual(tarNames(archive(header({ name: "WebBoard.app/Contents/MacOS/webboard", size: 0, magic: GNU_MAGIC, at345: "15100000000\0" }))), ["WebBoard.app/Contents/MacOS/webboard"]);
});

test("tarNames refuses a size field that is not all octal digits, naming the byte offset and the field", () => {
  const good = header({ name: "WebBoard.app/a", size: 1, magic: USTAR_MAGIC });
  const corrupt = header({ name: "WebBoard.app/b", size: "0000000001x\0", magic: USTAR_MAGIC });
  assert.throws(() => tarNames(archive(good, body("a"), corrupt, body("b"))), { message: 'tar entry at byte 1024 has the size field "0000000001x", which is not octal digits' });
  const padded = header({ name: "WebBoard.app/c", size: " 0000000001 ", magic: USTAR_MAGIC });
  assert.deepEqual(tarNames(archive(padded, body("c"))), ["WebBoard.app/c"]);
});

test("tarEntries lets a file system error through as itself; only a parse error is called not a tarball", async () => {
  const dir = await mkdtemp(join(tmpdir(), "webboard-tarentries-"));
  ROOTS.push(dir);
  await assert.rejects(tarEntries(dir), (e) => e.code === "EISDIR" && !e.message.includes("gzip tarball"));
  await assert.rejects(tarEntries(join(dir, "missing.tar.gz")), (e) => e.code === "ENOENT" && !e.message.includes("gzip tarball"));
  const junk = join(dir, "junk.tar.gz");
  await writeFile(junk, "not gzip");
  await assert.rejects(tarEntries(junk), { message: new RegExp(`^${junk.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")} is not a gzip tarball WebBoard can read: `) });
});
