import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ACT, Cdp, devtoolsUrl, evaluate, findShell, stopChild } from "./layout-probe.mjs";

const page = {};

before(async () => {
  const bin = await findShell();
  page.profile = await mkdtemp(join(tmpdir(), "webboard-hit44-"));
  page.child = spawn(bin, ["--remote-debugging-port=0", `--user-data-dir=${page.profile}`, "--no-first-run", "--disable-gpu", "--force-device-scale-factor=1", "about:blank"], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  let startError = null;
  page.child.once("error", (e) => {
    startError = e;
  });
  page.child.stderr.on("data", (d) => {
    stderr += d.toString();
  });
  page.cdp = await Cdp.open(await devtoolsUrl(page.child, page.profile, () => stderr, () => startError));
  const { targetId } = await page.cdp.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await page.cdp.send("Target.attachToTarget", { targetId, flatten: true });
  page.sessionId = sessionId;
  await page.cdp.send("Page.enable", {}, sessionId);
  await page.cdp.send("Emulation.setDeviceMetricsOverride", { width: 400, height: 300, deviceScaleFactor: 1, mobile: false }, sessionId);
});

after(async () => {
  if (page.cdp !== undefined) page.cdp.close();
  if (page.child !== undefined) await stopChild(page.child);
  if (page.profile !== undefined) await rm(page.profile, { recursive: true, force: true });
});

const CSS = "body { margin: 0; } button { box-sizing: border-box; padding: 0; border: 0; margin: 4px; font: 10px sans-serif; }";

async function hit44(body, selectors) {
  const { frameTree } = await page.cdp.send("Page.getFrameTree", {}, page.sessionId);
  await page.cdp.send("Page.setDocumentContent", { frameId: frameTree.frame.id, html: `<!doctype html><html><head><style>${CSS}</style></head><body>${body}</body></html>` }, page.sessionId);
  await evaluate(page.cdp, page.sessionId, ACT);
  return evaluate(page.cdp, page.sessionId, `window.__probeAct(${JSON.stringify({ hit44: selectors })})`, true);
}

test("hit44 fails a 30 x 30 button and names its selector, text and size", async () => {
  const got = await hit44('<button class="small" style="width: 30px; height: 30px">Add</button>', [".small"]);
  assert.equal(got.fail, '.small "Add" has a hit area of 30x30 px, under 44x44');
});

test("hit44 passes a 44 x 44 button", async () => {
  assert.deepEqual(await hit44('<button class="big" style="width: 44px; height: 44px">Add</button>', [".big"]), { ok: true });
});

test("hit44 passes a 30 x 30 button whose pseudo-element extends its hit area to 44 x 44", async () => {
  const body =
    '<style>.grown { position: relative; } .grown::before { content: ""; position: absolute; inset: -7px; }</style>' +
    '<button class="grown" style="width: 30px; height: 30px">Add</button>';
  assert.deepEqual(await hit44(body, [".grown"]), { ok: true });
});

test("hit44 measures an ::after that extends the button too", async () => {
  const body =
    '<style>.grown { position: relative; } .grown::after { content: ""; position: absolute; left: -7px; top: -7px; width: 44px; height: 44px; }</style>' +
    '<button class="grown" style="width: 30px; height: 30px">Add</button>';
  assert.deepEqual(await hit44(body, [".grown"]), { ok: true });
});

test("hit44 does not count a pseudo-element that takes no pointer events", async () => {
  const body =
    '<style>.ghost { position: relative; } .ghost::before { content: ""; position: absolute; inset: -7px; pointer-events: none; }</style>' +
    '<button class="ghost" style="width: 30px; height: 30px">Add</button>';
  assert.equal((await hit44(body, [".ghost"])).fail, '.ghost "Add" has a hit area of 30x30 px, under 44x44');
});

test("hit44 ignores a hidden small button", async () => {
  const body =
    '<button class="b" style="width: 44px; height: 44px">Shown</button>' +
    '<button class="b" style="width: 30px; height: 30px; display: none">Gone</button>' +
    '<button class="b" style="width: 30px; height: 30px; visibility: hidden">Unseen</button>';
  assert.deepEqual(await hit44(body, [".b"]), { ok: true });
});

test("hit44 names the selector a small element matched and reads an icon button's label", async () => {
  const body = '<button class="big" style="width: 44px; height: 44px">Add</button><button class="icon" aria-label="Close" style="width: 28px; height: 44px"></button>';
  assert.equal((await hit44(body, [".big", ".icon"])).fail, '.icon "Close" has a hit area of 28x44 px, under 44x44');
});

test("hit44 fails a selector that matches nothing visible even when another selector matches", async () => {
  const got = await hit44('<button class="big" style="width: 44px; height: 44px">Add</button>', [".big", ".missing"]);
  assert.equal(got.fail, "no visible element matches .missing, so no hit area was measured");
});

test("hit44 measures a rendered button that collapsed to zero width instead of skipping it", async () => {
  const body = '<button class="big" style="width: 44px; height: 44px">Add</button><button class="flat" style="width: 0; height: 30px"></button>';
  assert.equal((await hit44(body, [".big", ".flat"])).fail, '.flat "" has a hit area of 0x30 px, under 44x44');
});

test("hit44 counts a pseudo-element that grows a zero-width button and fails what is still too small", async () => {
  const body =
    '<style>.flat { position: relative; display: inline-block; } .flat::before { content: ""; position: absolute; inset: -7px; }</style>' +
    '<button class="big" style="width: 44px; height: 44px">Add</button><button class="flat" aria-label="Info" style="width: 0; height: 30px"></button>';
  assert.equal((await hit44(body, [".big", ".flat"])).fail, '.flat "Info" has a hit area of 14x44 px, under 44x44');
});

test("hit44 ignores a small button under visibility: collapse", async () => {
  const body = '<button class="b" style="width: 44px; height: 44px">Shown</button><button class="b" style="width: 30px; height: 30px; visibility: collapse">Collapsed</button>';
  assert.deepEqual(await hit44(body, [".b"]), { ok: true });
});

test("hit44 does not count the part of a pseudo-element the button's own overflow clips", async () => {
  const body =
    '<style>.clipped { position: relative; overflow: hidden; } .clipped::before { content: ""; position: absolute; inset: -7px; }</style>' +
    '<button class="clipped" style="width: 30px; height: 30px">Add</button>';
  assert.equal((await hit44(body, [".clipped"])).fail, '.clipped "Add" has a hit area of 30x30 px, under 44x44');
});

test("hit44 does not count the part of a pseudo-element an ancestor's overflow clips", async () => {
  const body =
    '<style>.grown { position: relative; margin: 0; } .grown::before { content: ""; position: absolute; inset: -7px; }</style>' +
    '<div style="width: 30px; height: 30px; overflow: hidden"><button class="grown" style="width: 30px; height: 30px">Add</button></div>';
  assert.equal((await hit44(body, [".grown"])).fail, '.grown "Add" has a hit area of 30x30 px, under 44x44');
});

test("hit44 does not bridge a gap to a pseudo-element that does not touch the button", async () => {
  const body =
    '<style>.dot { position: relative; } .dot::after { content: ""; position: absolute; left: 40px; top: -7px; width: 14px; height: 44px; }</style>' +
    '<button class="dot" style="width: 30px; height: 30px">Add</button>';
  assert.equal((await hit44(body, [".dot"])).fail, '.dot "Add" has a hit area of 30x30 px, under 44x44');
});

test("hit44 refuses to measure a transformed button or pseudo-element", async () => {
  const pseudo =
    '<style>.turned { position: relative; } .turned::before { content: ""; position: absolute; inset: -7px; transform: scale(0.5); }</style>' +
    '<button class="turned" style="width: 30px; height: 30px">Add</button>';
  await assert.rejects(hit44(pseudo, [".turned"]), /hit44: ::before of button has a transform \(matrix\(0\.5, 0, 0, 0\.5, 0, 0\)\), which its computed box does not show/);
  const own =
    '<style>.scaled { position: relative; transform: scale(2); } .scaled::before { content: ""; position: absolute; inset: -7px; }</style>' +
    '<button class="scaled" style="width: 30px; height: 30px">Add</button>';
  await assert.rejects(hit44(own, [".scaled"]), /hit44: button\.scaled has a transform \(matrix\(2, 0, 0, 2, 0, 0\)\) that changes the size of button's pseudo-elements; their computed boxes do not show it/);
});

test("hit44 fails a cross of two thin pseudo-elements whose union only spans 44 x 44", async () => {
  const body =
    '<style>.cross { position: relative; } .cross::before { content: ""; position: absolute; left: -7px; top: 0; width: 44px; height: 1px; }' +
    ' .cross::after { content: ""; position: absolute; left: 0; top: -7px; width: 1px; height: 44px; }</style>' +
    '<button class="cross" style="width: 30px; height: 30px">Add</button>';
  assert.equal((await hit44(body, [".cross"])).fail, '.cross "Add" has a hit area of 30x30 px, under 44x44');
});

test("hit44 fails a 44 x 44 button an ancestor's overflow clips to 30 x 30 and names the ancestor", async () => {
  const body = '<div class="frame" style="width: 30px; height: 30px; overflow: hidden"><button class="big" style="width: 44px; height: 44px; margin: 0">Add</button></div>';
  assert.equal((await hit44(body, [".big"])).fail, '.big "Add" has a hit area of 30x30 px, under 44x44 (clipped by div.frame)');
});

test("hit44 passes a 44 x 44 button inside a larger overflow: hidden ancestor", async () => {
  const body = '<div style="width: 100px; height: 100px; overflow: hidden"><button class="big" style="width: 44px; height: 44px">Add</button></div>';
  assert.deepEqual(await hit44(body, [".big"]), { ok: true });
});

test("hit44 ignores a small button its ancestor's overflow clips away entirely", async () => {
  const body =
    '<div style="width: 100px; height: 100px; overflow: hidden"><button class="b" style="width: 44px; height: 44px">Shown</button>' +
    '<button class="b" style="display: block; margin-left: 200px; width: 30px; height: 30px">Away</button></div>';
  assert.deepEqual(await hit44(body, [".b"]), { ok: true });
});

test("hit44 refuses a pseudo-element under an ancestor that scales it", async () => {
  const body =
    '<style>.grown { position: relative; } .grown::before { content: ""; position: absolute; inset: -7px; }</style>' +
    '<div class="shrunk" style="transform: scale(0.5)"><button class="grown" style="width: 30px; height: 30px">Add</button></div>';
  await assert.rejects(hit44(body, [".grown"]), /hit44: div\.shrunk has a transform \(matrix\(0\.5, 0, 0, 0\.5, 0, 0\)\) that changes the size of button's pseudo-elements; their computed boxes do not show it/);
});

test("hit44 measures a pseudo-element under a translated ancestor and on a translated button", async () => {
  const under =
    '<style>.grown { position: relative; } .grown::before { content: ""; position: absolute; inset: -7px; }</style>' +
    '<div style="transform: translateX(10px)"><button class="grown" style="width: 30px; height: 30px">Add</button></div>';
  assert.deepEqual(await hit44(under, [".grown"]), { ok: true });
  const own =
    '<style>.grown { position: relative; transform: translate(10px, 5px); } .grown::before { content: ""; position: absolute; inset: -7px; }</style>' +
    '<button class="grown" style="width: 30px; height: 30px">Add</button>';
  assert.deepEqual(await hit44(own, [".grown"]), { ok: true });
});

test("hit44 measures a pseudo-element centred with a translate", async () => {
  const centred = (size) =>
    `<style>.centred { position: relative; } .centred::before { content: ""; position: absolute; left: 50%; top: 50%; width: ${size}px; height: ${size}px; transform: translate(-50%, -50%); }</style>` +
    '<button class="centred" style="width: 30px; height: 30px">Add</button>';
  assert.deepEqual(await hit44(centred(44), [".centred"]), { ok: true });
  assert.equal((await hit44(centred(40), [".centred"])).fail, '.centred "Add" has a hit area of 40x40 px, under 44x44');
});

test("hit44 measures a button with no pseudo-element under a scaled ancestor in screen space", async () => {
  const body = '<div style="transform: scale(0.5)"><button class="big" style="width: 44px; height: 44px">Add</button></div>';
  assert.equal((await hit44(body, [".big"])).fail, '.big "Add" has a hit area of 22x22 px, under 44x44');
});

test("the probe runs when started through a symlink to it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "webboard-probe-link-"));
  try {
    const link = join(dir, "probe.mjs");
    await symlink(fileURLToPath(new URL("./layout-probe.mjs", import.meta.url)), link);
    const child = spawn(process.execPath, [link, "--only", "no-such-state"], { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    const code = await new Promise((done) => child.once("close", done));
    assert.equal(code, 2);
    assert.equal(stderr, "layout-probe: not measured: --only no-such-state matched no state\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("hit44 fails when no visible element matches, so a mistyped selector does not pass", async () => {
  const got = await hit44('<button class="b" style="width: 30px; height: 30px; display: none">Gone</button>', [".b", ".missing"]);
  assert.equal(got.fail, "no visible element matches .b, .missing, so no hit area was measured");
});
