import { it, expect } from "vitest";
import tokens from "./tokens.css?raw";

const EXPECTED: readonly (readonly [string, string])[] = [
  ["--void", "#0A0A14"],
  ["--panel", "#10101E"],
  ["--panel-2", "#16162A"],
  ["--line", "#23233D"],
  ["--cyan", "#24E0FF"],
  ["--cyan-dim", "#158CA6"],
  ["--amber", "#FFB000"],
  ["--magenta", "#FF3B6B"],
  ["--text", "#C8D3E0"],
  ["--dim", "#5A6B85"],
  ["--heading", "#EAF3FF"],
];

it("declares the eleven Cyberdeck tokens with their values", () => {
  const declared = new Map(
    [...tokens.matchAll(/(--[a-z0-9-]+)\s*:\s*(#[0-9A-Fa-f]{6})\s*;/g)].map((m) => [m[1], m[2].toUpperCase()]),
  );
  expect(EXPECTED.map(([name]) => [name, declared.get(name)])).toEqual(EXPECTED);
});
