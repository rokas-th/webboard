import { realpathSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createHash, createPublicKey, verify } from "node:crypto";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { basename, join } from "node:path";

const SEMVER = /^\d+\.\d+\.\d+$/;
const LIMIT = 25 * 1024 * 1024;
const BASE_URL = "https://webboard.rokass.org/releases";
const LIVE = `${BASE_URL}/latest.json`;
const FIRST_INSTALL = "WebBoard_amd64.deb";
const APP = "WebBoard.app";
const MAC_DIR = join("target", "release", "bundle", "macos");
const DEB_DIR = join("target", "release", "bundle", "deb");
const RELEASES = join("server", "public", "releases");
const CONF = join("src-tauri", "tauri.conf.json");
const VERSION_TOOL = fileURLToPath(new URL("./version.mjs", import.meta.url));
const USAGE = 'usage: node scripts/release.mjs tarball | manifest <major.minor.patch> --notes "<text>" | check [<major.minor.patch>]';
const CHECK_USAGE = "usage: node scripts/release.mjs check [<major.minor.patch>]: the version this deploy publishes, or none for a deploy that publishes no release";
const PUBLISH_HINT = "a deploy that publishes a release passes its version instead: node scripts/release.mjs check <major.minor.patch>";
const SIGN = (file) => `run owner step R2: npx tauri signer sign -f ~/.tauri/webboard.key ${file}`;

class ReleaseError extends Error {}

/** @param {string} message @returns {never} */
function fail(message) {
  throw new ReleaseError(message);
}

/** @param {string} a @param {string} b */
function compareVersions(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  const i = pa.findIndex((n, k) => n !== pb[k]);
  return i === -1 ? 0 : pa[i] - pb[i];
}

/** @param {string[]} argv */
function parse(argv) {
  const opts = { command: null, version: null, notes: null, root: null, live: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--notes" || a === "--root" || a === "--live") {
      i += 1;
      const value = argv[i];
      if (value === undefined) fail(`${a} needs a value`);
      if (a === "--notes") opts.notes = value;
      else if (a === "--root") opts.root = value;
      else opts.live = value;
    } else if (a.startsWith("-")) fail(`unknown option ${a}`);
    else if (opts.command === null) opts.command = a;
    else if ((opts.command === "manifest" || opts.command === "check") && opts.version === null) opts.version = a;
    else fail(`unexpected argument ${a}`);
  }
  if (opts.live !== null && opts.command !== "check") fail("only check takes --live");
  if (opts.command === "manifest") {
    if (opts.version === null || !SEMVER.test(opts.version)) fail('usage: node scripts/release.mjs manifest <major.minor.patch> --notes "<text>"');
    if (opts.notes === null || opts.notes.trim() === "") fail('manifest needs --notes "<text>": the release notes the update line and latest.json carry');
  } else if (opts.command === "tarball") {
    if (opts.notes !== null) fail("tarball takes no --notes");
  } else if (opts.command === "check") {
    if (opts.version !== null && !SEMVER.test(opts.version)) fail(CHECK_USAGE);
    if (opts.notes !== null) fail("check takes no --notes");
  } else {
    fail(USAGE);
  }
  return opts;
}

/** @param {string} path */
async function exists(path) {
  return stat(path).then(
    () => true,
    (e) => {
      if (e.code === "ENOENT") return false;
      throw e;
    },
  );
}

/** @param {string} root @param {string} version */
function checkRepoVersion(root, version) {
  const r = spawnSync(process.execPath, [VERSION_TOOL, "--check", version, "--root", root], { encoding: "utf8" });
  if (r.error !== undefined) throw r.error;
  if (r.status !== 0) {
    fail(`${version} is not the version every place in ${root} carries (npm run version:check):\n${r.stderr.trim()}\nBump with node scripts/version.mjs ${version}, commit, and build again.`);
  }
}

/** @param {string} root */
function repoVersion(root) {
  const r = spawnSync(process.execPath, [VERSION_TOOL, "--check", "--root", root], { encoding: "utf8" });
  if (r.error !== undefined) throw r.error;
  if (r.status !== 0) fail(`the version places in ${root} disagree (npm run version:check):\n${r.stderr.trim()}`);
  const m = /agree on (\d+\.\d+\.\d+)/.exec(r.stdout);
  if (m === null) fail(`version.mjs --check printed no version: ${r.stdout.trim()}`);
  return m[1];
}

