import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { getServerByName } from 'partyserver';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEVICE_HEADER } from '../src/limits';
import type { Room } from '../src/room';
import type { Space } from '../src/space';
import { connectDoc, type TestClient } from './client';
import { newDoc, roomExists, value } from './helpers';

const SECRET = env.SETUP_SECRET;
const DEV_A = 'devA0000000';
const DEV_B = 'devB0000000';
const DEV_C = 'devC0000000';
function closeFailed(untold: number): unknown {
  const plans = untold === 1 ? '1 plan was' : `${untold} plans were`;
  const that = untold === 1 ? 'that plan' : 'those plans';
  return {
    ok: false,
    status: 500,
    error: 'internal',
    message: `The device was removed, but ${plans} not told to close its connections. The server tries again in a minute, then less often, at least once an hour; until then the device keeps syncing ${that} while it stays connected.`,
  };
}
function restoreFailed(untold: number): unknown {
  const plans = untold === 1 ? '1 plan was' : `${untold} plans were`;
  return {
    ok: false,
    status: 500,
    error: 'internal',
    message: `This device did not join: ${plans} not told to let it connect again. Join again.`,
  };
}
const REMOVED = { code: 4403, reason: 'Device removed' };
const PLAN_DELETED = { code: 4410, reason: 'Plan deleted' };
const GONE = { ok: false, status: 410, error: 'gone', message: 'This plan was deleted forever on another device.' };
const PURGE_PENDING = {
  ok: false,
  status: 500,
  error: 'purge_pending',
  message: 'The plan is deleted, but the server has not erased its history yet. It tries again every minute.',
};

function spaceOf(name: string): DurableObjectStub<Space> {
  return env.Space.getByName('t-' + name);
}

async function connect(space: DurableObjectStub<Space>, token: string, doc: string, device: string): Promise<TestClient> {
  const issued = value(await space.ticket(token, doc));
  expect(await space.consumeTicket(issued.ticket, doc)).toEqual({ ok: true, value: { deviceId: device } });
  return connectDoc(async () =>
    (await getServerByName(env.Room, doc)).fetch(
      new Request('https://x/parties/room/' + doc, { headers: { Upgrade: 'websocket', [DEVICE_HEADER]: device } }),
    ),
  );
}

async function synced(space: DurableObjectStub<Space>, token: string, doc: string, device: string): Promise<TestClient> {
  const client = await connect(space, token, doc, device);
  await client.synced;
  return client;
}

async function revokedIn(doc: string, device: string): Promise<boolean> {
  return runInDurableObject(env.Room.getByName(doc), (_room, state) =>
    state.storage.sql.exec('SELECT 1 FROM revoked WHERE device = ?', device).toArray().length > 0,
  );
}

async function untoldIn(space: DurableObjectStub<Space>): Promise<string[]> {
  return runInDurableObject(space, (_space, state) =>
    state.storage.sql
      .exec('SELECT device, doc FROM untold ORDER BY device, doc')
      .toArray()
      .map((row) => `${String(row.device)} ${String(row.doc)}`),
  );
}

async function retryOf(space: DurableObjectStub<Space>, device: string): Promise<{ delay: number; due: number } | null> {
  return runInDurableObject(space, (_space, state) => {
    const rows = state.storage.sql.exec('SELECT delay, due FROM retry WHERE device = ?', device).toArray();
    return rows.length === 0 ? null : { delay: Number(rows[0].delay), due: Number(rows[0].due) };
  });
}

async function dueNow(space: DurableObjectStub<Space>): Promise<void> {
  await runInDurableObject(space, (_space, state) => {
    state.storage.sql.exec('UPDATE retry SET due = ?', Date.now());
  });
}

async function alarmOf(space: DurableObjectStub<Space>): Promise<number | null> {
  return runInDurableObject(space, async (_space, state) => state.storage.getAlarm());
}

async function purgedIn(space: DurableObjectStub<Space>): Promise<{ doc: string; device: string; erased: boolean }[]> {
  return runInDurableObject(space, (_space, state) =>
    state.storage.sql
      .exec('SELECT doc, device, erased_at IS NOT NULL AS erased FROM purged ORDER BY at, doc')
      .toArray()
      .map((row) => ({ doc: String(row.doc), device: String(row.device), erased: row.erased === 1 })),
  );
}

async function rowsFor(space: DurableObjectStub<Space>, doc: string): Promise<number> {
  return runInDurableObject(space, (_space, state) =>
    ['joins', 'tickets', 'untold']
      .map((table) => Number(state.storage.sql.exec(`SELECT COUNT(*) AS n FROM ${table} WHERE doc = ?`, doc).one().n))
      .reduce((sum, n) => sum + n, 0),
  );
}

async function roomTables(doc: string): Promise<string[]> {
  return runInDurableObject(env.Room.getByName(doc), (_room, state) =>
    state.storage.sql
      .exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_%' ESCAPE '\\' ORDER BY name")
      .toArray()
      .map((row) => String(row.name)),
  );
}

function cellText(cell: unknown): string {
  return cell instanceof ArrayBuffer ? new TextDecoder().decode(cell) : String(cell);
}

