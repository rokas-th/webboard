import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const CONF = fileURLToPath(new URL("../src-tauri/tauri.conf.json", import.meta.url));

function connectSrc(csp) {
  if (typeof csp === "string") {
    const directive = csp
      .split(";")
      .map((part) => part.trim().split(/\s+/))
      .find(([name]) => name === "connect-src");
    assert.ok(directive, `the CSP has no connect-src directive: ${csp}`);
    return directive.slice(1);
  }
  assert.ok(csp && typeof csp === "object", `app.security.csp is neither a string nor an object: ${JSON.stringify(csp)}`);
  const value = csp["connect-src"];
  if (typeof value === "string") {
    return value.split(/\s+/).filter(Boolean);
  }
  assert.ok(Array.isArray(value), `connect-src is neither a string nor an array: ${JSON.stringify(value)}`);
  return value;
}

test("the CSP allows only the WebBoard sync server", () => {
  const conf = JSON.parse(readFileSync(CONF, "utf8"));
  const tokens = connectSrc(conf.app.security.csp);
  assert.deepEqual(
    tokens.filter((token) => token.startsWith("wss:")),
    ["wss://webboard.rokass.org"],
  );
  assert.deepEqual(
    tokens.filter((token) => token.startsWith("ws:")),
    [],
  );
  assert.deepEqual(
    tokens.filter((token) => ["*", "https:", "http:", "wss:"].includes(token) || token.includes("*")),
    [],
  );
});