const TRUSTED = "trusted comment: ";

/** @param {string} text @param {string} what */
function minisignLines(text, what) {
  const lines = Buffer.from(text.trim(), "base64").toString("utf8").split("\n");
  if (!lines[0].startsWith("untrusted comment:") || lines[1] === undefined) fail(`${what} is not a base64 minisign file`);
  return lines;
}

/** @param {Buffer} raw */
const keyIdOf = (raw) => raw.subarray(2, 10).toString("hex").toUpperCase();

/** @param {string} root */
async function pubkeyOf(root) {
  const conf = JSON.parse(await readFile(join(root, CONF), "utf8"));
  const pubkey = conf?.plugins?.updater?.pubkey;
  if (typeof pubkey !== "string" || pubkey.trim() === "") {
    fail(`plugins.updater.pubkey in ${join(root, CONF)} is empty: run owner step R1 (npx tauri signer generate -w ~/.tauri/webboard.key), put the content of ~/.tauri/webboard.key.pub there, commit, and build again.`);
  }
  const what = `plugins.updater.pubkey in ${CONF}`;
  const raw = Buffer.from(minisignLines(pubkey, what)[1].trim(), "base64");
  if (raw.length !== 42) fail(`${what} is ${raw.length} bytes, not a 42-byte minisign public key`);
  const algorithm = raw.subarray(0, 2).toString("latin1");
  if (algorithm !== "Ed") fail(`${what} is a minisign key of algorithm ${JSON.stringify(algorithm)}, not "Ed"`);
  return {
    id: keyIdOf(raw),
    key: createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: raw.subarray(10).toString("base64url") }, format: "jwk" }),
  };
}

/** @param {Buffer} block @param {number} at @param {number} len */
function field(block, at, len) {
  const raw = block.subarray(at, at + len);
  const end = raw.indexOf(0);
  return raw.subarray(0, end === -1 ? len : end).toString("utf8");
}

/** @param {Buffer} body */
function paxPath(body) {
  const records = body.toString("utf8").split("\n").filter((r) => r !== "");
  const path = records.map((r) => r.slice(r.indexOf(" ") + 1)).find((kv) => kv.startsWith("path="));
  return path === undefined ? null : path.slice("path=".length);
}

/** @param {Buffer} gz @returns {string[]} */
export function tarNames(gz) {
  const buf = gunzipSync(gz);
  const names = [];
  let next = null;
  let off = 0;
  while (off + 512 <= buf.length) {
    const block = buf.subarray(off, off + 512);
    if (block.every((b) => b === 0)) return names;
    if ((block[124] & 0x80) !== 0) throw new Error(`tar entry at byte ${off} has a base-256 size, over any file a release holds`);
    const sizeText = block.subarray(124, 136).toString("latin1").replace(/^[\0 ]+|[\0 ]+$/g, "");
    if (!/^[0-7]*$/.test(sizeText)) throw new Error(`tar entry at byte ${off} has the size field ${JSON.stringify(sizeText)}, which is not octal digits`);
    const size = sizeText === "" ? 0 : parseInt(sizeText, 8);
    const type = String.fromCharCode(block[156]);
    const body = buf.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
    if (type === "x") next = paxPath(body) ?? next;
    else if (type === "L") next = field(body, 0, body.length);
    else if (type !== "g") {
      const prefix = block.subarray(257, 263).toString("latin1") === "ustar\0" ? field(block, 345, 155) : "";
      const name = field(block, 0, 100);
      names.push(next ?? (prefix === "" ? name : `${prefix}/${name}`));
      next = null;
    }
  }
  throw new Error(`the tarball ends at byte ${off} without its end-of-archive blocks`);
}