async function storedText(stub: DurableObjectStub<Space> | DurableObjectStub<Room>): Promise<string[]> {
  return runInDurableObject(stub, async (_instance, state) => {
    const tables = state.storage.sql
      .exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_%' ESCAPE '\\'")
      .toArray()
      .map((row) => String(row.name));
    const cells = tables.flatMap((table) =>
      state.storage.sql.exec(`SELECT * FROM ${table}`).toArray().flatMap((row) => Object.values(row).map(cellText)),
    );
    const stored = [...(await state.storage.list()).entries()].flatMap(([key, kept]) => [key, cellText(kept)]);
    return [...cells, ...stored];
  });
}

async function failPurgeIn(space: DurableObjectStub<Space>, failing: () => boolean): Promise<void> {
  await runInDurableObject(space, (instance: Space) => {
    const real = instance.rooms.purge;
    vi.spyOn(instance.rooms, 'purge').mockImplementation(async (doc) => {
      if (failing()) {
        throw new Error('room down');
      }
      return real(doc);
    });
  });
}

async function closeAll(...clients: TestClient[]): Promise<void> {
  clients.forEach((client) => client.close());
  await Promise.all(clients.map((client) => client.closed));
}

async function twoDevices(space: DurableObjectStub<Space>): Promise<{ spaceId: string; a: string; b: string }> {
  const a = value(await space.enrol(SECRET, DEV_A, 'iPad', '1.1.1.1'));
  const b = value(await space.enrol(SECRET, DEV_B, 'Mac', '1.1.1.1'));
  return { spaceId: a.spaceId, a: a.token, b: b.token };
}

async function failCloseIn(space: DurableObjectStub<Space>, failing: string): Promise<void> {
  await runInDurableObject(space, (instance: Space) => {
    const real = instance.rooms.close;
    vi.spyOn(instance.rooms, 'close').mockImplementation(async (doc, deviceId) => {
      if (doc === failing) {
        throw new Error('room down');
      }
      return real(doc, deviceId);
    });
  });
}

async function failRestoreIn(space: DurableObjectStub<Space>, failing: string): Promise<void> {
  await runInDurableObject(space, (instance: Space) => {
    const real = instance.rooms.restore;
    vi.spyOn(instance.rooms, 'restore').mockImplementation(async (doc, deviceId) => {
      if (doc === failing) {
        throw new Error('room down');
      }
      return real(doc, deviceId);
    });
  });
}

function roomDown(call: string, doc: string): unknown[] {
  return [`Space: ${call}(${DEV_A}) failed in room ${doc}`, expect.objectContaining({ message: 'room down' })];
}

