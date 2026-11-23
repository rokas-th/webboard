import { describe, expect, it } from "vitest";
import { AppError } from "../services/ipc";
import { crc32, zipOf, type ZipEntry } from "./zip";

interface ReadEntry {
  name: string;
  bytes: Uint8Array;
  flags: number;
  method: number;
  crc: number;
  time: number;
  date: number;
}

function readZip(zip: Uint8Array): ReadEntry[] {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const end = zip.length - 22;
  expect(view.getUint32(end, true)).toBe(0x06054b50);
  const count = view.getUint16(end + 10, true);
  expect(view.getUint16(end + 8, true)).toBe(count);
  const size = view.getUint32(end + 12, true);
  const start = view.getUint32(end + 16, true);
  expect(start + size).toBe(end);
  const decode = (from: number, length: number): string => new TextDecoder("utf-8", { fatal: true }).decode(zip.subarray(from, from + length));
  let at = start;
  const one = (): ReadEntry => {
    expect(view.getUint32(at, true)).toBe(0x02014b50);
    const flags = view.getUint16(at + 8, true);
    const method = view.getUint16(at + 10, true);
    const time = view.getUint16(at + 12, true);
    const date = view.getUint16(at + 14, true);
    const crc = view.getUint32(at + 16, true);
    const packed = view.getUint32(at + 20, true);
    const unpacked = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const extra = view.getUint16(at + 30, true);
    const comment = view.getUint16(at + 32, true);
    const local = view.getUint32(at + 42, true);
    const name = decode(at + 46, nameLength);
    expect(packed).toBe(unpacked);
    expect(view.getUint32(local, true)).toBe(0x04034b50);
    expect(view.getUint16(local + 6, true)).toBe(flags);
    expect(view.getUint16(local + 8, true)).toBe(method);
    expect(view.getUint16(local + 10, true)).toBe(time);
    expect(view.getUint16(local + 12, true)).toBe(date);
    expect(view.getUint32(local + 14, true)).toBe(crc);
    expect(view.getUint32(local + 18, true)).toBe(packed);
    expect(view.getUint32(local + 22, true)).toBe(unpacked);
    const localName = view.getUint16(local + 26, true);
    const localExtra = view.getUint16(local + 28, true);
    expect(decode(local + 30, localName)).toBe(name);
    const data = local + 30 + localName + localExtra;
    const bytes = zip.slice(data, data + packed);
    expect(crc32(bytes)).toBe(crc);
    at += 46 + nameLength + extra + comment;
    return { name, bytes, flags, method, crc, time, date };
  };
  const entries = Array.from({ length: count }, one);
  expect(at).toBe(end);
  return entries;
}

const WHEN = new Date(2026, 10, 23, 14, 37, 58);

const text = (s: string): Uint8Array => new TextEncoder().encode(s);

describe("crc32", () => {
  it("answers cbf43926 for 123456789", () => {
    expect(crc32(text("123456789")).toString(16)).toBe("cbf43926");
  });

  it("answers 0 for nothing", () => {
    expect(crc32(new Uint8Array())).toBe(0);
  });
});

describe("zipOf", () => {
  it("writes stored entries an in-test reader parses back, with the UTF-8 flag, their CRC-32 and the DOS time", () => {
    const entries: ZipEntry[] = [
      { name: "MESA 1.0.webboard", bytes: text("WBX1 one") },
      { name: "Kuppel ü.webboard", bytes: text("WBX1 two, a little longer") },
      { name: "Empty.webboard", bytes: new Uint8Array() },
    ];
    const read = readZip(zipOf(entries, WHEN));
    expect(read.map((e) => [e.name, new TextDecoder().decode(e.bytes)])).toEqual([
      ["MESA 1.0.webboard", "WBX1 one"],
      ["Kuppel ü.webboard", "WBX1 two, a little longer"],
      ["Empty.webboard", ""],
    ]);
    expect(read.map((e) => [e.flags, e.method])).toEqual([
      [0x0800, 0],
      [0x0800, 0],
      [0x0800, 0],
    ]);
    expect(read.map((e) => e.crc)).toEqual(entries.map((e) => crc32(e.bytes)));
    expect(read.map((e) => [e.time, e.date])).toEqual(entries.map(() => [(14 << 11) | (37 << 5) | 29, ((2026 - 1980) << 9) | (11 << 5) | 23]));
  });

  it("writes an empty archive as the end record alone", () => {
    const zip = zipOf([], WHEN);
    expect(zip.length).toBe(22);
    expect(readZip(zip)).toEqual([]);
  });

  it("refuses more than 65535 entries", () => {
    const entries: ZipEntry[] = Array.from({ length: 65536 }, (_, i) => ({ name: `${i}.webboard`, bytes: new Uint8Array() }));
    expect(() => zipOf(entries, WHEN)).toThrow(new AppError("backup.limit", "A backup holds at most 65535 plans; this one would hold 65536."));
    const full = zipOf(entries.slice(1), WHEN);
    const end = new DataView(full.buffer, full.length - 22, 22);
    expect([end.getUint32(0, true), end.getUint16(8, true), end.getUint16(10, true)]).toEqual([0x06054b50, 65535, 65535]);
  });

  it("refuses an archive past 4 GiB before reading a byte", () => {
    const huge: ZipEntry = {
      name: "Huge.webboard",
      bytes: new Proxy(new Uint8Array(), {
        get: (_, key) => {
          if (key === "length" || key === "byteLength") return 0xffffffff;
          throw new Error(`read ${String(key)} of a huge entry`);
        },
      }),
    };
    expect(() => zipOf([huge], WHEN)).toThrow(new AppError("backup.limit", `A backup is at most 4 GiB; this one would be ${0xffffffff + 22 + 46 + 30 + 2 * "Huge.webboard".length} bytes.`));
  });

  it("refuses a time a DOS date cannot hold", () => {
    expect(() => zipOf([], new Date(1979, 11, 31))).toThrow("A backup cannot carry a date before 1980 or after 2107 (1979-12-31).");
  });
});
