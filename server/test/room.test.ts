import { env, evictDurableObject, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { getServerByName } from 'partyserver';
import * as encoding from 'lib0/encoding';
import { describe, expect, it, vi } from 'vitest';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';
import { CHUNK_BYTES, DEVICE_HEADER, MAX_MESSAGE_BYTES } from '../src/limits';
import type { Room } from '../src/room';
import { int } from '../src/sql';
import { connectDoc, type TestClient } from './client';

const DEV_A = 'devA0000000';
const DEV_B = 'devB0000000';
const DEV_C = 'devC0000000';
const MIB = 1024 * 1024;

function opener(doc: string, device: string | null): () => Promise<Response> {
  const headers: Record<string, string> = { Upgrade: 'websocket' };
  if (device !== null) {
    headers[DEVICE_HEADER] = device;
  }
  return async () => (await getServerByName(env.Room, doc)).fetch(new Request('https://x/parties/room/' + doc, { headers }));
}

function stubOf(doc: string): DurableObjectStub<Room> {
  return env.Room.get(env.Room.idFromName(doc));
}

function routed(doc: string, device: string): () => Promise<Response> {
  return () =>
    stubOf(doc).fetch(
      new Request('https://x/parties/room/' + doc, { headers: { Upgrade: 'websocket', 'x-partykit-namespace': 'room', [DEVICE_HEADER]: device } }),
    );
}

interface RawSocket {
  ws: WebSocket;
  greeted: Promise<void>;
  closed: Promise<{ code: number; reason: string }>;
}

async function raw(doc: string, device: string): Promise<RawSocket> {
  const response = await opener(doc, device)();
  const ws = response.webSocket;
  if (ws === null) {
    throw new Error(`The server answered ${response.status} instead of a WebSocket`);
  }
  ws.accept();
  const greeted = new Promise<void>((resolve) => ws.addEventListener('message', () => resolve()));
  const closed = new Promise<{ code: number; reason: string }>((resolve) =>
    ws.addEventListener('close', (event) => resolve({ code: event.code, reason: event.reason })),
  );
  return { ws, greeted, closed };
}

async function join(doc: string, device: string, ydoc?: Y.Doc): Promise<TestClient> {
  const client = await connectDoc(opener(doc, device), ydoc);
  await client.synced;
  return client;
}

async function closeAll(...clients: TestClient[]): Promise<void> {
  clients.forEach((client) => client.close());
  await Promise.all(clients.map((client) => client.closed));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  const { promise: timeout, reject } = Promise.withResolvers<never>();
  const timer = setTimeout(() => reject(new Error(`${what} took over ${ms} ms`)), ms);
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function emptyStep1(): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, 0);
  syncProtocol.writeSyncStep1(encoder, new Y.Doc());
  return encoding.toUint8Array(encoder);
}

function isStep2(frame: Uint8Array): boolean {
  return frame[0] === 0 && frame[1] === syncProtocol.messageYjsSyncStep2;
}

function isEmptyStep2(frame: Uint8Array): boolean {
  return frame.length === 5 && [0, 1, 2, 0, 0].every((byte, i) => frame[i] === byte);
}