/** @param {string} file */
export async function tarEntries(file) {
  const gz = await readFile(file);
  try {
    return tarNames(gz);
  } catch (e) {
    fail(`${file} is not a gzip tarball WebBoard can read: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** @param {string} file */
async function checkTarball(file) {
  const entries = await tarEntries(file);
  const fix = "make it again with node scripts/release.mjs tarball";
  if (entries.length === 0) fail(`${file} is empty: ${fix}`);
  const outside = entries.filter((e) => e !== APP && e !== `${APP}/` && !e.startsWith(`${APP}/`));
  if (outside.length > 0) fail(`${file} holds ${outside[0]}, outside its one top-level entry ${APP}/: ${fix}`);
  const doubles = entries.filter((e) => e.split("/").some((part) => part.startsWith("._")));
  if (doubles.length > 0) fail(`${file} holds the AppleDouble entry ${doubles[0]}: ${fix} (it sets COPYFILE_DISABLE=1 and --no-mac-metadata)`);
}

/** @param {string} dir @param {(name: string) => boolean} keep @param {string} what @param {string} fix */
async function onlyFile(dir, keep, what, fix) {
  const names = (await exists(dir)) ? (await readdir(dir)).filter(keep) : [];
  if (names.length === 0) fail(`no ${what} in ${dir}: ${fix}`);
  if (names.length > 1) fail(`${dir} holds ${names.length} ${what} files (${names.join(", ")}): remove all but the one to publish`);
  return join(dir, names[0]);
}

/** @param {string} file @param {string} version */
function versionInName(file, version) {
  const m = /_(\d+\.\d+\.\d+)_/.exec(basename(file));
  if (m === null) fail(`${file} carries no version in its name`);
  if (m[1] !== version) fail(`${file} is version ${m[1]}, not ${version}: build ${version} and take that artifact`);
}

/** @param {string} file @param {{ id: string, key: import("node:crypto").KeyObject }} pubkey */
async function signatureOf(file, pubkey) {
  const sig = `${file}.sig`;
  if (!(await exists(sig))) fail(`${sig} is missing: ${SIGN(file)}`);
  const text = (await readFile(sig, "utf8")).trim();
  const lines = minisignLines(text, sig);
  const raw = Buffer.from(lines[1].trim(), "base64");
  if (raw.length !== 74) fail(`${sig} holds a ${raw.length}-byte signature, not minisign's 74 bytes: ${SIGN(file)}`);
  const id = keyIdOf(raw);
  if (id !== pubkey.id) {
    fail(`${sig} was signed with key ${id}, but the pubkey in ${CONF} is key ${pubkey.id}: ${SIGN(file)} with the key whose .pub is in ${CONF}`);
  }
  const algorithm = raw.subarray(0, 2).toString("latin1");
  if (algorithm !== "ED") {
    fail(`${sig} uses the minisign algorithm ${JSON.stringify(algorithm)}; only the prehashed "ED" that tauri signer writes is accepted: ${SIGN(file)}`);
  }
  const signature = raw.subarray(10);
  const digest = createHash("blake2b512").update(await readFile(file)).digest();
  if (!verify(null, digest, pubkey.key, signature)) {
    fail(`${sig} is not a signature of ${file} by the key in ${CONF} (it was made for another file or another build of it): ${SIGN(file)}`);
  }
  const trusted = lines[2] ?? "";
  if (!trusted.startsWith(TRUSTED) || lines[3] === undefined) fail(`${sig} has no trusted comment and global signature: ${SIGN(file)}`);
  const global = Buffer.from(lines[3].trim(), "base64");
  if (!verify(null, Buffer.concat([signature, Buffer.from(trusted.slice(TRUSTED.length), "utf8")]), pubkey.key, global)) {
    fail(`${sig}'s trusted comment does not match its global signature, so the .sig was edited after signing: ${SIGN(file)}`);
  }
  return text;
}

/** @param {string} file */
async function underLimit(file) {
  const size = (await stat(file)).size;
  if (size > LIMIT) fail(`${file} is ${size} bytes, over the 25 MiB (${LIMIT} bytes) a Workers static asset may be`);
}

/** @param {string} root @param {string} version @param {string} notes */
async function manifest(root, version, notes) {
  checkRepoVersion(root, version);
  const pubkey = await pubkeyOf(root);
  const tarball = await onlyFile(join(root, MAC_DIR), (n) => n.endsWith("_aarch64.app.tar.gz"), "macOS update tarball (*_aarch64.app.tar.gz)", "run node scripts/release.mjs tarball after the Mac build");
  const deb = await onlyFile(join(root, DEB_DIR), (n) => n.endsWith(".deb"), ".deb", "copy the pop-os .deb there with scp (release.md section 6)");
  versionInName(tarball, version);
  versionInName(deb, version);
  await underLimit(tarball);
  await underLimit(deb);
  await checkTarball(tarball);
  const macSig = await signatureOf(tarball, pubkey);
  const debSig = await signatureOf(deb, pubkey);

  const releases = join(root, RELEASES);
  await mkdir(releases, { recursive: true });
  const versions = (await readdir(releases, { withFileTypes: true })).filter((d) => d.isDirectory() && SEMVER.test(d.name)).map((d) => d.name);
  const newer = versions.filter((v) => compareVersions(v, version) > 0);
  if (newer.length > 0) fail(`${releases} already holds ${newer.join(", ")}, newer than ${version}: publish a version above it`);
  const older = versions.filter((v) => compareVersions(v, version) < 0).sort(compareVersions);
  const previous = older.at(-1);
  const dropped = older.filter((v) => v !== previous);

  const dir = join(releases, version);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  await copyFile(tarball, join(dir, basename(tarball)));
  await copyFile(deb, join(dir, basename(deb)));
  await copyFile(deb, join(releases, `${FIRST_INSTALL}.tmp`));
  await rename(join(releases, `${FIRST_INSTALL}.tmp`), join(releases, FIRST_INSTALL));
  const latest = {
    version,
    notes,
    pub_date: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    platforms: {
      "darwin-aarch64": { signature: macSig, url: `${BASE_URL}/${version}/${basename(tarball)}` },
      "linux-x86_64-deb": { signature: debSig, url: `${BASE_URL}/${version}/${basename(deb)}` },
    },
  };
  await writeFile(join(releases, "latest.json.tmp"), `${JSON.stringify(latest, null, 2)}\n`);
  await rename(join(releases, "latest.json.tmp"), join(releases, "latest.json"));
  await Promise.all(dropped.map((v) => rm(join(releases, v), { recursive: true })));

  process.stdout.write(`release: ${join(releases, "latest.json")} offers ${version}\n`);
  process.stdout.write(`  darwin-aarch64    ${latest.platforms["darwin-aarch64"].url}\n`);
  process.stdout.write(`  linux-x86_64-deb  ${latest.platforms["linux-x86_64-deb"].url}\n`);
  process.stdout.write(`  first install     ${BASE_URL}/${FIRST_INSTALL}\n`);
  process.stdout.write(`  kept ${[version, ...(previous === undefined ? [] : [previous])].join(", ")}${dropped.length === 0 ? "" : `; removed ${dropped.join(", ")}`}\n`);
}

/** @param {string} text @param {string} where */
function offered(text, where) {
  const data = (() => {
    try {
      return JSON.parse(text);
    } catch (e) {
      fail(`${where} is not JSON: ${e instanceof Error ? e.message : String(e)}`);
    }
  })();
  const version = data?.version;
  if (typeof version !== "string" || !SEMVER.test(version)) fail(`${where} carries no major.minor.patch version: ${JSON.stringify(version) ?? "none"}`);
  return { version, platforms: data.platforms };
}

/** @param {unknown} e */
function reason(e) {
  if (!(e instanceof Error)) return String(e);
  return e.cause instanceof Error ? `${e.message} (${e.cause.message})` : e.message;
}

/** @param {string} url */
async function liveVersion(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) }).catch((e) => fail(`could not read ${url}: ${reason(e)}; ${PUBLISH_HINT}`));
  if (res.status !== 200) fail(`${url} answered ${res.status}, not 200; ${PUBLISH_HINT}`);
  return offered(await res.text(), url).version;
}

