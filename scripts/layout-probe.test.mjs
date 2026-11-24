import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ACT, Cdp, devtoolsUrl, evaluate, findShell, stopChild, unexpectedAlerts } from "./layout-probe.mjs";

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

async function act(body, action) {
  const { frameTree } = await page.cdp.send("Page.getFrameTree", {}, page.sessionId);
  await page.cdp.send("Page.setDocumentContent", { frameId: frameTree.frame.id, html: `<!doctype html><html><head><style>${CSS}</style></head><body>${body}</body></html>` }, page.sessionId);
  await evaluate(page.cdp, page.sessionId, ACT);
  return evaluate(page.cdp, page.sessionId, `window.__probeAct(${JSON.stringify(action)})`, true);
}

const hit44 = (body, selectors) => act(body, { hit44: selectors });
const fontMin = (body, selector, px) => act(body, { fontMin: [selector, px] });

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

const PAIR = '<style>.g { position: relative; margin: 0; } .g::before { content: ""; position: absolute; inset: -7px; }</style>';

test("hit44 fails two targets whose hit areas overlap, naming both and the overlap", async () => {
  const body = PAIR + '<div style="display: flex; gap: 8px; padding: 20px"><button class="g" style="width: 30px; height: 30px">One</button><button class="g" style="width: 30px; height: 30px">Two</button></div>';
  assert.equal((await hit44(body, [".g"])).fail, '.g "One" and .g "Two" have hit areas that overlap by 6x44 px');
});

test("hit44 names overlapping targets from two selectors", async () => {
  const body = PAIR + '<div style="display: flex; gap: 8px; padding: 20px"><button class="g a" style="width: 30px; height: 30px">One</button><button class="g b" style="width: 30px; height: 30px">Two</button></div>';
  assert.equal((await hit44(body, [".a", ".b"])).fail, '.a "One" and .b "Two" have hit areas that overlap by 6x44 px');
});

test("hit44 passes hit areas that only touch or overlap by half a pixel", async () => {
  const at = (gap) => PAIR + `<div style="display: flex; gap: ${gap}px; padding: 20px"><button class="g" style="width: 30px; height: 30px">One</button><button class="g" style="width: 30px; height: 30px">Two</button></div>`;
  assert.deepEqual(await hit44(at(14), [".g"]), { ok: true });
  assert.deepEqual(await hit44(at(13.5), [".g"]), { ok: true });
  assert.equal((await hit44(at(13), [".g"])).fail, '.g "One" and .g "Two" have hit areas that overlap by 1x44 px');
});

test("hit44 passes hit areas that overlap on one axis only", async () => {
  const body = PAIR + '<div style="display: flex; flex-direction: column; gap: 20px; padding: 20px"><button class="g" style="width: 30px; height: 30px">One</button><button class="g" style="width: 30px; height: 30px">Two</button></div>';
  assert.deepEqual(await hit44(body, [".g"]), { ok: true });
});

test("hit44 does not compare a target with a target inside it", async () => {
  const body = '<div class="row" style="display: flex; width: 120px; height: 60px"><button class="b" style="width: 44px; height: 44px">In</button></div>';
  assert.deepEqual(await hit44(body, [".row", ".b"]), { ok: true });
});

test("hit44 compares the whole hit area of a target that already fits, pseudo-elements included", async () => {
  const body =
    '<style>.wide { position: relative; } .wide::after { content: ""; position: absolute; top: 0; bottom: 0; left: 0; right: -20px; }</style>' +
    '<div style="display: flex; gap: 8px; padding: 20px"><button class="g wide" style="margin: 0; width: 44px; height: 44px">One</button><button class="g" style="margin: 0; width: 44px; height: 44px">Two</button></div>';
  assert.equal((await hit44(body, [".g"])).fail, '.g "One" and .g "Two" have hit areas that overlap by 12x44 px');
});

const FIELDS = "input, select, textarea";

test("fontMin passes fields at or above the size", async () => {
  const body = '<input aria-label="Name" style="font-size: 16px"><select name="pick" style="font-size: 18px"><option>a</option></select><textarea style="font-size: 16px"></textarea>';
  assert.deepEqual(await fontMin(body, FIELDS, 16), { ok: true });
});

