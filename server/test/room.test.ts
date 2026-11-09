import { env, evictDurableObject, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { getServerByName } from 'partyserver';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { CHUNK_BYTES, DEVICE_HEADER, MAX_MESSAGE_BYTES } from '../src/limits';
import type { Room } from '../src/room';
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
    state.storage.sql
      .exec<{ n: number }>(`SELECT COUNT(DISTINCT ${table === 'updates' ? 'id' : 'part'}) AS n FROM ${table}`)
      .one().n,
  );
}

async function stateBytes(doc: string): Promise<number> {
  return runInDurableObject(stubOf(doc), (room: Room) => room.stateBytes);
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
    const response = await opener(doc, DEV_A)();
    const ws = response.webSocket;
    if (ws === null) {
      throw new Error('no WebSocket');
    }
    ws.accept();
    const closed = new Promise<{ code: number; reason: string }>((resolve) =>
      ws.addEventListener('close', (event) => resolve({ code: event.code, reason: event.reason })),
    );
    ws.send(new Uint8Array([0, 2, 3, 255, 255, 255]));
    expect(await closed).toEqual({ code: 1007, reason: 'Malformed update' });
    expect(await count(doc, 'updates')).toBe(0);
  });

  it('closes a message over MAX_MESSAGE_BYTES with 4413', async () => {
    const doc = 'oversized-message';
    const a = await join(doc, DEV_A);
    const response = await opener(doc, DEV_B)();
    const ws = response.webSocket;
    if (ws === null) {
      throw new Error('no WebSocket');
    }
    ws.accept();
    const closed = new Promise<{ code: number; reason: string }>((resolve) =>
      ws.addEventListener('close', (event) => resolve({ code: event.code, reason: event.reason })),
    );
    ws.send(new Uint8Array(MAX_MESSAGE_BYTES + 1));
    expect(await closed).toEqual({ code: 4413, reason: 'Message too large' });
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
    await sleep(200);
    expect(await count(doc, 'updates')).toBe(rows + 1);
    await closeAll(a, back, again);
    await evictDurableObject(stubOf(doc), { webSockets: 'close' });
    const c = await join(doc, DEV_C);
    expect(actions(c).get('b1')).toEqual({ lbl: 'offline' });
    await closeAll(c);
  });

  it('stores an update larger than one row', async () => {
    const doc = 'large-update';
    const a = await join(doc, DEV_A);
    writeMany(a, 'big', 2_500, 1_000);
    await until(async () => (await count(doc, 'updates')) > 0, 'the update to be stored');
    const parts = await runInDurableObject(stubOf(doc), (_room, state) =>
      state.storage.sql.exec<{ id: number; part: number }>('SELECT id, part FROM updates ORDER BY id, part').toArray(),
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
        .exec<{ size: number }>('SELECT length(data) AS size FROM snapshot ORDER BY part')
        .toArray()
        .map((row) => row.size),
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
    const again = await connectDoc(opener(doc, DEV_A));
    expect(await again.closed).toEqual({ code: 4403, reason: 'Device removed' });
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

  it('refuses a socket without the device header', async () => {
    const doc = 'no-header';
    const missing = await connectDoc(opener(doc, null));
    expect((await missing.closed).code).toBe(1011);
    const invalid = await connectDoc(opener(doc, 'short'));
    expect((await invalid.closed).code).toBe(1011);
  });

  it('refuses a connect when the stored plan is over MAX_MESSAGE_BYTES with 4413', async () => {
    const doc = 'oversized-plan';
    const a = await join(doc, DEV_A);
    await runInDurableObject(stubOf(doc), (room: Room) => {
      room.stateBytes = MAX_MESSAGE_BYTES + 1;
    });
    const c = await connectDoc(opener(doc, DEV_C));
    expect(await c.closed).toEqual({ code: 4413, reason: 'Too large to sync' });
    await closeAll(a);
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
    await Promise.race([
      c.synced,
      sleep(20_000).then(() => {
        throw new Error('first sync took over 20 s');
      }),
    ]);
    expect(Date.now() - started).toBeLessThan(20_000);
    expect(actions(c).size).toBe(writes);
    await closeAll(c);
  });
});
