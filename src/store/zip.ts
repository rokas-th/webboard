import { AppError } from "../services/ipc";

export interface ZipEntry {
  name: string;
  bytes: Uint8Array;
}

const LOCAL_SIGNATURE = 0x04034b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const END_SIGNATURE = 0x06054b50;
const LOCAL_FIXED = 30;
const CENTRAL_FIXED = 46;
const END_FIXED = 22;
const VERSION = 20;
const UTF8_FLAG = 0x0800;
const STORED = 0;
const MAX_ENTRIES = 0xffff;
const MAX_BYTES = 0xffffffff;
const FIRST_DOS_YEAR = 1980;
const LAST_DOS_YEAR = 2107;

const CRC_TABLE: readonly number[] = Array.from({ length: 256 }, (_, n) =>
  Array.from({ length: 8 }).reduce<number>((c) => (c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1), n),
);

export function crc32(bytes: Uint8Array): number {
  return (bytes.reduce((c, b) => CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8), 0xffffffff) ^ 0xffffffff) >>> 0;
}

const pad = (n: number, width: number): string => String(n).padStart(width, "0");

function dosTime(when: Date): { time: number; date: number } {
  const year = when.getFullYear();
  if (year < FIRST_DOS_YEAR || year > LAST_DOS_YEAR) {
    const shown = `${pad(year, 4)}-${pad(when.getMonth() + 1, 2)}-${pad(when.getDate(), 2)}`;
    throw new AppError("backup.limit", `A backup cannot carry a date before ${FIRST_DOS_YEAR} or after ${LAST_DOS_YEAR} (${shown}).`);
  }
  return {
    time: (when.getHours() << 11) | (when.getMinutes() << 5) | (when.getSeconds() >> 1),
    date: ((year - FIRST_DOS_YEAR) << 9) | ((when.getMonth() + 1) << 5) | when.getDate(),
  };
}

interface Placed {
  name: Uint8Array;
  bytes: Uint8Array;
  offset: number;
}

function placed(entries: readonly ZipEntry[]): { files: Placed[]; central: number; total: number } {
  const encoder = new TextEncoder();
  const named = entries.map((e) => ({ name: encoder.encode(e.name), bytes: e.bytes }));
  const sizes = named.map((f) => LOCAL_FIXED + f.name.length + f.bytes.length);
  const starts = sizes.reduce<number[]>((acc, size) => {
    acc.push(acc[acc.length - 1] + size);
    return acc;
  }, [0]);
  const files = named.map((f, i) => ({ ...f, offset: starts[i] }));
  const central = starts[starts.length - 1];
  const total = files.reduce((n, f) => n + CENTRAL_FIXED + f.name.length, central) + END_FIXED;
  return { files, central, total };
}

export function zipOf(entries: readonly ZipEntry[], when: Date): Uint8Array {
  if (entries.length > MAX_ENTRIES) throw new AppError("backup.limit", `A backup holds at most ${MAX_ENTRIES} plans; this one would hold ${entries.length}.`);
  const { files, central, total } = placed(entries);
  if (total > MAX_BYTES) throw new AppError("backup.limit", `A backup is at most 4 GiB; this one would be ${total} bytes.`);
  const { time, date } = dosTime(when);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  const common = (at: number, f: Placed, crc: number): void => {
    view.setUint16(at, VERSION, true);
    view.setUint16(at + 2, UTF8_FLAG, true);
    view.setUint16(at + 4, STORED, true);
    view.setUint16(at + 6, time, true);
    view.setUint16(at + 8, date, true);
    view.setUint32(at + 10, crc, true);
    view.setUint32(at + 14, f.bytes.length, true);
    view.setUint32(at + 18, f.bytes.length, true);
    view.setUint16(at + 22, f.name.length, true);
    view.setUint16(at + 24, 0, true);
  };
  const end = files.reduce((at, f) => {
    const crc = crc32(f.bytes);
    view.setUint32(f.offset, LOCAL_SIGNATURE, true);
    common(f.offset + 4, f, crc);
    out.set(f.name, f.offset + LOCAL_FIXED);
    out.set(f.bytes, f.offset + LOCAL_FIXED + f.name.length);
    view.setUint32(at, CENTRAL_SIGNATURE, true);
    view.setUint16(at + 4, VERSION, true);
    common(at + 6, f, crc);
    view.setUint16(at + 32, 0, true);
    view.setUint16(at + 34, 0, true);
    view.setUint16(at + 36, 0, true);
    view.setUint32(at + 38, 0, true);
    view.setUint32(at + 42, f.offset, true);
    out.set(f.name, at + CENTRAL_FIXED);
    return at + CENTRAL_FIXED + f.name.length;
  }, central);
  view.setUint32(end, END_SIGNATURE, true);
  view.setUint16(end + 4, 0, true);
  view.setUint16(end + 6, 0, true);
  view.setUint16(end + 8, files.length, true);
  view.setUint16(end + 10, files.length, true);
  view.setUint32(end + 12, end - central, true);
  view.setUint32(end + 16, central, true);
  view.setUint16(end + 20, 0, true);
  return out;
}