test("fontMin fails a field under the size and names it", async () => {
  const body = '<input aria-label="Name" style="font-size: 16px"><input aria-label="Days" style="font-size: 15px"><select name="pick" style="font-size: 12px"><option>a</option></select>';
  assert.equal((await fontMin(body, FIELDS, 16)).fail, 'input "Days" renders at 15 px, under 16; select "pick" renders at 12 px, under 16');
});

test("fontMin fails when no field is visible to read", async () => {
  const body = '<input aria-label="Hidden" style="display: none"><textarea style="visibility: hidden"></textarea>';
  assert.equal((await fontMin(body, FIELDS, 16)).fail, "no visible input, select, textarea to read a font size from");
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

async function actAll(body, actions) {
  const { frameTree } = await page.cdp.send("Page.getFrameTree", {}, page.sessionId);
  await page.cdp.send("Page.setDocumentContent", { frameId: frameTree.frame.id, html: `<!doctype html><html><head><style>${CSS}</style></head><body>${body}</body></html>` }, page.sessionId);
  await evaluate(page.cdp, page.sessionId, ACT);
  const out = [];
  for (const a of actions) {
    if (typeof a === "string") await evaluate(page.cdp, page.sessionId, a);
    else out.push(await evaluate(page.cdp, page.sessionId, `window.__probeAct(${JSON.stringify(a)})`, true));
  }
  return out;
}

test("inWindow passes a box inside the window and fails one past its edge, naming it", async () => {
  assert.deepEqual(await act('<div class="m" style="position: absolute; left: 10px; top: 10px; width: 100px; height: 40px">In</div>', { inWindow: ".m" }), { ok: true });
  const got = await act('<div class="m" style="position: absolute; left: -50px; top: 10px; width: 100px; height: 40px">Out</div>', { inWindow: ".m" });
  assert.equal(got.fail, '.m: "Out" lies at -50,10 to 50,50, outside the window');
});

test("inWindow fails a row an ancestor's overflow clips, and passes one the ancestor holds", async () => {
  const clip = (left) => `<div class="c" style="position: absolute; left: 10px; top: 10px; width: 100px; height: 100px; overflow: hidden"><div class="r" style="position: absolute; left: ${left}px; top: 0; width: 80px; height: 20px">Row</div></div>`;
  assert.deepEqual(await act(clip(10), { inWindow: ".r" }), { ok: true });
  assert.equal((await act(clip(60), { inWindow: ".r" })).fail, '.r: "Row" is clipped by div.c');
});

test("inWindow fails when nothing matches", async () => {
  assert.equal((await act("<p>x</p>", { inWindow: ".none" })).fail, "no .none on screen to measure");
});

test("centredIn passes a centred box and fails one 2 px off", async () => {
  const box = (left) => `<div class="s" style="position: absolute; left: ${left}px; top: 100px; width: 200px; height: 100px">S</div>`;
  assert.deepEqual(await act(box(100), { centredIn: ".s" }), { ok: true });
  assert.equal((await act(box(102), { centredIn: ".s" })).fail, ".s sits 2 px across and 0 px down from the window's centre");
});

test("centredAcross passes a title centred in its bar and fails one 2 px off, outside the bar or missing", async () => {
  const bar = (left) => `<div class="bar" style="position: absolute; left: 50px; top: 10px; width: 300px; height: 44px"><h3 class="t" style="position: absolute; left: ${left}px; top: 0; width: 100px; margin: 0">T</h3></div>`;
  assert.deepEqual(await act(bar(100), { centredAcross: [".t", ".bar"] }), { ok: true });
  assert.equal((await act(bar(102), { centredAcross: [".t", ".bar"] })).fail, ".t sits 2 px across from the centre of its .bar");
  assert.equal((await act('<h3 class="t">T</h3>', { centredAcross: [".t", ".bar"] })).fail, ".t is not inside a .bar");
  assert.equal((await act("<p>x</p>", { centredAcross: [".t", ".bar"] })).fail, "no .t on screen to measure");
});

test("alerted passes the exact native discard asks sent and fails any other list, naming what was sent", async () => {
  const sent = (asks) => `<script>window.__PROBE_ALERTS__ = ${JSON.stringify(asks)};</script>`;
  const ask = { title: "Discard theme changes?", message: "Your colour changes are not saved yet.", confirm: { label: "Discard", destructive: true }, cancel: "Keep editing" };
  const want = [["Discard theme changes?", "Your colour changes are not saved yet."]];
  assert.deepEqual(await act(sent([ask]), { alerted: want }), { ok: true });
  assert.equal((await act(sent([]), { alerted: want })).fail, 'alert_ask sent [], not exactly [["Discard theme changes?","Your colour changes are not saved yet."]]');
  assert.equal((await act(sent([ask, ask]), { alerted: want })).fail, `alert_ask sent ${JSON.stringify([...want, ...want])}, not exactly ${JSON.stringify(want)}`);
  assert.equal((await act("<script>delete window.__PROBE_ALERTS__;</script>", { alerted: want })).fail, "the probe recorded no alert_ask list");
});

test("corner passes a control near its box's corner and fails one past the gap, out of the box or in no box", async () => {
  const body = (left, top) =>
    `<div class="m" style="position: absolute; left: 100px; top: 50px; width: 200px; height: 120px"><button class="x" style="position: absolute; left: ${left}px; top: ${top}px; width: 24px; height: 24px; margin: 0">X</button></div>`;
  assert.deepEqual(await act(body(16, 18), { corner: [".x", ".m", "top-leading", 20] }), { ok: true });
  assert.equal((await act(body(24, 18), { corner: [".x", ".m", "top-leading", 20] })).fail, ".x sits 24 px from the leading side and 18 px from the top of its .m, more than 20");
  assert.deepEqual(await act(body(164, 4), { corner: [".x", ".m", "top-trailing", 12] }), { ok: true });
  assert.equal((await act(body(16, 4), { corner: [".x", ".m", "top-trailing", 12] })).fail, ".x sits 160 px from the trailing side and 4 px from the top of its .m, more than 12");
  assert.equal((await act(body(-4, 4), { corner: [".x", ".m", "top-leading", 20] })).fail, ".x runs out of its .m");
  assert.equal((await act('<button class="x">X</button>', { corner: [".x", ".m", "top-leading", 20] })).fail, ".x is not inside a .m");
  assert.equal((await act("<p>x</p>", { corner: [".x", ".m", "top-leading", 20] })).fail, "no .x on screen to measure");
});

test("kept passes a box that stayed and names the edges of one that moved", async () => {
  const body = '<div class="k" style="position: absolute; left: 10px; top: 10px; width: 100px; height: 40px">K</div>';
  assert.deepEqual(await actAll(body, [{ keep: ".k" }, { kept: ".k" }]), [{ ok: true }, { ok: true }]);
  const moved = await actAll(body, [{ keep: ".k" }, 'document.querySelector(".k").style.left = "30px"', { kept: ".k" }]);
  assert.equal(moved[1].fail, ".k moved: left 10 -> 30, right 110 -> 130");
  assert.equal((await act('<div class="j">J</div>', { kept: ".j" })).fail, ".j was never kept");
});

test("meets passes edges that touch and fails a gap", async () => {
  const body = (top) => `<div class="a" style="position: absolute; left: 0; top: 0; width: 100px; height: 40px">A</div><div class="b" style="position: absolute; left: 0; top: ${top}px; width: 100px; height: 40px">B</div>`;
  assert.deepEqual(await act(body(40), { meets: [".b", "top", ".a", "bottom"] }), { ok: true });
  assert.equal((await act(body(44), { meets: [".b", "top", ".a", "bottom"] })).fail, ".b has its top edge at 44 px, not at .a's bottom edge, 40 px");
});

test("uncovered passes buttons on top and fails one under another box", async () => {
  const body = (z) => `<button class="u" style="position: absolute; left: 10px; top: 10px; width: 60px; height: 30px">Go</button><div style="position: absolute; left: 0; top: 0; width: 200px; height: 100px; z-index: ${z}; background: black"></div>`;
  assert.deepEqual(await act(body(-1), { uncovered: ".u" }), { ok: true });
  assert.equal((await act(body(1), { uncovered: ".u" })).fail, '1 of 1 .u are covered at their centre: "Go"');
});

test("still waits for a running transition to finish", async () => {
  const body = '<style>.t { position: absolute; left: 0; top: 0; width: 50px; height: 50px; transition: transform 300ms linear; } .t.on { transform: translateX(100px); }</style><div class="t">T</div>';
  const got = await actAll(body, ['document.querySelector(".t").getBoundingClientRect(); document.querySelector(".t").classList.add("on"); void document.querySelector(".t").getBoundingClientRect()', { still: true }]);
  assert.deepEqual(got, [{ ok: true }]);
  const left = await evaluate(page.cdp, page.sessionId, 'document.querySelector(".t").getBoundingClientRect().left');
  assert.equal(left, 100);
});

test("still waits for a transition beside an infinite animation, and does not wait on the infinite one", async () => {
  const body =
    '<style>@keyframes pulse { from { opacity: 1; } to { opacity: 0.5; } } .p { animation: pulse 1s ease-in-out infinite; } .t { position: absolute; left: 0; top: 0; width: 50px; height: 50px; transition: transform 300ms linear; } .t.on { transform: translateX(100px); }</style><div class="p">P</div><div class="t">T</div>';
  const started = Date.now();
  const got = await actAll(body, ['document.querySelector(".t").getBoundingClientRect(); document.querySelector(".t").classList.add("on"); void document.querySelector(".t").getBoundingClientRect()', { still: true }]);
  assert.deepEqual(got, [{ ok: true }]);
  assert.ok(Date.now() - started < 5000);
  const left = await evaluate(page.cdp, page.sessionId, 'document.querySelector(".t").getBoundingClientRect().left');
  assert.equal(left, 100);
});

test("style reads a pseudo-element's used size and names it when it differs", async () => {
  const body = '<style>.x { position: relative; width: 28px; height: 28px; } .x::after { content: ""; position: absolute; inset: 2px; }</style><button class="x">X</button>';
  assert.deepEqual(await act(body, { style: [".x", "width", "24px", "::after"] }), { ok: true });
  assert.deepEqual(await act(body, { style: [".x", "width", "28px", "::after"] }), { fail: '.x::after has width: "24px", not "28px"' });
  assert.deepEqual(await act(body, { style: [".x", "width", "28px"] }), { ok: true });
});

test("aligned passes outline rows level with their chart rows and fails a row or a bar off its chart row", async () => {
  const body = (rowShift, barTop) =>
    `<div class="tl-row" data-row="a" style="position: absolute; left: 0; top: ${rowShift}px; width: 100px; height: 34px">A</div>` +
    `<div class="tl-row" data-row="b" style="position: absolute; left: 0; top: 34px; width: 100px; height: 34px">B</div>` +
    `<div class="tl-rowline" style="position: absolute; left: 120px; top: 0; width: 200px; height: 34px"></div>` +
    `<div class="tl-rowline" style="position: absolute; left: 120px; top: 34px; width: 200px; height: 34px"></div>` +
    `<div data-bar="b" style="position: absolute; left: 140px; top: ${barTop}px; width: 40px; height: 18px"></div>`;
  assert.deepEqual(await act(body(0, 42), { aligned: true }), { ok: true });
  assert.equal((await act(body(4, 42), { aligned: true })).fail, "row a has its top at 4 px, its chart row at 0 px");
  assert.equal((await act(body(0, 60), { aligned: true })).fail, "the bar of row b spans 60..78 px, outside its chart row 34..68");
  assert.equal((await act('<div class="tl-row" data-row="a">A</div>', { aligned: true })).fail, "1 .tl-row against 0 .tl-rowline");
  assert.equal((await act("<p>x</p>", { aligned: true })).fail, "no .tl-row to align with the chart");
  const group = (gbarTop, labelTop) =>
    `<div class="tl-row" data-row="g" style="position: absolute; left: 0; top: 0; width: 100px; height: 34px">G</div>` +
    `<div class="tl-rowline" style="position: absolute; left: 120px; top: 0; width: 200px; height: 34px"></div>` +
    `<div class="gbar" data-gbar="g" style="position: absolute; left: 140px; top: ${gbarTop}px; width: 40px; height: 6px"></div>` +
    `<div class="bar-label group-label" data-group-label="g" style="position: absolute; left: 190px; top: ${labelTop}px; width: 40px; height: 18px"></div>`;
  assert.deepEqual(await act(group(14, 8), { aligned: true }), { ok: true });
  assert.equal((await act(group(40, 8), { aligned: true })).fail, "the group bar of row g spans 40..46 px, outside its chart row 0..34");
  assert.equal((await act(group(14, 30), { aligned: true })).fail, "the group label of row g spans 30..48 px, outside its chart row 0..34");
  assert.equal(
    (
      await act(
        '<div class="tl-row" data-row="a" style="position: absolute; left: 0; top: 0; width: 100px; height: 34px">A</div><div class="tl-rowline" style="position: absolute; left: 120px; top: 0; width: 200px; height: 34px"></div>',
        { aligned: true },
      )
    ).fail,
    "none of the 1 rows has a bar to align",
  );
});

test("tabBar passes one install of the three tabs whose last state and theme cyan match, and the exact install state when asked, and names what was sent otherwise", async () => {
  const TABS = [
    { id: "timeline", title: "Timeline", image: "calendar.day.timeline.left" },
    { id: "board", title: "Board", image: "rectangle.split.3x1" },
    { id: "list", title: "List", image: "list.bullet" },
  ];
  const sent = (calls) => `<script>window.__PROBE_TABBAR__ = ${JSON.stringify(calls)};</script>`;
  const install = (state, tabs = TABS) => ({ cmd: "tabbar_install", args: { bar: { tabs, state } } });
  const set = (state) => ({ cmd: "tabbar_set", args: { state } });
  const shown = { selected: "board", hidden: false, tint: "#24E0FF" };
  const want = (selected, hidden, install = null) => ({ tabBar: { selected, hidden, tint: "#24E0FF", install } });
  assert.deepEqual(await act(sent([install(shown)]), want("board", false)), { ok: true });
  assert.deepEqual(await act(sent([install(shown), set({ ...shown, hidden: true })]), want("board", true)), { ok: true });
  assert.equal(
    (await act(sent([install(shown), set({ ...shown, hidden: true })]), want("board", false))).fail,
    'the last tab bar state sent is {"selected":"board","hidden":true,"tint":"#24E0FF"} (tabbar_set), not selected board and hidden false',
  );
  assert.equal((await act(sent([]), want("board", false))).fail, "tabbar_install was sent 0 times, not once");
  assert.equal((await act(sent([install(shown), install(shown)]), want("board", false))).fail, "tabbar_install was sent 2 times, not once");
  assert.match((await act(sent([install(shown, TABS.slice(0, 2))]), want("board", false))).fail, /^tabbar_install sent the tabs /);
  assert.equal((await act(sent([install({ ...shown, tint: "cyan" })]), want("board", false))).fail, "the tab bar tint \"cyan\" is not the theme's cyan #24E0FF");
  assert.equal((await act(sent([install({ ...shown, tint: "#24E0FE" })]), want("board", false))).fail, "the tab bar tint \"#24E0FE\" is not the theme's cyan #24E0FF");
  const hiddenAsk = { selected: "board", hidden: true, tint: "#24E0FF" };
  assert.deepEqual(await act(sent([install(hiddenAsk), set(shown)]), want("board", false, hiddenAsk)), { ok: true });
  assert.equal(
    (await act(sent([install(shown)]), want("board", false, hiddenAsk))).fail,
    'tabbar_install asked {"selected":"board","hidden":false,"tint":"#24E0FF"}, not exactly {"selected":"board","hidden":true,"tint":"#24E0FF"}',
  );
  assert.match((await act(sent([install({ ...hiddenAsk, extra: 1 }), set(shown)]), want("board", false, hiddenAsk))).fail, /^tabbar_install asked /);
  assert.equal((await act("<script>delete window.__PROBE_TABBAR__;</script>", want("board", false))).fail, "the probe recorded no tabbar_* list");
});

test("pickTab and barGeometry call every tabbar listener with the payload, and fail when the page listens to none", async () => {
  const heard = `<script>window.__PROBE_LISTENERS__ = { "tabbar-picked": [7], "tabbar-geometry": [8] }; window.got = []; window._7 = function (e) { window.got.push(e); }; window._8 = function (e) { window.got.push(e); };</script>`;
  assert.deepEqual(await actAll(heard, [{ pickTab: ["list", true] }, { barGeometry: 64 }]), [{ ok: true }, { ok: true }]);
  assert.deepEqual(await evaluate(page.cdp, page.sessionId, "window.got"), [
    { event: "tabbar-picked", id: 0, payload: { id: "list", again: true } },
    { event: "tabbar-geometry", id: 0, payload: { height: 64 } },
  ]);
  assert.equal((await act("<script>window.__PROBE_LISTENERS__ = {};</script>", { pickTab: ["list", false] })).fail, "the page listens to no tabbar-picked event");
  assert.equal((await act("<script>window.__PROBE_LISTENERS__ = {};</script>", { barGeometry: 83 })).fail, "the page listens to no tabbar-geometry event");
});

test("insetBy passes a phone shell padded by the bar with its main area above it, and fails a wrong padding or a main area under the bar", async () => {
  const shell = (pad, mainHeight) =>
    `<div class="app phone" style="box-sizing: border-box; height: 300px; padding-bottom: ${pad}px; display: flex; flex-direction: column"><div class="phone-main" style="height: ${mainHeight}px; flex: none"></div></div>`;
  assert.deepEqual(await act(shell(83, 217), { insetBy: 83 }), { ok: true });
  assert.equal((await act(shell(0, 217), { insetBy: 83 })).fail, ".app.phone has padding-bottom 0px, not 83px");
  assert.equal((await act(shell(83, 260), { insetBy: 83 })).fail, ".phone-main ends at 260 px, under the 83 px tab bar of the 300 px window");
  assert.equal((await act("<div></div>", { insetBy: 83 })).fail, "no .app.phone and .phone-main to measure the tab bar inset on");
});

test("placed reads the view written to webboard.place", async () => {
  const stored = (place) =>
    `<script>var held = ${JSON.stringify(place === null ? {} : { "webboard.place": JSON.stringify(place) })}; Object.defineProperty(window, "localStorage", { configurable: true, value: { getItem: function (k) { return k in held ? held[k] : null; } } });</script>`;
  assert.deepEqual(await act(stored({ view: "list" }), { placed: "list" }), { ok: true });
  assert.equal((await act(stored({ view: "board" }), { placed: "list" })).fail, 'webboard.place holds the view "board", not "list"');
  assert.equal((await act(stored(null), { placed: "list" })).fail, "no webboard.place was written");
});

test("scrolledTo passes a scroller down or back at the top and fails one that is not", async () => {
  const box = (top) => `<div class="s" style="height: 50px; overflow: auto"><div style="height: 500px"></div></div><script>document.querySelector(".s").scrollTop = ${top};</script>`;
  assert.deepEqual(await act(box(100), { scrolledTo: [".s", "down"] }), { ok: true });
  assert.equal((await act(box(0), { scrolledTo: [".s", "down"] })).fail, ".s is at scrollTop 0, not scrolled down");
  assert.deepEqual(await act(box(0), { scrolledTo: [".s", "top"] }), { ok: true });
  assert.equal((await act(box(100), { scrolledTo: [".s", "top"] })).fail, ".s is still at scrollTop 100 after 2000 ms, not back at the top");
  assert.equal((await act("<div></div>", { scrolledTo: [".s", "top"] })).fail, "no .s to read the scroll of");
});

test("unexpectedAlerts: a native ask fails a state unless the state asserts its alerts", () => {
  const plain = { actions: [{ click: ["button"] }] };
  const asserting = { actions: [{ click: ["button"] }, { alerted: ["Discard theme changes?"] }] };
  assert.equal(unexpectedAlerts(plain, []), null);
  assert.equal(unexpectedAlerts(asserting, ["Discard theme changes?"]), null);
  assert.equal(unexpectedAlerts(plain, ["Remove person", "Delete step"]), 'the app asked alert_ask ["Remove person","Delete step"], and the state asserts no alert');
});