describe('Space', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('creates its tables when it starts', async () => {
    const tables = await runInDurableObject(spaceOf('schema'), (_space, state) =>
      state.storage.sql
        .exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_%' ESCAPE '\\' ORDER BY name")
        .toArray()
        .map((row) => row.name),
    );
    expect(tables).toEqual(['attempts', 'codes', 'devices', 'joins', 'meta', 'purged', 'retry', 'tickets', 'untold']);
  });

  it('removing a device closes its sockets in every room it joined', async () => {
    const space = spaceOf('remove-closes');
    const { a, b } = await twoDevices(space);
    const docs = [newDoc(), newDoc()];
    const clients = [await synced(space, a, docs[0], DEV_A), await synced(space, a, docs[1], DEV_A)];
    expect(await space.removeDevice(b, DEV_A)).toEqual({ ok: true, value: { closed: 2 } });
    expect(await Promise.all(clients.map((client) => client.closed))).toEqual([REMOVED, REMOVED]);
    expect(await space.ticket(a, docs[0])).toEqual({
      ok: false,
      status: 403,
      error: 'revoked',
      message: 'This device was removed from the space.',
    });
  });

  it('recovery re-admits a removed device', async () => {
    const space = spaceOf('recovery');
    const { a, b } = await twoDevices(space);
    const doc = newDoc();
    const first = await synced(space, a, doc, DEV_A);
    expect(value(await space.removeDevice(b, DEV_A)).closed).toBe(1);
    await first.closed;
    expect(await revokedIn(doc, DEV_A)).toBe(true);
    const again = value(await space.enrol(SECRET, DEV_A, 'iPad', '1.1.1.1'));
    expect(again.deviceId).toBe(DEV_A);
    expect(again.token).not.toBe(a);
    expect(await revokedIn(doc, DEV_A)).toBe(false);
    const back = await synced(space, again.token, doc, DEV_A);
    await closeAll(back);
  });

  it('a removed device re-joins with a pairing code', async () => {
    const space = spaceOf('rejoin-code');
    const { spaceId, a, b } = await twoDevices(space);
    const doc = newDoc();
    const first = await synced(space, a, doc, DEV_A);
    value(await space.removeDevice(b, DEV_A));
    await first.closed;
    const code = value(await space.pairCode(b)).code;
    const claimed = value(await space.claim(code, DEV_A, 'iPad 2', '1.1.1.1'));
    expect(claimed).toEqual({ spaceId, deviceId: DEV_A, token: claimed.token });
    const back = await synced(space, claimed.token, doc, DEV_A);
    expect(await revokedIn(doc, DEV_A)).toBe(false);
    const listed = value(await space.devices(b)).devices.filter((d) => d.id === DEV_A);
    expect(listed.map((d) => d.name)).toEqual(['iPad 2']);
    await closeAll(back);
  });

  it('the device list leaves out removed devices', async () => {
    const space = spaceOf('device-list');
    const { b } = await twoDevices(space);
    const ids = async (): Promise<string[]> => value(await space.devices(b)).devices.map((d) => d.id);
    value(await space.removeDevice(b, DEV_A));
    expect(await ids()).toEqual([DEV_B]);
    value(await space.enrol(SECRET, DEV_A, 'iPad', '1.1.1.1'));
    expect(await ids()).toEqual([DEV_A, DEV_B]);
    value(await space.removeDevice(b, DEV_A));
    expect(await ids()).toEqual([DEV_B]);
    const code = value(await space.pairCode(b)).code;
    value(await space.claim(code, DEV_A, 'iPad', '1.1.1.1'));
    expect(await ids()).toEqual([DEV_A, DEV_B]);
  });

  it('claiming with a known non-revoked id replaces its token', async () => {
    const space = spaceOf('claim-replaces');
    const { a, b } = await twoDevices(space);
    const code = value(await space.pairCode(b)).code;
    const claimed = value(await space.claim(code, DEV_A, 'iPad', '1.1.1.1'));
    expect(claimed.token).not.toBe(a);
    expect(await space.devices(a)).toEqual({
      ok: false,
      status: 401,
      error: 'unauthorized',
      message: 'This device is not known to the space. Set up sync again.',
    });
    expect(await space.devices(claimed.token)).toMatchObject({ ok: true });
  });

  it('a failing room still leaves the device removed', async () => {
    const space = spaceOf('failing-room');
    const { a, b } = await twoDevices(space);
    const client = await synced(space, a, 'docA0000000', DEV_A);
    value(await space.ticket(a, 'docZ0000000'));
    await failCloseIn(space, 'docZ0000000');
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await space.removeDevice(b, DEV_A)).toEqual(closeFailed(1));
    expect(logged.mock.calls).toEqual([roomDown('closeDevice', 'docZ0000000')]);
    expect(await client.closed).toEqual(REMOVED);
    expect(value(await space.devices(b)).devices.map((d) => d.id)).toEqual([DEV_B]);
    expect(await space.ticket(a, 'docA0000000')).toMatchObject({ ok: false, status: 403 });
  });

  it('a failing room does not stop the rooms after it from closing the device', async () => {
    const space = spaceOf('failing-middle');
    const { a, b } = await twoDevices(space);
    const first = await synced(space, a, 'docB0000000', DEV_A);
    const middle = await synced(space, a, 'docM0000000', DEV_A);
    const last = await synced(space, a, 'docY0000000', DEV_A);
    await failCloseIn(space, 'docM0000000');
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await space.removeDevice(b, DEV_A)).toEqual(closeFailed(1));
    expect(logged.mock.calls).toEqual([roomDown('closeDevice', 'docM0000000')]);
    expect(await Promise.all([first.closed, last.closed])).toEqual([REMOVED, REMOVED]);
    await closeAll(middle);
  });

  it('an enrolment that cannot restore every room answers 500 and leaves the device removed', async () => {
    const space = spaceOf('restore-enrol');
    const { a, b } = await twoDevices(space);
    value(await space.ticket(a, 'docC0000000'));
    value(await space.ticket(a, 'docX0000000'));
    value(await space.removeDevice(b, DEV_A));
    await failRestoreIn(space, 'docX0000000');
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const before = Date.now();
    expect(await space.enrol(SECRET, DEV_A, 'iPad', '1.1.1.1')).toEqual(restoreFailed(1));
    expect(logged.mock.calls).toEqual([roomDown('restoreDevice', 'docX0000000')]);
    expect(await space.ticket(a, 'docC0000000')).toMatchObject({ ok: false, status: 403, error: 'revoked' });
    expect(value(await space.devices(b)).devices.map((d) => d.id)).toEqual([DEV_B]);
    expect(await untoldIn(space)).toEqual([`${DEV_A} docC0000000`]);
    expect(await alarmOf(space)).toBeGreaterThanOrEqual(before + 60_000);
    vi.restoreAllMocks();
    await dueNow(space);
    expect(await runDurableObjectAlarm(space)).toBe(true);
    expect(await revokedIn('docC0000000', DEV_A)).toBe(true);
    expect(await revokedIn('docX0000000', DEV_A)).toBe(true);
    expect(await untoldIn(space)).toEqual([]);
    const again = value(await space.enrol(SECRET, DEV_A, 'iPad', '1.1.1.1'));
    expect(await revokedIn('docC0000000', DEV_A)).toBe(false);
    expect(await revokedIn('docX0000000', DEV_A)).toBe(false);
    value(await space.ticket(again.token, 'docX0000000'));
  });

  it('a claim that cannot restore every room answers 500, leaves the code unused and counts no failure', async () => {
    const space = spaceOf('restore-claim');
    const { a, b } = await twoDevices(space);
    value(await space.ticket(a, 'docD0000000'));
    value(await space.ticket(a, 'docW0000000'));
    value(await space.removeDevice(b, DEV_A));
    const code = value(await space.pairCode(b)).code;
    await failRestoreIn(space, 'docW0000000');
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await space.claim(code, DEV_A, 'iPad', '1.1.1.1')).toEqual(restoreFailed(1));
    expect(logged.mock.calls).toEqual([roomDown('restoreDevice', 'docW0000000')]);
    expect(await space.ticket(a, 'docD0000000')).toMatchObject({ ok: false, status: 403, error: 'revoked' });
    vi.restoreAllMocks();
    const again = value(await space.claim(code, DEV_A, 'iPad', '1.1.1.1'));
    expect(await runInDurableObject(space, (_space, state) => state.storage.sql.exec('SELECT COUNT(*) AS n FROM attempts').one().n)).toBe(0);
    expect(await revokedIn('docW0000000', DEV_A)).toBe(false);
    value(await space.ticket(again.token, 'docW0000000'));
  });

  it('a syncing device whose join cannot restore every room keeps its token', async () => {
    const space = spaceOf('restore-syncing');
    const { a } = await twoDevices(space);
    value(await space.ticket(a, 'docJ0000000'));
    await failRestoreIn(space, 'docJ0000000');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await space.enrol(SECRET, DEV_A, 'Renamed', '1.1.1.1')).toEqual(restoreFailed(1));
    value(await space.ticket(a, 'docJ0000000'));
    expect(value(await space.devices(a)).devices.find((d) => d.id === DEV_A)).toMatchObject({ name: 'iPad', current: true });
    expect(await untoldIn(space)).toEqual([]);
    expect(await retryOf(space, DEV_A)).toBeNull();
  });

  it('a removed device whose join cannot restore every room keeps its earlier untold plans and their wait', async () => {
    const space = spaceOf('restore-untold');
    const { a, b } = await twoDevices(space);
    value(await space.ticket(a, 'docG0000000'));
    value(await space.ticket(a, 'docH0000000'));
    await failCloseIn(space, 'docG0000000');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await space.removeDevice(b, DEV_A)).toEqual(closeFailed(1));
    const wait = await retryOf(space, DEV_A);
    expect(wait).not.toBeNull();
    await failRestoreIn(space, 'docH0000000');
    expect(await space.enrol(SECRET, DEV_A, 'iPad', '1.1.1.1')).toEqual(restoreFailed(1));
    expect(await untoldIn(space)).toEqual([`${DEV_A} docG0000000`]);
    expect(await retryOf(space, DEV_A)).toEqual(wait);
  });

  it('removing a device tells its plans in sequential chunks of at most 50', async () => {
    const space = spaceOf('remove-chunks');
    const { a, b } = await twoDevices(space);
    const docs = Array.from({ length: 120 }, (_, i) => 'c' + String(i).padStart(10, '0'));
    for (const doc of docs) {
      value(await space.ticket(a, doc));
    }
    const told: string[] = [];
    const peaks: number[] = [];
    let open = 0;
    await runInDurableObject(space, (instance: Space) => {
      vi.spyOn(instance.rooms, 'close').mockImplementation(async (doc) => {
        open += 1;
        peaks.push(open);
        await scheduler.wait(5);
        open -= 1;
        told.push(doc);
        return 1;
      });
    });
    expect(await space.removeDevice(b, DEV_A)).toEqual({ ok: true, value: { closed: 120 } });
    expect([...told].sort()).toEqual(docs);
    expect(Math.max(...peaks)).toBe(50);
    expect(peaks.slice(0, 50)).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
    expect(peaks.slice(50, 51)).toEqual([1]);
    expect(peaks.slice(100, 101)).toEqual([1]);
  });

  it('a removal that could not tell some plans names how many, and calling it again finishes', async () => {
    const space = spaceOf('remove-again');
    const { a, b } = await twoDevices(space);
    const docs = Array.from({ length: 60 }, (_, i) => 'r' + String(i).padStart(10, '0'));
    for (const doc of docs) {
      value(await space.ticket(a, doc));
    }
    const failing = new Set([docs[3], docs[40], docs[59]]);
    const told: string[] = [];
    let broken = true;
    await runInDurableObject(space, (instance: Space) => {
      vi.spyOn(instance.rooms, 'close').mockImplementation(async (doc) => {
        if (broken && failing.has(doc)) {
          throw new Error('room down');
        }
        told.push(doc);
        return 0;
      });
    });
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await space.removeDevice(b, DEV_A)).toEqual(closeFailed(3));
    expect(logged.mock.calls).toEqual([...failing].map((doc) => roomDown('closeDevice', doc)));
    expect(told.length).toBe(57);
    expect(value(await space.devices(b)).devices.map((d) => d.id)).toEqual([DEV_B]);
    broken = false;
    told.length = 0;
    expect(await space.removeDevice(b, DEV_A)).toEqual({ ok: true, value: { closed: 0 } });
    expect([...told].sort()).toEqual(docs);
    expect(await untoldIn(space)).toEqual([]);
  });

  it('a removal that could not tell some plans keeps them and tells them on its alarm', async () => {
    const space = spaceOf('remove-alarm');
    const { a, b } = await twoDevices(space);
    const docs = ['s0000000000', 's0000000001', 's0000000002', 's0000000003'];
    for (const doc of docs) {
      value(await space.ticket(a, doc));
    }
    const told: string[] = [];
    let failing = new Set([docs[1], docs[3]]);
    await runInDurableObject(space, (instance: Space) => {
      vi.spyOn(instance.rooms, 'close').mockImplementation(async (doc) => {
        if (failing.has(doc)) {
          throw new Error('room down');
        }
        told.push(doc);
        return 1;
      });
    });
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const before = Date.now();
    expect(await space.removeDevice(b, DEV_A)).toEqual(closeFailed(2));
    expect(await untoldIn(space)).toEqual([`${DEV_A} ${docs[1]}`, `${DEV_A} ${docs[3]}`]);
    expect(await alarmOf(space)).toBeGreaterThanOrEqual(before + 60_000);
    failing = new Set([docs[3]]);
    told.length = 0;
    logged.mockClear();
    await dueNow(space);
    expect(await runDurableObjectAlarm(space)).toBe(true);
    expect(told).toEqual([docs[1]]);
    expect(logged.mock.calls).toEqual([roomDown('closeDevice', docs[3])]);
    expect(await untoldIn(space)).toEqual([`${DEV_A} ${docs[3]}`]);
    expect(await alarmOf(space)).not.toBeNull();
    failing = new Set();
    told.length = 0;
    await dueNow(space);
    expect(await runDurableObjectAlarm(space)).toBe(true);
    expect(told).toEqual([docs[3]]);
    expect(await untoldIn(space)).toEqual([]);
    expect(await alarmOf(space)).toBeNull();
  });

  it('a removed device that joins again is not closed by an earlier untold plan', async () => {
    const space = spaceOf('remove-alarm-readmit');
    const { a, b } = await twoDevices(space);
    value(await space.ticket(a, 'docF0000000'));
    await failCloseIn(space, 'docF0000000');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await space.removeDevice(b, DEV_A)).toEqual(closeFailed(1));
    expect(await untoldIn(space)).toEqual([`${DEV_A} docF0000000`]);
    const again = value(await space.enrol(SECRET, DEV_A, 'iPad', '1.1.1.1'));
    expect(await untoldIn(space)).toEqual([]);
    expect(await retryOf(space, DEV_A)).toBeNull();
    const closes = await runInDurableObject(space, (instance: Space) => vi.spyOn(instance.rooms, 'close'));
    closes.mockClear();
    expect(await runDurableObjectAlarm(space)).toBe(true);
    expect(closes).not.toHaveBeenCalled();
    const back = await synced(space, again.token, 'docF0000000', DEV_A);
    await closeAll(back);
  });

  it('the untold retry waits a minute, doubles after each failed run up to an hour and never gives up', async () => {
    const space = spaceOf('untold-backoff');
    const { a, b } = await twoDevices(space);
    const doc = 'docQ0000000';
    value(await space.ticket(a, doc));
    let down = true;
    await runInDurableObject(space, (instance: Space) => {
      vi.spyOn(instance.rooms, 'close').mockImplementation(async () => {
        if (down) {
          throw new Error('room down');
        }
        return 0;
      });
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const before = Date.now();
    expect(await space.removeDevice(b, DEV_A)).toEqual(closeFailed(1));
    const first = await retryOf(space, DEV_A);
    expect(first?.delay).toBe(60_000);
    expect(first?.due).toBeGreaterThanOrEqual(before + 60_000);
    expect(await alarmOf(space)).toBe(first?.due);
    for (const delay of [120_000, 240_000, 480_000, 960_000, 1_920_000, 3_600_000, 3_600_000, 3_600_000]) {
      await dueNow(space);
      const ran = Date.now();
      expect(await runDurableObjectAlarm(space)).toBe(true);
      const retry = await retryOf(space, DEV_A);
      expect(retry?.delay).toBe(delay);
      expect(retry?.due).toBeGreaterThanOrEqual(ran + delay);
      expect(retry?.due).toBeLessThanOrEqual(Date.now() + delay);
      expect(await alarmOf(space)).toBe(retry?.due);
      expect(await untoldIn(space)).toEqual([`${DEV_A} ${doc}`]);
    }
    down = false;
    await dueNow(space);
    expect(await runDurableObjectAlarm(space)).toBe(true);
    expect(await untoldIn(space)).toEqual([]);
    expect(await retryOf(space, DEV_A)).toBeNull();
    expect(await alarmOf(space)).toBeNull();
  });

  it('a removal that fails while another device is backed off waits a minute, and each device backs off alone', async () => {
    const space = spaceOf('untold-overlap');
    const { a, b } = await twoDevices(space);
    const c = value(await space.enrol(SECRET, DEV_C, 'Phone', '1.1.1.1')).token;
    value(await space.ticket(a, 'docX0000000'));
    value(await space.ticket(c, 'docY0000000'));
    const closes = await runInDurableObject(space, (instance: Space) =>
      vi.spyOn(instance.rooms, 'close').mockImplementation(async () => {
        throw new Error('room down');
      }),
    );
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await space.removeDevice(b, DEV_A)).toEqual(closeFailed(1));
    for (let run = 0; run < 6; run += 1) {
      await dueNow(space);
      expect(await runDurableObjectAlarm(space)).toBe(true);
    }
    expect((await retryOf(space, DEV_A))?.delay).toBe(3_600_000);
    const before = Date.now();
    expect(await space.removeDevice(b, DEV_C)).toEqual(closeFailed(1));
    const fresh = await retryOf(space, DEV_C);
    expect(fresh?.delay).toBe(60_000);
    expect(fresh?.due).toBeGreaterThanOrEqual(before + 60_000);
    expect(fresh?.due).toBeLessThanOrEqual(Date.now() + 60_000);
    expect(await alarmOf(space)).toBe(fresh?.due);
    const backedOff = await retryOf(space, DEV_A);
    expect(backedOff?.delay).toBe(3_600_000);
    await runInDurableObject(space, (_space, state) => {
      state.storage.sql.exec('UPDATE retry SET due = ? WHERE device = ?', Date.now(), DEV_C);
    });
    closes.mockClear();
    expect(await runDurableObjectAlarm(space)).toBe(true);
    expect(closes.mock.calls).toEqual([['docY0000000', DEV_C]]);
    expect(await retryOf(space, DEV_A)).toEqual(backedOff);
    expect((await retryOf(space, DEV_C))?.delay).toBe(120_000);
    expect(await alarmOf(space)).toBe((await retryOf(space, DEV_C))?.due);
  });

  it('removing a device again starts its retry over at a minute', async () => {
    const space = spaceOf('untold-again');
    const { a, b } = await twoDevices(space);
    value(await space.ticket(a, 'docR0000000'));
    await failCloseIn(space, 'docR0000000');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await space.removeDevice(b, DEV_A)).toEqual(closeFailed(1));
    for (let run = 0; run < 3; run += 1) {
      await dueNow(space);
      expect(await runDurableObjectAlarm(space)).toBe(true);
    }
    expect((await retryOf(space, DEV_A))?.delay).toBe(480_000);
    const before = Date.now();
    expect(await space.removeDevice(b, DEV_A)).toEqual(closeFailed(1));
    const again = await retryOf(space, DEV_A);
    expect(again?.delay).toBe(60_000);
    expect(again?.due).toBeGreaterThanOrEqual(before + 60_000);
    expect(again?.due).toBeLessThanOrEqual(Date.now() + 60_000);
    expect(await alarmOf(space)).toBe(again?.due);
  });

  it('an alarm before the untold retry is due tells no plan', async () => {
    const space = spaceOf('untold-not-due');
    const { a, b } = await twoDevices(space);
    value(await space.ticket(a, 'docN0000000'));
    await failCloseIn(space, 'docN0000000');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await space.removeDevice(b, DEV_A)).toEqual(closeFailed(1));
    const retry = await retryOf(space, DEV_A);
    const closes = await runInDurableObject(space, (instance: Space) => vi.spyOn(instance.rooms, 'close'));
    closes.mockClear();
    expect(await runDurableObjectAlarm(space)).toBe(true);
    expect(closes).not.toHaveBeenCalled();
    expect(await retryOf(space, DEV_A)).toEqual(retry);
    expect(await alarmOf(space)).toBe(retry?.due);
  });

  it('a re-admission tells its plans in sequential chunks of at most 50 and names how many were not told', async () => {
    const space = spaceOf('restore-chunks');
    const { a, b } = await twoDevices(space);
    const docs = Array.from({ length: 120 }, (_, i) => 'k' + String(i).padStart(10, '0'));
    for (const doc of docs) {
      value(await space.ticket(a, doc));
    }
    value(await space.removeDevice(b, DEV_A));
    const failing = new Set([docs[7], docs[60], docs[119]]);
    const told: string[] = [];
    const peaks: number[] = [];
    let open = 0;
    await runInDurableObject(space, (instance: Space) => {
      vi.spyOn(instance.rooms, 'restore').mockImplementation(async (doc) => {
        open += 1;
        peaks.push(open);
        await scheduler.wait(5);
        open -= 1;
        if (failing.has(doc)) {
          throw new Error('room down');
        }
        told.push(doc);
      });
    });
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await space.enrol(SECRET, DEV_A, 'iPad', '1.1.1.1')).toEqual(restoreFailed(3));
    expect(logged.mock.calls).toEqual([...failing].map((doc) => roomDown('restoreDevice', doc)));
    expect(told.length).toBe(117);
    expect(Math.max(...peaks)).toBe(50);
    expect(peaks.slice(50, 51)).toEqual([1]);
    expect(peaks.slice(100, 101)).toEqual([1]);
  });

  it('a removal and a re-admission of one device reach its rooms in order', async () => {
    const space = spaceOf('remove-readmit');
    const { a, b } = await twoDevices(space);
    const first = await synced(space, a, 'docE0000000', DEV_A);
    await runInDurableObject(space, (instance: Space) => {
      const real = instance.rooms.close;
      vi.spyOn(instance.rooms, 'close').mockImplementation(async (doc, deviceId) => {
        await scheduler.wait(200);
        return real(doc, deviceId);
      });
    });
    const removal = space.removeDevice(b, DEV_A);
    const readmission = space.enrol(SECRET, DEV_A, 'iPad', '1.1.1.1');
    expect(await removal).toEqual({ ok: true, value: { closed: 1 } });
    const again = value(await readmission);
    expect(await first.closed).toEqual(REMOVED);
    expect(await revokedIn('docE0000000', DEV_A)).toBe(false);
    const back = await synced(space, again.token, 'docE0000000', DEV_A);
    await closeAll(back);
  });
});