/** @param {string} file @param {unknown} platforms */
function releaseFiles(file, platforms) {
  if (typeof platforms !== "object" || platforms === null || Array.isArray(platforms) || Object.keys(platforms).length === 0) fail(`${file} names no platform`);
  const files = Object.entries(platforms).map(([name, p]) => {
    const url = p?.url;
    if (typeof url !== "string" || !url.startsWith(`${BASE_URL}/`)) fail(`${file} gives platform ${name} the url ${JSON.stringify(url) ?? "none"}, not one under ${BASE_URL}/`);
    return url.slice(BASE_URL.length + 1);
  });
  return ["latest.json", ...files, FIRST_INSTALL];
}

/** @param {string} root @param {string | null} version @param {string} liveUrl */
async function check(root, version, liveUrl) {
  const releases = join(root, RELEASES);
  const file = join(releases, "latest.json");
  if (!(await exists(file))) {
    fail(`${file} is missing: this checkout holds no release, and a deploy from it would take the release files off ${BASE_URL}/. Deploy from the checkout where node scripts/release.mjs manifest wrote the release that is live${version === null ? "" : ` or ${version}`}.`);
  }
  const latest = offered(await readFile(file, "utf8"), file);
  const files = releaseFiles(file, latest.platforms);
  const present = await Promise.all(files.map((rel) => exists(join(releases, rel))));
  const absent = files.filter((_, i) => !present[i]);
  if (absent.length > 0) {
    fail(`${join(releases, absent[0])} is missing: the release in ${releases} is incomplete; run node scripts/release.mjs manifest ${latest.version} --notes "<text>" again in this checkout`);
  }
  if (version !== null) {
    if (latest.version !== version) {
      fail(`${file} offers ${latest.version}, not ${version}, the version being published: run node scripts/release.mjs manifest ${version} --notes "<text>" in this checkout first`);
    }
    process.stdout.write(`release: ${file} offers ${version}, the version being published\n`);
  } else {
    const live = await liveVersion(liveUrl);
    if (live !== latest.version) {
      fail(`${file} offers ${latest.version}, but ${liveUrl} offers ${live}: a deploy from this checkout would put ${latest.version} in place of the live release. Deploy from the checkout that holds ${live}; to publish ${latest.version}, run node scripts/release.mjs check ${latest.version} instead.`);
    }
    process.stdout.write(`release: ${file} offers ${live}, the same as ${liveUrl}\n`);
  }
  files.forEach((rel) => process.stdout.write(`  /releases/${rel}\n`));
}

