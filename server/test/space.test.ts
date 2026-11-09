import { env, runInDurableObject } from 'cloudflare:test';
import { getServerByName } from 'partyserver';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEVICE_HEADER } from '../src/limits';
import type { Space } from '../src/space';
import { connectDoc, type TestClient } from './client';
import { newDoc, value } from './helpers';

const SECRET = env.SETUP_SECRET;
const DEV_A = 'devA0000000';
const DEV_B = 'devB0000000';
const CLOSE_FAILED = {
  ok: false,
  status: 500,
  error: 'internal',
  message: 'The device was removed, but one of its open connections could not be closed; it stops syncing when that connection drops.',
};
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
    expect(tables).toEqual(['attempts', 'codes', 'devices', 'joins', 'meta', 'tickets']);
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
    expect(await space.removeDevice(b, DEV_A)).toEqual(CLOSE_FAILED);
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
    expect(await space.removeDevice(b, DEV_A)).toEqual(CLOSE_FAILED);
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
