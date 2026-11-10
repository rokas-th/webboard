import { readFile, writeFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const SEMVER = /^\d+\.\d+\.\d+$/;
const V = String.raw`\d+\.\d+\.\d+`;

/** @type {{path: string, key: string, re: RegExp, write: boolean}[]} */
const SITES = [
  {
    path: "package.json",
    key: "version",
    re: new RegExp(String.raw`(^\s*"version":\s*")(${V})(")`, "m"),
    write: true,
  },
  {
    path: "src-tauri/tauri.conf.json",
    key: "version",
    re: new RegExp(String.raw`(^\s*"version":\s*")(${V})(")`, "m"),
    write: true,
  },
  {
    path: "src-tauri/Cargo.toml",
    key: "[package] version",
    re: new RegExp(String.raw`(\[package\][^\[]*?\nversion\s*=\s*")(${V})(")`),
    write: true,
  },
  {
    path: "crates/webboard-core/Cargo.toml",
    key: "[package] version",
    re: new RegExp(String.raw`(\[package\][^\[]*?\nversion\s*=\s*")(${V})(")`),
    write: true,
  },
  {
    path: "Cargo.lock",
    key: 'package "webboard"',
    re: new RegExp(String.raw`(name = "webboard"\nversion = ")(${V})(")`),
    write: false,
  },
  {
    path: "Cargo.lock",
    key: 'package "webboard-core"',
    re: new RegExp(String.raw`(name = "webboard-core"\nversion = ")(${V})(")`),
    write: false,
  },
  {
    path: "package-lock.json",
    key: "root version",
    re: new RegExp(String.raw`(^  "version":\s*")(${V})(")`, "m"),
    write: false,
  },
  {
    path: "package-lock.json",
    key: 'packages."" version',
    re: new RegExp(String.raw`("packages":\s*\{\s*"":\s*\{[^{}]*?"version":\s*")(${V})(")`),
    write: false,
  },
  {
    path: "server/package.json",
    key: "version",
    re: new RegExp(String.raw`(^\s*"version":\s*")(${V})(")`, "m"),
    write: true,
  },
  {
    path: "server/package-lock.json",
    key: "root version",
    re: new RegExp(String.raw`(^  "version":\s*")(${V})(")`, "m"),
    write: false,
  },
  {
    path: "server/package-lock.json",
    key: 'packages."" version',
    re: new RegExp(String.raw`("packages":\s*\{\s*"":\s*\{[^{}]*?"version":\s*")(${V})(")`),
    write: false,
  },
  ...["ShortVersionString", "Version"].map((suffix) => ({
    path: "src-tauri/gen/apple/project.yml",
    key: `CFBundle${suffix}`,
    re: new RegExp(String.raw`(^[ \t]*CFBundle${suffix}:[ \t]*"?)([0-9.]+)("?)(?=[ \t]*$)`, "m"),
    write: true,
  })),
];

/** @param {string[]} argv */
function parse(argv) {
  const opts = { check: false, lock: true, root: null, version: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--check") opts.check = true;
    else if (a === "--no-lock") opts.lock = false;
    else if (a === "--root") {
      i += 1;
      opts.root = argv[i];
      if (opts.root === undefined) fail("--root needs a directory");
    } else if (a.startsWith("-")) fail(`unknown option ${a}`);
    else if (opts.version === null) opts.version = a;
    else fail(`unexpected argument ${a}`);
  }
  if (opts.version !== null && !SEMVER.test(opts.version)) {
    fail(`"${opts.version}" is not a major.minor.patch version`);
  }
  if (!opts.check && opts.version === null) {
    fail("usage: node scripts/version.mjs <semver> | --check [semver]");
  }
  return opts;
}

/** @param {string} message */
function fail(message) {
  process.stderr.write(`version: ${message}\n`);
  process.exit(2);
}

/** @param {string} text @param {{path: string, key: string, re: RegExp}} site */
function locate(text, site) {
  const m = site.re.exec(text);
  if (m === null) {
    process.stderr.write(
      `version: ${site.path}: no ${site.key} matched ${site.re} — the file's shape changed, fix scripts/version.mjs\n`,
    );
    process.exit(1);
  }
  const rest = text.slice(m.index + m[0].length);
  if (site.re.exec(rest) !== null) {
    process.stderr.write(`version: ${site.path}: ${site.key} matched more than once — the pattern is too loose\n`);
    process.exit(1);
  }
  return m;
}

/** @param {string} root @returns {Promise<Map<string, string>>} */
async function readAll(root) {
  const paths = [...new Set(SITES.map((site) => site.path))];
  const entries = [];
  for (const path of paths) {
    const abs = join(root, path);
    const present = await stat(abs).then(
      () => true,
      () => false,
    );
    if (!present) {
      process.stderr.write(`version: no such file: ${abs}\n`);
      process.exit(1);
    }
    entries.push([path, await readFile(abs, "utf8")]);
  }
  return new Map(entries);
}

/** @param {string} root @param {string|null} expected */
async function check(root, expected) {
  const texts = await readAll(root);
  const found = SITES.map((site) => ({
    site,
    value: locate(texts.get(site.path) ?? "", site)[2],
  }));
  const values = [...new Set(found.map((f) => f.value))].sort();
  const target = expected ?? found[0].value;
  const wrong = found.filter((f) => f.value !== target);

  for (const f of found) {
    const mark = f.value === target ? " " : "!";
    process.stdout.write(`${mark} ${f.value}  ${f.site.path} (${f.site.key})\n`);
  }
  if (wrong.length > 0) {
    process.stderr.write(
      `version: ${wrong.length} of ${SITES.length} places disagree — ${values.join(" vs ")}` +
        (expected === null ? " (compared against the first)\n" : `, expected ${expected}\n`),
    );
    process.exit(1);
  }
  process.stdout.write(`version: ${SITES.length} places agree on ${target}\n`);
}

/** @param {string} root @param {string} next @param {boolean} lock */
async function write(root, next, lock) {
  const texts = await readAll(root);
  /** @type {Map<string, string>} */
  const updated = new Map(texts);
  for (const site of SITES.filter((s) => s.write)) {
    const text = updated.get(site.path) ?? "";
    const m = locate(text, site);
    updated.set(site.path, text.slice(0, m.index) + m[1] + next + m[3] + text.slice(m.index + m[0].length));
    process.stdout.write(`  ${m[2]} -> ${next}  ${site.path} (${site.key})\n`);
  }
  for (const [path, text] of updated) {
    if (text === texts.get(path)) continue;
    await writeFile(join(root, path), text);
  }
  if (!lock) {
    process.stdout.write("version: --no-lock, lockfiles left alone\n");
    return;
  }
  run(root, "cargo", ["check", "--workspace"], "Cargo.lock");
  run(root, "npm", ["install", "--package-lock-only"], "the root package-lock.json");
  run(join(root, "server"), "npm", ["install", "--package-lock-only"], "server/package-lock.json");
  await check(root, next);
}

/** @param {string} cwd @param {string} cmd @param {string[]} args @param {string} lockfile */
function run(cwd, cmd, args, lockfile) {
  process.stdout.write(`  $ ${cmd} ${args.join(" ")}\n`);
  const r = spawnSync(cmd, args, { cwd, stdio: "inherit" });
  if (r.error !== undefined || r.status !== 0) {
    process.stderr.write(
      `version: ${cmd} ${args.join(" ")} failed in ${cwd} (${r.error?.message ?? `exit ${r.status}`}) — ${lockfile} was not regenerated\n`,
    );
    process.exit(1);
  }
}

const opts = parse(process.argv.slice(2));
const root = opts.root ?? fileURLToPath(new URL("..", import.meta.url));
if (opts.check) await check(root, opts.version);
else await write(root, opts.version ?? "", opts.lock);