async function until(check: () => boolean | Promise<boolean>, what: string, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${what}`);
    }
    await sleep(10);
  }
}

function randomText(length: number): string {
  const bytes = new Uint8Array(Math.ceil(length / 2));
  Array.from({ length: Math.ceil(bytes.length / 65_536) }, (_, i) =>
    crypto.getRandomValues(bytes.subarray(i * 65_536, (i + 1) * 65_536)),
  );
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('').slice(0, length);
}

function actions(client: TestClient): Y.Map<unknown> {
  return client.ydoc.getMap('actions');
}

function writeMany(client: TestClient, prefix: string, count: number, labelBytes: number): void {
  client.ydoc.transact(() => {
    Array.from({ length: count }, (_, i) => actions(client).set(`${prefix}${i}`, { lbl: randomText(labelBytes) }));
  });
}

async function count(doc: string, table: 'updates' | 'snapshot'): Promise<number> {
  return runInDurableObject(stubOf(doc), (_room, state) =>
    int(state.storage.sql.exec(`SELECT COUNT(DISTINCT ${table === 'updates' ? 'id' : 'part'}) AS n FROM ${table}`).one(), 'n'),
  );
}

async function stateBytes(doc: string): Promise<number> {
  return runInDurableObject(stubOf(doc), (room: Room) => room.stateBytes);
}

const PLAN_DELETED = { code: 4410, reason: 'Plan deleted' };

async function tablesOf(doc: string): Promise<string[]> {
  return runInDurableObject(stubOf(doc), (_room, state) =>
    state.storage.sql
      .exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_%' ESCAPE '\\' ORDER BY name")
      .toArray()
      .map((row) => String(row.name)),
  );
}

async function goneRows(doc: string): Promise<number> {
  return runInDurableObject(stubOf(doc), (_room, state) => int(state.storage.sql.exec('SELECT COUNT(*) AS n FROM gone').one(), 'n'));
}

async function alarmIn(doc: string): Promise<number | null> {
  return runInDurableObject(stubOf(doc), (_room, state) => state.storage.getAlarm());
}

async function keysIn(doc: string): Promise<string[]> {
  return runInDurableObject(stubOf(doc), async (_room, state) => [...(await state.storage.list()).keys()]);
}

describe('Room', () => {
  it('persists every update across a restarted object', async () => {
    const doc = 'persist';
    const a = await join(doc, DEV_A);
    const b = await join(doc, DEV_B);
    actions(a).set('a1', { lbl: 'one' });
    await until(() => actions(b).has('a1'), 'B to receive a1');
    await closeAll(a, b);
    await evictDurableObject(stubOf(doc), { webSockets: 'close' });
    const c = await join(doc, DEV_C);
    expect(actions(c).get('a1')).toEqual({ lbl: 'one' });
    await closeAll(c);
  });

  it('wakes from hibernation with tags intact', async () => {
    const doc = 'hibernate';
    const a = await join(doc, DEV_A);
    const b = await join(doc, DEV_B);
    await evictDurableObject(stubOf(doc));
    actions(a).set('a2', { lbl: 'two' });
    await until(() => actions(b).has('a2'), 'B to receive a2 after hibernation');
    expect(await stubOf(doc).closeDevice(DEV_A)).toBe(1);
    expect(await a.closed).toEqual({ code: 4403, reason: 'Device removed' });
    await closeAll(b);
  });

  it('schedules no alarm while a connected room is idle', async () => {
    const doc = 'idle';
    const a = await join(doc, DEV_A);
    const b = await join(doc, DEV_B);
    await sleep(200);
    expect(await runInDurableObject(stubOf(doc), (_room, state) => state.storage.getAlarm())).toBeNull();
    actions(a).set('a1', { lbl: 'one' });
    await until(() => actions(b).has('a1'), 'B to receive a1');
    expect(await runInDurableObject(stubOf(doc), (_room, state) => state.storage.getAlarm())).not.toBeNull();
    expect(await runDurableObjectAlarm(stubOf(doc))).toBe(true);
    await sleep(200);
    expect(await runInDurableObject(stubOf(doc), (_room, state) => state.storage.getAlarm())).toBeNull();
    await closeAll(a, b);
  });

  it('closes with 4500 when the update cannot be stored', async () => {
    const doc = 'unstored';
    const a = await join(doc, DEV_A);
    const b = await join(doc, DEV_B);
    await runInDurableObject(stubOf(doc), (_room, state) => {
      state.storage.sql.exec('DROP TABLE updates');
    });
    actions(a).set('a1', { lbl: 'one' });
    expect(await a.closed).toEqual({ code: 4500, reason: 'Server could not store the update' });
    await sleep(200);
    expect(actions(b).size).toBe(0);
    await closeAll(b);
  });

  it('refuses a malformed update with 1007', async () => {
    const doc = 'malformed';
    const socket = await raw(doc, DEV_A);
    socket.ws.send(new Uint8Array([0, 2, 3, 255, 255, 255]));
    expect(await socket.closed).toEqual({ code: 1007, reason: 'Malformed update' });
    expect(await count(doc, 'updates')).toBe(0);
  });

  it.each([
    ['an unknown sync subtype', [0, 7]],
    ['a truncated sync step 1', [0, 0, 5]],
    ['an unknown message type', [9]],
    ['a truncated awareness frame', [1, 5]],
  ])('refuses %s with 1007', async (_what, bytes) => {
    const doc = 'refuse-' + bytes.join('-');
    const socket = await raw(doc, DEV_A);
    socket.ws.send(new Uint8Array(bytes));
    expect(await socket.closed).toEqual({ code: 1007, reason: 'Malformed message' });
    expect(await count(doc, 'updates')).toBe(0);
  });

  it('refuses a string frame with 1007', async () => {
    const socket = await raw('refuse-string', DEV_A);
    socket.ws.send('__YPS:hello');
    expect(await socket.closed).toEqual({ code: 1007, reason: 'Malformed message' });
  });

  it('closes with 4500 and logs when the server cannot answer', async () => {
    const doc = 'send-failure';
    const logged = vi.spyOn(console, 'error');
    const socket = await raw(doc, DEV_A);
    await socket.greeted;
    await runInDurableObject(stubOf(doc), (room: Room) => {
      [...room.getConnections('d:' + DEV_A)].forEach((conn) => {
        conn.send = () => {
          throw new Error('forced send failure');
        };
      });
    });
    socket.ws.send(emptyStep1());
    expect(await socket.closed).toEqual({ code: 4500, reason: 'Server error' });
    expect(
      logged.mock.calls.some(
        (call) =>
          String(call[0]).includes(doc) && call.some((arg) => arg instanceof Error && arg.message === 'forced send failure'),
      ),
    ).toBe(true);
    logged.mockRestore();
  });

  it.each([
    [
      'the revoked read',
      (_room: Room, state: DurableObjectState): void => {
        state.storage.sql.exec('DROP TABLE revoked');
      },
    ],
    [
      'the compaction',
      (room: Room, state: DurableObjectState): void => {
        room.stateBytes = MAX_MESSAGE_BYTES + 1;
        state.storage.sql.exec('DROP TABLE snapshot');
      },
    ],
  ])('closes with 4500 and logs when %s fails at connect', async (what, breakRoom) => {
    const doc = 'connect-fault-' + what.replaceAll(' ', '-');
    const a = await join(doc, DEV_A);
    await runInDurableObject(stubOf(doc), breakRoom);
    const logged = vi.spyOn(console, 'error');
    const c = await connectDoc(opener(doc, DEV_C));
    expect(await c.closed).toEqual({ code: 4500, reason: 'Server error' });
    expect(c.errors).toEqual([]);
    expect(
      logged.mock.calls.some(
        (call) => String(call[0]).startsWith(`Room ${doc} failed while opening a connection`) && call.some((arg) => arg instanceof Error),
      ),
    ).toBe(true);
    logged.mockRestore();
    await closeAll(a);
  });

  it('drops the stored row and refuses with 1007 when an update cannot be applied', async () => {
    const doc = 'unapplied';
    const a = await join(doc, DEV_A);
    await runInDurableObject(stubOf(doc), (room: Room) => {
      const map = room.document.getMap('actions');
      const fail = (): void => {
        map.unobserve(fail);
        throw new Error('forced integration failure');
      };
      map.observe(fail);
    });
    actions(a).set('a1', { lbl: 'one' });
    expect(await a.closed).toEqual({ code: 1007, reason: 'Malformed update' });
    expect(await count(doc, 'updates')).toBe(0);
    const c = await join(doc, DEV_C);
    await closeAll(c);
    await evictDurableObject(stubOf(doc), { webSockets: 'close' });
    const d = await join(doc, DEV_C);
    expect(await count(doc, 'updates')).toBe(0);
    await closeAll(d);
  });

  it('closes a message over MAX_MESSAGE_BYTES with 4413', async () => {
    const doc = 'oversized-message';
    const a = await join(doc, DEV_A);
    const socket = await raw(doc, DEV_B);
    socket.ws.send(new Uint8Array(MAX_MESSAGE_BYTES + 1));
    expect(await socket.closed).toEqual({ code: 4413, reason: 'Message too large' });
    expect(await count(doc, 'updates')).toBe(0);
    await closeAll(a);
  });

  it('stores offline edits sent in sync step 2', async () => {
    const doc = 'offline';
    const a = await join(doc, DEV_A);
    const b = await join(doc, DEV_B);
    actions(a).set('a1', { lbl: 'one' });
    await until(() => actions(b).has('a1'), 'B to receive a1');
    await closeAll(b);
    actions(b).set('b1', { lbl: 'offline' });
    const rows = await count(doc, 'updates');
    const back = await join(doc, DEV_B, b.ydoc);
    await until(() => actions(a).has('b1'), 'A to receive the offline edit');
    expect(await count(doc, 'updates')).toBe(rows + 1);
    const copy = new Y.Doc();
    Y.applyUpdate(copy, Y.encodeStateAsUpdate(a.ydoc));
    const again = await join(doc, DEV_C, copy);
    await until(() => again.sent.some(isEmptyStep2), 'C to send an empty sync step 2');
    await sleep(200);
    expect(await count(doc, 'updates')).toBe(rows + 1);
    await closeAll(a, back, again);
    await evictDurableObject(stubOf(doc), { webSockets: 'close' });
    const c = await join(doc, DEV_C);
    expect(actions(c).get('b1')).toEqual({ lbl: 'offline' });
    await closeAll(c);
  });

  it('stores nothing and schedules no alarm for a sync step 2 the room already holds', async () => {
    const doc = 'up-to-date';
    const a = await join(doc, DEV_A);
    actions(a).set('k', { lbl: 'one' });
    actions(a).set('k', { lbl: 'two' });
    await until(async () => (await count(doc, 'updates')) === 2, 'both writes to be stored');
    expect(await runDurableObjectAlarm(stubOf(doc))).toBe(true);
    expect(await count(doc, 'updates')).toBe(0);
    await closeAll(a);
    const back = await join(doc, DEV_A, a.ydoc);
    await until(() => back.sent.some(isStep2), 'A to send its sync step 2');
    expect(back.sent.filter(isStep2).some((frame) => !isEmptyStep2(frame))).toBe(true);
    await sleep(200);
    expect(await count(doc, 'updates')).toBe(0);
    expect(await runInDurableObject(stubOf(doc), (_room, state) => state.storage.getAlarm())).toBeNull();
    await closeAll(back);
  });

  it('stores a sync step 2 that only deletes', async () => {
    const doc = 'offline-delete';
    const a = await join(doc, DEV_A);
    actions(a).set('k', { lbl: 'one' });
    await until(async () => (await count(doc, 'updates')) === 1, 'the write to be stored');
    await closeAll(a);
    actions(a).delete('k');
    const back = await join(doc, DEV_A, a.ydoc);
    await until(async () => (await count(doc, 'updates')) === 2, 'the offline delete to be stored');
    await closeAll(back);
    await evictDurableObject(stubOf(doc), { webSockets: 'close' });
    const c = await join(doc, DEV_C);
    expect(actions(c).has('k')).toBe(false);
    await closeAll(c);
  });

  it('stores an update larger than one row', async () => {
    const doc = 'large-update';
    const a = await join(doc, DEV_A);
    writeMany(a, 'big', 2_500, 1_000);
    await until(async () => (await count(doc, 'updates')) > 0, 'the update to be stored');
    const parts = await runInDurableObject(stubOf(doc), (_room, state) =>
      state.storage.sql
        .exec('SELECT id, part FROM updates ORDER BY id, part')
        .toArray()
        .map((row) => ({ id: int(row, 'id'), part: int(row, 'part') })),
    );
    expect(parts).toEqual([
      { id: 1, part: 0 },
      { id: 1, part: 1 },
      { id: 1, part: 2 },
    ]);
    await closeAll(a);
    await evictDurableObject(stubOf(doc), { webSockets: 'close' });
    const c = await join(doc, DEV_C);
    expect(actions(c).toJSON()).toEqual(actions(a).toJSON());
    await closeAll(c);
  });

  it('compacts a document over 2 MB and round-trips', async () => {
    const doc = 'compact';
    const a = await join(doc, DEV_A);
    Array.from({ length: 26 }, (_, t) => writeMany(a, `t${t}-`, 100, 1_000));
    await until(async () => (await count(doc, 'updates')) === 26, 'all 26 updates to be stored');
    expect(await runDurableObjectAlarm(stubOf(doc))).toBe(true);
    expect(await count(doc, 'updates')).toBe(0);
    const { encoded, sizes } = await runInDurableObject(stubOf(doc), (room: Room, state) => ({
      encoded: Y.encodeStateAsUpdate(room.document).length,
      sizes: state.storage.sql
        .exec('SELECT length(data) AS size FROM snapshot ORDER BY part')
        .toArray()
        .map((row) => int(row, 'size')),
    }));
    expect(encoded).toBeGreaterThan(2_000_000);
    expect(sizes.length).toBe(Math.ceil(encoded / CHUNK_BYTES));
    expect(sizes.every((size) => size <= 1_000_000)).toBe(true);
    expect(await stateBytes(doc)).toBe(encoded);
    await closeAll(a);
    await evictDurableObject(stubOf(doc), { webSockets: 'close' });
    const c = await join(doc, DEV_C);
    expect(actions(c).size).toBe(2_600);
    expect(actions(c).toJSON()).toEqual(actions(a).toJSON());
    await closeAll(c);
  });

  it('refuses a revoked device', async () => {
    const doc = 'revoked';
    const a = await join(doc, DEV_A);
    expect(await stubOf(doc).closeDevice(DEV_A)).toBe(1);
    expect(await a.closed).toEqual({ code: 4403, reason: 'Device removed' });
    const logged = vi.spyOn(console, 'error');
    const again = await connectDoc(opener(doc, DEV_A));
    expect(await again.closed).toEqual({ code: 4403, reason: 'Device removed' });
    await expect(again.synced).rejects.toThrow('closed 4403 Device removed before sync');
    await sleep(200);
    expect(logged.mock.calls.filter((call) => String(call[0]).startsWith(`Room ${doc}`))).toEqual([]);
    logged.mockRestore();
  });

  it('a restored device connects again', async () => {
    const doc = 'restored';
    expect(await stubOf(doc).closeDevice(DEV_A)).toBe(0);
    const refused = await connectDoc(opener(doc, DEV_A));
    expect(await refused.closed).toEqual({ code: 4403, reason: 'Device removed' });
    await stubOf(doc).restoreDevice(DEV_A);
    const a = await join(doc, DEV_A);
    actions(a).set('a1', { lbl: 'back' });
    await until(async () => (await count(doc, 'updates')) === 1, 'the restored device to write');
    await closeAll(a);
  });

  it('refuses a socket without the device header with 4500, logging the reason and sending no stack trace', async () => {
    const doc = 'no-header';
    const logged = vi.spyOn(console, 'error');
    const missing = await connectDoc(opener(doc, null));
    expect(await missing.closed).toEqual({ code: 4500, reason: 'Server error' });
    expect(missing.errors).toEqual([]);
    const invalid = await connectDoc(opener(doc, 'short'));
    expect(await invalid.closed).toEqual({ code: 4500, reason: 'Server error' });
    expect(invalid.errors).toEqual([]);
    expect(
      logged.mock.calls.filter(
        (call) =>
          String(call[0]).startsWith(`Room ${doc} failed while opening a connection`) &&
          call.some((arg) => arg instanceof Error && arg.message.includes(DEVICE_HEADER)),
      ),
    ).toHaveLength(2);
    logged.mockRestore();
  });

  it('closes with 4500 and sends no stack trace when the stored plan cannot be loaded, and loads once storage is sound', async () => {
    const doc = 'load-fault';
    const a = await join(doc, DEV_A);
    actions(a).set('a1', { lbl: 'one' });
    await until(async () => (await count(doc, 'updates')) === 1, 'a1 to be stored');
    await closeAll(a);
    await runInDurableObject(stubOf(doc), (_room, state) => {
      state.storage.sql.exec("INSERT INTO updates (id, part, data) VALUES (99, 0, 'not a blob')");
    });
    await evictDurableObject(stubOf(doc));
    const logged = vi.spyOn(console, 'error');
    const c = await connectDoc(routed(doc, DEV_C));
    expect(await c.closed).toEqual({ code: 4500, reason: 'Server error' });
    expect(c.errors).toEqual([]);
    expect(
      logged.mock.calls.some(
        (call) =>
          String(call[0]).startsWith(`Room ${doc} failed while opening a connection`) &&
          call.some((arg) => arg instanceof Error && arg.message === 'Storage holds a string where a BLOB belongs'),
      ),
    ).toBe(true);
    logged.mockRestore();
    await runInDurableObject(stubOf(doc), (_room, state) => {
      state.storage.sql.exec('DELETE FROM updates WHERE id = 99');
    });
    const b = await join(doc, DEV_B);
    expect(actions(b).get('a1')).toEqual({ lbl: 'one' });
    await closeAll(b);
  });

  it('refuses a connect when the stored plan is over MAX_MESSAGE_BYTES with 4413', async () => {
    const doc = 'oversized-plan';
    const a = await join(doc, DEV_A);
    const writes = MAX_MESSAGE_BYTES / MIB + 1;
    Array.from({ length: writes }, (_, i) => writeMany(a, `m${i}-`, 1, MIB - 256));
    await until(async () => (await count(doc, 'updates')) === writes, 'every 1 MiB write to be stored', 30_000);
    const c = await connectDoc(opener(doc, DEV_C));
    expect(await c.closed).toEqual({ code: 4413, reason: 'Too large to sync' });
    expect(await count(doc, 'updates')).toBe(0);
    expect(await stateBytes(doc)).toBeGreaterThan(MAX_MESSAGE_BYTES);
    await closeAll(a);
  });

  it('compacts before refusing a connect whose rewrites passed MAX_MESSAGE_BYTES', async () => {
    const doc = 'rewrites';
    const a = await join(doc, DEV_A);
    const rewrites = MAX_MESSAGE_BYTES / MIB + 1;
    Array.from({ length: rewrites }, () => actions(a).set('big', { lbl: randomText(MIB) }));
    await until(async () => (await count(doc, 'updates')) === rewrites, 'every rewrite to be stored', 30_000);
    expect(await stateBytes(doc)).toBeGreaterThan(MAX_MESSAGE_BYTES);
    const c = await join(doc, DEV_C);
    expect(actions(c).get('big')).toEqual(actions(a).get('big'));
    expect(await count(doc, 'updates')).toBe(0);
    expect(await stateBytes(doc)).toBeLessThan(2 * MIB);
    await closeAll(a, c);
  });

  it('sends a first sync just under MAX_MESSAGE_BYTES', async () => {
    const doc = 'first-sync';
    const target = MAX_MESSAGE_BYTES - MIB;
    const a = await join(doc, DEV_A);
    const writes = Math.floor(target / MIB);
    Array.from({ length: writes }, (_, i) => writeMany(a, `m${i}-`, 1, MIB - 256));
    await until(async () => (await count(doc, 'updates')) === writes, 'every 1 MiB write to be stored', 30_000);
    const stored = await stateBytes(doc);
    expect(stored).toBeLessThanOrEqual(target);
    expect(stored).toBeGreaterThan(target - 8 * 1024);
    await closeAll(a);
    const started = Date.now();
    const c = await connectDoc(opener(doc, DEV_C));
    await within(c.synced, 20_000, 'the first sync');
    expect(Date.now() - started).toBeLessThan(20_000);
    expect(actions(c).size).toBe(writes);
    await closeAll(c);
  });
});

describe('Room purge', () => {
  it('erases a plan: closes its sockets with 4410, keeps no history, no alarm and one gone row', async () => {
    const doc = 'purge-erase';
    const a = await join(doc, DEV_A);
    actions(a).set('a1', { lbl: 'one' });
    await until(async () => (await count(doc, 'updates')) === 1, 'a1 to be stored');
    expect(await alarmIn(doc)).not.toBeNull();
    expect(await stubOf(doc).purge()).toBe(1);
    expect(await a.closed).toEqual(PLAN_DELETED);
    expect(await tablesOf(doc)).toEqual(['gone']);
    expect(await goneRows(doc)).toBe(1);
    expect(await alarmIn(doc)).toBeNull();
    expect(await keysIn(doc)).toEqual([]);
  });

  it('a purge of a purged room closes what is open and keeps one gone row', async () => {
    const doc = 'purge-twice';
    expect(await stubOf(doc).purge()).toBe(0);
    expect(await stubOf(doc).purge()).toBe(0);
    expect(await tablesOf(doc)).toEqual(['gone']);
    expect(await goneRows(doc)).toBe(1);
  });

  it('refuses a WebSocket to a purged room with 4410, also after eviction, and creates no tables', async () => {
    const doc = 'purge-refuse';
    const a = await join(doc, DEV_A);
    expect(await stubOf(doc).purge()).toBe(1);
    await a.closed;
    const logged = vi.spyOn(console, 'error');
    const late = await connectDoc(opener(doc, DEV_B));
    expect(await late.closed).toEqual(PLAN_DELETED);
    await evictDurableObject(stubOf(doc));
    const cold = await connectDoc(routed(doc, DEV_C));
    expect(await cold.closed).toEqual(PLAN_DELETED);
    expect(await tablesOf(doc)).toEqual(['gone']);
    expect(logged.mock.calls.filter((call) => String(call[0]).startsWith(`Room ${doc}`))).toEqual([]);
    logged.mockRestore();
  });

  it('a room that was never purged opens and has no gone table', async () => {
    const doc = 'purge-never';
    const a = await join(doc, DEV_A);
    expect(await tablesOf(doc)).toEqual(['revoked', 'snapshot', 'updates']);
    await closeAll(a);
  });

  it('closes an open socket with 4410 on its next message once the room is gone', async () => {
    const doc = 'purge-receive';
    const a = await join(doc, DEV_A);
    const purged = await runInDurableObject(stubOf(doc), async (room: Room) => {
      vi.spyOn(room, 'getConnections').mockReturnValueOnce([]);
      return room.purge();
    });
    expect(purged).toBe(0);
    actions(a).set('a1', { lbl: 'late' });
    expect(await a.closed).toEqual(PLAN_DELETED);
    expect(await tablesOf(doc)).toEqual(['gone']);
  });

  it('a live room reads the tombstone once per wake, not on every message', async () => {
    const doc = 'purge-read-once';
    const a = await join(doc, DEV_A);
    actions(a).set('a1', { lbl: 'one' });
    await until(async () => (await count(doc, 'updates')) === 1, 'a1 to be stored');
    await runInDurableObject(stubOf(doc), (_room, state) => {
      state.storage.sql.exec('CREATE TABLE gone (at INTEGER NOT NULL)');
      state.storage.sql.exec('INSERT INTO gone (at) VALUES (1)');
    });
    actions(a).set('a2', { lbl: 'two' });
    await until(async () => (await count(doc, 'updates')) === 2, 'a2 to be stored');
    await closeAll(a);
    await evictDurableObject(stubOf(doc));
    const cold = await connectDoc(routed(doc, DEV_B));
    expect(await cold.closed).toEqual(PLAN_DELETED);
  });

  it('an alarm on a purged room writes nothing', async () => {
    const doc = 'purge-alarm';
    expect(await stubOf(doc).purge()).toBe(0);
    await evictDurableObject(stubOf(doc));
    await runInDurableObject(stubOf(doc), async (_room, state) => state.storage.setAlarm(Date.now() + 60_000));
    expect(await runDurableObjectAlarm(stubOf(doc))).toBe(true);
    expect(await tablesOf(doc)).toEqual(['gone']);
  });

  it('closing or restoring a device in a purged room does nothing', async () => {
    const doc = 'purge-devices';
    expect(await stubOf(doc).purge()).toBe(0);
    expect(await stubOf(doc).closeDevice(DEV_A)).toBe(0);
    await stubOf(doc).restoreDevice(DEV_A);
    expect(await tablesOf(doc)).toEqual(['gone']);
  });
});
