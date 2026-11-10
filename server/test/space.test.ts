import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { getServerByName } from 'partyserver';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEVICE_HEADER } from '../src/limits';
import type { Space } from '../src/space';
import { connectDoc, type TestClient } from './client';
import { newDoc, value } from './helpers';

const SECRET = env.SETUP_SECRET;
const DEV_A = 'devA0000000';
const DEV_B = 'devB0000000';
function closeFailed(untold: number): unknown {
  const plans = untold === 1 ? '1 plan was' : `${untold} plans were`;
  const that = untold === 1 ? 'that plan' : 'those plans';
  return {
    ok: false,
    status: 500,
    error: 'internal',
    message: `The device was removed, but ${plans} not told to close its connections. The server tries again every minute; until then the device keeps syncing ${that} while it stays connected.`,
  };
}
const RESTORE_FAILED = {
  ok: false,
  status: 500,
  error: 'internal',
  message: 'This device joined, but the server could not reconnect it to every plan. Join again.',
};
const REMOVED = { code: 4403, reason: 'Device removed' };

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

async function alarmOf(space: DurableObjectStub<Space>): Promise<number | null> {
  return runInDurableObject(space, async (_space, state) => state.storage.getAlarm());
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
    expect(tables).toEqual(['attempts', 'codes', 'devices', 'joins', 'meta', 'tickets', 'untold']);
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

  it('an enrolment that cannot restore every room answers 500 and restores the rest', async () => {
    const space = spaceOf('restore-enrol');
    const { a, b } = await twoDevices(space);
    value(await space.ticket(a, 'docC0000000'));
    value(await space.ticket(a, 'docX0000000'));
    value(await space.removeDevice(b, DEV_A));
    await failRestoreIn(space, 'docX0000000');
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await space.enrol(SECRET, DEV_A, 'iPad', '1.1.1.1')).toEqual(RESTORE_FAILED);
    expect(logged.mock.calls).toEqual([roomDown('restoreDevice', 'docX0000000')]);
    expect(await revokedIn('docC0000000', DEV_A)).toBe(false);
    expect(await revokedIn('docX0000000', DEV_A)).toBe(true);
  });

  it('a claim that cannot restore every room answers 500 and restores the rest', async () => {
    const space = spaceOf('restore-claim');
    const { a, b } = await twoDevices(space);
    value(await space.ticket(a, 'docD0000000'));
    value(await space.ticket(a, 'docW0000000'));
    value(await space.removeDevice(b, DEV_A));
    const code = value(await space.pairCode(b)).code;
    await failRestoreIn(space, 'docW0000000');
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await space.claim(code, DEV_A, 'iPad', '1.1.1.1')).toEqual(RESTORE_FAILED);
    expect(logged.mock.calls).toEqual([roomDown('restoreDevice', 'docW0000000')]);
    expect(await revokedIn('docD0000000', DEV_A)).toBe(false);
    expect(await revokedIn('docW0000000', DEV_A)).toBe(true);
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
    expect(await runDurableObjectAlarm(space)).toBe(true);
    expect(told).toEqual([docs[1]]);
    expect(logged.mock.calls).toEqual([roomDown('closeDevice', docs[3])]);
    expect(await untoldIn(space)).toEqual([`${DEV_A} ${docs[3]}`]);
    expect(await alarmOf(space)).not.toBeNull();
    failing = new Set();
    told.length = 0;
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
    const closes = await runInDurableObject(space, (instance: Space) => vi.spyOn(instance.rooms, 'close'));
    closes.mockClear();
    expect(await runDurableObjectAlarm(space)).toBe(true);
    expect(closes).not.toHaveBeenCalled();
    const back = await synced(space, again.token, 'docF0000000', DEV_A);
    await closeAll(back);
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
