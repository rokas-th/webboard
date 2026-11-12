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
  ["--dim", "#7485A0"],
  ["--heading", "#EAF3FF"],
];

const declared = new Map(
  [...tokens.matchAll(/(--[a-z0-9-]+)\s*:\s*(#[0-9A-Fa-f]{6})\s*;/g)].map((m) => [m[1], m[2].toUpperCase()]),
);

function token(name: string): string {
  const value = declared.get(name);
  if (value === undefined) throw new Error(`tokens.css declares no ${name}`);
  return value;
}

function luminance(hex: string): number {
  const channel = (at: number): number => {
    const c = parseInt(hex.slice(at, at + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

it("declares the eleven Cyberdeck tokens with their values", () => {
  expect(EXPECTED.map(([name]) => [name, declared.get(name)])).toEqual(EXPECTED);
});

it("keeps --dim at 4.5:1 or more on void, panel and panel-2", () => {
  expect(contrast("#FFFFFF", "#000000")).toBeCloseTo(21, 5);
  expect(contrast("#5A6B85", "#0A0A14")).toBeLessThan(4.5);
  expect(["--void", "--panel", "--panel-2"].map((bg) => [bg, contrast(token("--dim"), token(bg)) >= 4.5])).toEqual([
    ["--void", true],
    ["--panel", true],
    ["--panel-2", true],
  ]);
});

it("gives each of the eleven tokens a channel token with the same colour", () => {
  const channelsDeclared = new Map([...tokens.matchAll(/(--[a-z0-9-]+)-rgb\s*:\s*(\d+), (\d+), (\d+)\s*;/g)].map((m) => [m[1], [m[2], m[3], m[4]].map(Number)]));
  const fromHex = (hex: string): number[] => [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16));
  expect(EXPECTED.map(([name]) => [name, channelsDeclared.get(name)])).toEqual(EXPECTED.map(([name, hex]) => [name, fromHex(hex)]));
});