describe('Space purge', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('a purge closes the plan everywhere, erases its room and forgets its joins', async () => {
    const space = spaceOf('purge');
    const { a, b } = await twoDevices(space);
    const doc = newDoc();
    const open = await synced(space, a, doc, DEV_A);
    value(await space.ticket(b, doc));
    expect(await space.purgePlan(b, doc)).toEqual({ ok: true, value: { closed: 1 } });
    expect(await open.closed).toEqual(PLAN_DELETED);
    expect(await roomTables(doc)).toEqual(['gone']);
    expect(await purgedIn(space)).toEqual([{ doc, device: DEV_B, erased: true }]);
    expect(await rowsFor(space, doc)).toBe(0);
    expect(await space.ticket(a, doc)).toEqual(GONE);
    expect(await space.ticket(b, doc)).toEqual(GONE);
    expect(await space.purgePlan(a, doc)).toEqual({ ok: true, value: { closed: 0 } });
    expect(await purgedIn(space)).toEqual([{ doc, device: DEV_B, erased: true }]);
  });

  it('a purge of a plan the space does not know is 404 unknown_plan, calls no room and stores nothing', async () => {
    const space = spaceOf('purge-unknown');
    const { a } = await twoDevices(space);
    const doc = newDoc();
    const purges = await runInDurableObject(space, (instance: Space) => vi.spyOn(instance.rooms, 'purge'));
    expect(await space.purgePlan(a, doc)).toEqual({
      ok: false,
      status: 404,
      error: 'unknown_plan',
      message: 'The server does not know this plan yet. Let it sync, then delete it again.',
    });
    expect(purges).not.toHaveBeenCalled();
    expect(await purgedIn(space)).toEqual([]);
    expect(await alarmOf(space)).toBeNull();
    expect(await roomExists(doc)).toBe(false);
    expect((await storedText(space)).filter((cell) => cell.includes(doc))).toEqual([]);
  });

  it('a device purges a plan that only another device of the space joined', async () => {
    const space = spaceOf('purge-other');
    const { a, b } = await twoDevices(space);
    const doc = newDoc();
    const open = await synced(space, a, doc, DEV_A);
    expect(await space.purgePlan(b, doc)).toEqual({ ok: true, value: { closed: 1 } });
    expect(await open.closed).toEqual(PLAN_DELETED);
    expect(await purgedIn(space)).toEqual([{ doc, device: DEV_B, erased: true }]);
    expect(await space.purgePlan(b, doc)).toEqual({ ok: true, value: { closed: 0 } });
  });

  it('a purge arms the retry before it calls the room', async () => {
    const space = spaceOf('purge-arm-first');
    const { a, b } = await twoDevices(space);
    const doc = newDoc();
    value(await space.ticket(a, doc));
    const seen: (number | null)[] = [];
    await runInDurableObject(space, (instance: Space, state) => {
      vi.spyOn(instance.rooms, 'purge').mockImplementation(async () => {
        seen.push(await state.storage.getAlarm());
        return 0;
      });
    });
    const before = Date.now();
    expect(await space.purgePlan(b, doc)).toEqual({ ok: true, value: { closed: 0 } });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBeGreaterThanOrEqual(before + 60_000);
    expect(seen[0]).toBeLessThanOrEqual(Date.now() + 60_000);
    expect(await purgedIn(space)).toEqual([{ doc, device: DEV_B, erased: true }]);
  });

  it('a pending purge keeps the alarm at a minute while an untold retry is backed off longer, and leaves the untold rows alone', async () => {
    const space = spaceOf('purge-alarm-minimum');
    const { a, b } = await twoDevices(space);
    const kept = 'docK0000000';
    const doc = newDoc();
    value(await space.ticket(a, kept));
    value(await space.ticket(b, doc));
    await failCloseIn(space, kept);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await space.removeDevice(b, DEV_A)).toEqual(closeFailed(1));
    await [1, 2, 3].reduce<Promise<void>>(async (done) => {
      await done;
      await dueNow(space);
      expect(await runDurableObjectAlarm(space)).toBe(true);
    }, Promise.resolve());
    const backedOff = await retryOf(space, DEV_A);
    expect(backedOff?.delay).toBe(480_000);
    let down = true;
    await failPurgeIn(space, () => down);
    const before = Date.now();
    expect(await space.purgePlan(b, doc)).toEqual(PURGE_PENDING);
    const armed = await alarmOf(space);
    expect(armed).toBeGreaterThanOrEqual(before + 60_000);
    expect(armed).toBeLessThanOrEqual(Date.now() + 60_000);
    const closes = await runInDurableObject(space, (instance: Space) => vi.spyOn(instance.rooms, 'close'));
    closes.mockClear();
    down = false;
    expect(await runDurableObjectAlarm(space)).toBe(true);
    expect(await purgedIn(space)).toEqual([{ doc, device: DEV_B, erased: true }]);
    expect(closes).not.toHaveBeenCalled();
    expect(await untoldIn(space)).toEqual([`${DEV_A} ${kept}`]);
    expect(await retryOf(space, DEV_A)).toEqual(backedOff);
    expect(await alarmOf(space)).toBe(backedOff?.due);
  });

  it('after a purge no stored value on the server holds the plan name or content', async () => {
    const space = spaceOf('purge-traces');
    const { a } = await twoDevices(space);
    const doc = newDoc();
    const name = 'Probe plan name 7f3a';
    const content = 'Probe task label 9c1e';
    const client = await synced(space, a, doc, DEV_A);
    client.ydoc.getMap('meta').set('name', name);
    client.ydoc.getMap('actions').set('a1', { lbl: content });
    const holds = (cells: string[]): boolean => cells.some((cell) => cell.includes(name) || cell.includes(content));
    const deadline = Date.now() + 10_000;
    while (!holds(await storedText(env.Room.getByName(doc)))) {
      if (Date.now() > deadline) {
        throw new Error('the room never stored the plan');
      }
      await scheduler.wait(10);
    }
    value(await space.purgePlan(a, doc));
    await client.closed;
    expect(holds(await storedText(env.Room.getByName(doc)))).toBe(false);
    expect(holds(await storedText(space))).toBe(false);
  });

  it('a ticket for a purged plan is 410, also for a device at the plan cap', async () => {
    const space = spaceOf('purge-cap');
    const { a, b } = await twoDevices(space);
    const doc = newDoc();
    value(await space.ticket(b, doc));
    value(await space.purgePlan(b, doc));
    await runInDurableObject(space, (_space, state) => {
      Array.from({ length: 500 }, () => newDoc()).forEach((joined) =>
        state.storage.sql.exec('INSERT INTO joins (device, doc) VALUES (?, ?)', DEV_A, joined),
      );
    });
    expect(await space.ticket(a, doc)).toEqual(GONE);
  });

  it('a ticket issued before the purge is refused with 410 at connect', async () => {
    const space = spaceOf('purge-late-ticket');
    const { a, b } = await twoDevices(space);
    const doc = newDoc();
    const issued = value(await space.ticket(a, doc));
    value(await space.purgePlan(b, doc));
    expect(await space.consumeTicket(issued.ticket, doc)).toEqual(GONE);
  });

  it('removing a device after a purge never tells the purged plan', async () => {
    const space = spaceOf('purge-remove');
    const { a, b } = await twoDevices(space);
    const doc = newDoc();
    const kept = newDoc();
    value(await space.ticket(a, doc));
    value(await space.ticket(a, kept));
    value(await space.purgePlan(b, doc));
    const closes = await runInDurableObject(space, (instance: Space) => vi.spyOn(instance.rooms, 'close'));
    expect(await space.removeDevice(b, DEV_A)).toEqual({ ok: true, value: { closed: 0 } });
    expect(closes.mock.calls.map((call) => call[0])).toEqual([kept]);
  });

  it('a purge drops the untold rows of the plan', async () => {
    const space = spaceOf('purge-untold');
    const { a, b } = await twoDevices(space);
    const doc = 'docU0000000';
    value(await space.ticket(a, doc));
    await failCloseIn(space, doc);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await space.removeDevice(b, DEV_A)).toEqual(closeFailed(1));
    expect(await untoldIn(space)).toEqual([`${DEV_A} ${doc}`]);
    expect(await retryOf(space, DEV_A)).not.toBeNull();
    value(await space.purgePlan(b, doc));
    expect(await untoldIn(space)).toEqual([]);
    expect(await retryOf(space, DEV_A)).toBeNull();
  });

  it('a purge whose room fails answers purge_pending, and the alarm erases it later', async () => {
    const space = spaceOf('purge-pending');
    const { a, b } = await twoDevices(space);
    const doc = newDoc();
    const client = await synced(space, a, doc, DEV_A);
    let down = true;
    await failPurgeIn(space, () => down);
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const before = Date.now();
    expect(await space.purgePlan(b, doc)).toEqual(PURGE_PENDING);
    expect(logged.mock.calls).toEqual([[`Space: purge(${DEV_B}) failed in room ${doc}`, expect.objectContaining({ message: 'room down' })]]);
    expect(await purgedIn(space)).toEqual([{ doc, device: DEV_B, erased: false }]);
    expect(await space.ticket(a, doc)).toEqual(GONE);
    expect(await alarmOf(space)).toBeGreaterThanOrEqual(before + 60_000);
    logged.mockClear();
    expect(await runDurableObjectAlarm(space)).toBe(true);
    expect(logged.mock.calls).toHaveLength(1);
    expect(await purgedIn(space)).toEqual([{ doc, device: DEV_B, erased: false }]);
    expect(await alarmOf(space)).not.toBeNull();
    down = false;
    expect(await runDurableObjectAlarm(space)).toBe(true);
    expect(await client.closed).toEqual(PLAN_DELETED);
    expect(await purgedIn(space)).toEqual([{ doc, device: DEV_B, erased: true }]);
    expect(await roomTables(doc)).toEqual(['gone']);
    expect(await alarmOf(space)).toBeNull();
  });
});
