import { env, runInDurableObject } from 'cloudflare:test';
import { getServerByName } from 'partyserver';
import { describe, expect, it, vi } from 'vitest';
import type { Result } from '../src/auth';
import { DEVICE_HEADER } from '../src/limits';
import { Room } from '../src/room';
import { connectDoc, type TestClient } from './client';

const SECRET = env.SETUP_SECRET;
const DEV_A = 'devA0000000';
const DEV_B = 'devB0000000';

function value<V>(result: Result<V>): V {
  if (!result.ok) {
    throw new Error(`Expected ok, got ${result.status} ${result.error}: ${result.message}`);
  }
  return result.value;
}

function newDoc(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function spaceOf(name: string): DurableObjectStub<import('../src/space').Space> {
  return env.Space.getByName('t-' + name);
}

async function connect(
  space: DurableObjectStub<import('../src/space').Space>,
  token: string,
  doc: string,
  device: string,
): Promise<TestClient> {
  const issued = value(await space.ticket(token, doc));
  expect(await space.consumeTicket(issued.ticket, doc)).toEqual({ ok: true, value: { deviceId: device } });
  return connectDoc(async () =>
    (await getServerByName(env.Room, doc)).fetch(
      new Request('https://x/parties/room/' + doc, { headers: { Upgrade: 'websocket', [DEVICE_HEADER]: device } }),
    ),
  );
}

async function synced(
  space: DurableObjectStub<import('../src/space').Space>,
  token: string,
  doc: string,
  device: string,
): Promise<TestClient> {
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

async function twoDevices(space: DurableObjectStub<import('../src/space').Space>): Promise<{ spaceId: string; a: string; b: string }> {
  const a = value(await space.enrol(SECRET, DEV_A, 'iPad', '1.1.1.1'));
  const b = value(await space.enrol(SECRET, DEV_B, 'Mac', '1.1.1.1'));
  return { spaceId: a.spaceId, a: a.token, b: b.token };
}

describe('Space', () => {
  it('removing a device closes its sockets in every room it joined', async () => {
    const space = spaceOf('remove-closes');
    const { a, b } = await twoDevices(space);
    const docs = [newDoc(), newDoc()];
    const clients = [await synced(space, a, docs[0], DEV_A), await synced(space, a, docs[1], DEV_A)];
    expect(await space.removeDevice(b, DEV_A)).toEqual({ ok: true, value: { closed: 2 } });
    expect(await Promise.all(clients.map((client) => client.closed))).toEqual([
      { code: 4403, reason: 'Device removed' },
      { code: 4403, reason: 'Device removed' },
    ]);
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
    const docs = [newDoc(), newDoc()];
    value(await space.ticket(a, docs[0]));
    value(await space.ticket(a, docs[1]));
    const failing = new WeakSet<Room>();
    await runInDurableObject(env.Room.getByName(docs[1]), (room: Room) => {
      failing.add(room);
    });
    const original = Room.prototype.closeDevice;
    const closeDevice = vi.spyOn(Room.prototype, 'closeDevice').mockImplementation(async function (this: Room, deviceId: string) {
      if (failing.has(this)) {
        throw new Error('room down');
      }
      return original.call(this, deviceId);
    });
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await space.removeDevice(b, DEV_A)).toEqual({
      ok: false,
      status: 500,
      error: 'internal',
      message: 'The device was removed, but one of its open connections could not be closed; it stops syncing when that connection drops.',
    });
    expect(logged.mock.calls).toEqual([[expect.objectContaining({ message: 'room down' })]]);
    expect(closeDevice).toHaveBeenCalled();
    logged.mockRestore();
    closeDevice.mockRestore();
    expect(value(await space.devices(b)).devices.map((d) => d.id)).toEqual([DEV_B]);
    expect(await space.ticket(a, docs[0])).toMatchObject({ ok: false, status: 403 });
  });
});