/** @param {string} root */
async function tarball(root) {
  if (process.platform !== "darwin") fail("tarball runs on the Mac: it packs the macOS build with bsdtar");
  const version = repoVersion(root);
  const macDir = join(root, MAC_DIR);
  const app = join(macDir, APP);
  if (!(await exists(app))) fail(`${app} is missing: touch src-tauri/src/lib.rs && CI=true npm run tauri build`);
  const plist = await readFile(join(app, "Contents", "Info.plist"), "utf8");
  const built = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]*)<\/string>/.exec(plist);
  if (built === null) fail(`${join(app, "Contents", "Info.plist")} carries no CFBundleShortVersionString`);
  if (built[1] !== version) fail(`${app} is version ${built[1]}, but the repo is ${version}: build again (touch src-tauri/src/lib.rs && CI=true npm run tauri build)`);
  const name = `WebBoard_${version}_aarch64.app.tar.gz`;
  const out = join(macDir, name);
  const stale = (await readdir(macDir)).filter((n) => n !== name && n.endsWith("_aarch64.app.tar.gz"));
  await Promise.all(stale.flatMap((n) => [rm(join(macDir, n)), rm(join(macDir, `${n}.sig`), { force: true })]));
  await rm(`${out}.sig`, { force: true });
  const r = spawnSync("/usr/bin/tar", ["--no-mac-metadata", "-czf", out, "-C", macDir, APP], {
    encoding: "utf8",
    env: { ...process.env, COPYFILE_DISABLE: "1" },
  });
  if (r.error !== undefined) throw r.error;
  if (r.status !== 0) fail(`tar could not pack ${app}: ${r.stderr.trim()}`);
  await checkTarball(out);
  await underLimit(out);
  process.stdout.write(`release: ${out} (${(await stat(out)).size} bytes)\n`);
  process.stdout.write(`  next: ${SIGN(out).replace(/^run /, "")}\n`);
}

async function main() {
  try {
    const opts = parse(process.argv.slice(2));
    const root = opts.root ?? fileURLToPath(new URL("..", import.meta.url));
    if (opts.command === "manifest") await manifest(root, opts.version ?? "", opts.notes ?? "");
    else if (opts.command === "check") await check(root, opts.version, opts.live ?? LIVE);
    else await tarball(root);
  } catch (e) {
    if (!(e instanceof ReleaseError)) throw e;
    process.stderr.write(`release: ${e.message}\n`);
    process.exit(1);
  }
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
