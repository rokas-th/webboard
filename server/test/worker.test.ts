import { env, listDurableObjectIds, runInDurableObject } from 'cloudflare:test';
import { exports } from 'cloudflare:workers';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomBase64url } from '../src/auth';
import { handle } from '../src/index';
import { DEVICE_HEADER } from '../src/limits';
import type { Room } from '../src/room';
import type { Space } from '../src/space';
import { connectDoc, type TestClient } from './client';
import { newDoc } from './helpers';

const ORIGIN = 'https://webboard.rokass.org';
const SECRET = env.SETUP_SECRET;
const NOT_CONFIGURED = {
  error: 'not_configured',
  message: 'The server has no setup secret. Run wrangler secret put SETUP_SECRET.',
};
const BAD_SECRET = { error: 'unauthorized', message: 'The setup secret is not correct.' };
const UNKNOWN_DEVICE = { error: 'unauthorized', message: 'This device is not known to the space. Set up sync again.' };
const NO_ADDRESS = { error: 'bad_request', message: 'The request carries no client address.' };
const EMPTY_NAME = { error: 'bad_request', message: 'The name is empty. Type at least one character.' };
const BAD_TICKET = { error: 'unauthorized', message: 'The connection ticket is unknown, used or expired. Connect again.' };
const REVOKED = { error: 'revoked', message: 'This device was removed from the space.' };
const GONE = { error: 'gone', message: 'This plan was deleted forever on another device.' };
const BAD_CODE = {
  error: 'bad_code',
  message: 'The pairing code is wrong, used or expired. Show a new code on a device in the space.',
};
const CLOSE_FAILED = {
  error: 'internal',
  message: 'The device was removed, but 1 plan was not told to close its connections. The server tries again in a minute, then less often, at least once an hour; until then the device keeps syncing that plan while it stays connected.',
};

let addresses = 0;
let address = '';

interface Call {
  method?: string;
  token?: string;
  body?: unknown;
  ip?: string | null;
  headers?: Record<string, string>;
}

function newDevice(): string {
  return randomBase64url(8);
}

function request(path: string, call: Call = {}): Request {
  const headers = new Headers(call.headers);
  if (call.token !== undefined) {
    headers.set('Authorization', 'Bearer ' + call.token);
  }
  const ip = call.ip === undefined ? address : call.ip;
  if (ip !== null) {
    headers.set('CF-Connecting-IP', ip);
  }
  const body = call.body === undefined ? undefined : typeof call.body === 'string' ? call.body : JSON.stringify(call.body);
  if (body !== undefined) {
    headers.set('Content-Type', 'application/json');
  }
  return new Request(ORIGIN + path, { method: call.method ?? 'GET', headers, body });
}

function send(path: string, call: Call = {}): Promise<Response> {
  return exports.default.fetch(request(path, call));
}

function upgrade(path: string, headers: Record<string, string> = {}): Request {
  return new Request(ORIGIN + path, { headers: { Upgrade: 'websocket', ...headers } });
}

async function json(response: Response): Promise<unknown> {
  expect(response.headers.get('Content-Type')).toBe('application/json');
  return response.json();
}

function stringField(value: unknown, key: string): string {
  const found: unknown = typeof value === 'object' && value !== null ? Reflect.get(value, key) : undefined;
  if (typeof found === 'string') {
    return found;
  }
  throw new Error(`Expected a string ${key} in ${JSON.stringify(value)}`);
}

async function refused(response: Response, status: number, body: unknown): Promise<void> {
  expect(response.status).toBe(status);
  expect(response.webSocket).toBeNull();
  expect(await json(response)).toEqual(body);
  expect([...response.headers.keys()].filter((key) => key.startsWith('access-control-'))).toEqual([]);
}

function retryAfter(response: Response): number {
  const header = response.headers.get('Retry-After');
  expect(header).toEqual(expect.stringMatching(/^[0-9]+$/));
  return Number(header);
}

async function roomExists(doc: string): Promise<boolean> {
  const id = env.Room.idFromName(doc);
  return (await listDurableObjectIds(env.Room)).some((listed) => listed.equals(id));
}

async function enrol(device: string, name: string): Promise<string> {
  const response = await send('/space', { method: 'POST', token: SECRET, body: { deviceId: device, deviceName: name } });
  expect(response.status).toBe(200);
  const body = await json(response);
  expect(body).toMatchObject({ deviceId: device });
  return stringField(body, 'token');
}

async function ticketFor(token: string, doc: string): Promise<string> {
  const response = await send('/ticket', { method: 'POST', token, body: { doc } });
  expect(response.status).toBe(200);
  return stringField(await json(response), 'ticket');
}

async function pairingCode(token: string): Promise<string> {
  const response = await send('/pair', { method: 'POST', token });
  expect(response.status).toBe(200);
  return stringField(await json(response), 'code');
}

async function claimed(code: string): Promise<void> {
  const device = newDevice();
  const response = await send('/pair/claim', { method: 'POST', body: { code, deviceId: device, deviceName: 'Phone' } });
  expect(response.status).toBe(200);
  expect(await json(response)).toMatchObject({ deviceId: device });
}

describe('the worker', () => {
  const clients: TestClient[] = [];

  beforeEach(() => {
    addresses += 1;
    address = '203.0.113.' + addresses;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    clients.forEach((client) => client.close());
    await Promise.all(clients.map((client) => client.closed));
  });

  it('an unconfigured server answers 503 everywhere', async () => {
    const doc = newDoc();
    const device = newDevice();
    const requests = (): Request[] => [
      request('/space', { method: 'POST', token: 'x'.repeat(31), body: { deviceId: device, deviceName: 'Mac' } }),
      request('/pair', { method: 'POST', token: 'tok' }),
      request('/pair/claim', { method: 'POST', body: { code: 'ABCD-2345', deviceId: device, deviceName: 'Mac' } }),
      request('/ticket', { method: 'POST', token: 'tok', body: { doc } }),
      request('/devices', { token: 'tok' }),
      request('/devices/' + device, { method: 'DELETE', token: 'tok' }),
      upgrade('/parties/room/' + doc + '?ticket=t'),
      request('/nope'),
    ];
    for (const secret of [undefined, 'x'.repeat(31)]) {
      for (const req of requests()) {
        await refused(await handle(req, { ...env, SETUP_SECRET: secret }), 503, NOT_CONFIGURED);
      }
    }
    expect(await roomExists(doc)).toBe(false);
  });

  it('a 32-byte setup secret is enough', async () => {
    const device = newDevice();
    expect(SECRET).toBe('x'.repeat(32));
    const response = await handle(
      request('/space', { method: 'POST', token: 'x'.repeat(32), body: { deviceId: device, deviceName: 'Mac' } }),
      { ...env, SETUP_SECRET: 'x'.repeat(32) },
    );
    expect(response.status).toBe(200);
    expect(await json(response)).toMatchObject({ deviceId: device });
  });

  it('POST /space refuses a missing or wrong setup secret', async () => {
    const body = { deviceId: newDevice(), deviceName: 'Mac' };
    await refused(await send('/space', { method: 'POST', body }), 401, BAD_SECRET);
    await refused(await send('/space', { method: 'POST', body, token: 'wrong' }), 401, BAD_SECRET);
  });

  it('a missing setup secret is not counted as a wrong one', async () => {
    const body = { deviceId: newDevice(), deviceName: 'Mac' };
    for (const _attempt of [1, 2, 3, 4, 5, 6]) {
      await refused(await send('/space', { method: 'POST', body }), 401, BAD_SECRET);
    }
    const response = await send('/space', { method: 'POST', token: SECRET, body });
    expect(response.status).toBe(200);
    expect(await json(response)).toMatchObject({ deviceId: body.deviceId });
  });

  it('too many wrong setup secrets are 429 with Retry-After', async () => {
    const body = { deviceId: newDevice(), deviceName: 'Mac' };
    for (const _attempt of [1, 2, 3, 4, 5]) {
      await refused(await send('/space', { method: 'POST', body, token: 'wrong' }), 401, BAD_SECRET);
    }
    const limited = await send('/space', { method: 'POST', body, token: SECRET });
    expect(retryAfter(limited)).toBeGreaterThan(590);
    expect(retryAfter(limited)).toBeLessThanOrEqual(600);
    await refused(limited, 429, { error: 'rate_limited', message: 'Too many wrong setup secrets from this address.' });
  });

  it('too many wrong pairing codes are 429 with Retry-After', async () => {
    const body = { code: 'ZZZZ-ZZZZ', deviceId: newDevice(), deviceName: 'Phone' };
    for (const _attempt of [1, 2, 3, 4, 5]) {
      await refused(await send('/pair/claim', { method: 'POST', body }), 404, BAD_CODE);
    }
    const limited = await send('/pair/claim', { method: 'POST', body });
    expect(retryAfter(limited)).toBeGreaterThan(590);
    expect(retryAfter(limited)).toBeLessThanOrEqual(600);
    await refused(limited, 429, { error: 'rate_limited', message: 'Too many wrong pairing codes.' });
  });

  it('an enrolment without a client address is refused', async () => {
    const device = newDevice();
    await refused(
      await handle(request('/space', { method: 'POST', token: SECRET, ip: null, body: { deviceId: device, deviceName: 'Mac' } }), env),
      400,
      NO_ADDRESS,
    );
    await refused(
      await handle(
        request('/pair/claim', { method: 'POST', ip: null, body: { code: 'ABCD-2345', deviceId: device, deviceName: 'Mac' } }),
        env,
      ),
      400,
      NO_ADDRESS,
    );
  });

  it('an empty device name is refused before the space', async () => {
    const device = newDevice();
    await refused(await send('/space', { method: 'POST', token: SECRET, body: { deviceId: device, deviceName: '  ' } }), 400, EMPTY_NAME);
    await refused(
      await send('/pair/claim', { method: 'POST', body: { code: 'ABCD-2345', deviceId: device, deviceName: '' } }),
      400,
      EMPTY_NAME,
    );
  });

  it('a body that is not the expected JSON is refused', async () => {
    const malformed = { error: 'bad_request', message: 'The request body is not what this server expects. Update WebBoard on this device.' };
    await refused(await send('/space', { method: 'POST', token: SECRET, body: '{' }), 400, malformed);
    await refused(await send('/space', { method: 'POST', token: SECRET, body: { deviceId: newDevice() } }), 400, malformed);
    await refused(await send('/pair/claim', { method: 'POST', body: [] }), 400, malformed);
    await refused(await send('/ticket', { method: 'POST', token: 'tok', body: { doc: 7 } }), 400, malformed);
    const notUtf8 = new Request(ORIGIN + '/ticket', {
      method: 'POST',
      headers: { Authorization: 'Bearer tok', 'CF-Connecting-IP': address },
      body: new Uint8Array([0x7b, 0x22, 0x64, 0x6f, 0x63, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]),
    });
    await refused(await exports.default.fetch(notUtf8), 400, malformed);
  });

  it('every Bearer route refuses an unknown device', async () => {
    const device = newDevice();
    await refused(await send('/devices'), 401, UNKNOWN_DEVICE);
    await refused(await send('/pair', { method: 'POST' }), 401, UNKNOWN_DEVICE);
    await refused(await send('/ticket', { method: 'POST', body: { doc: newDoc() } }), 401, UNKNOWN_DEVICE);
    await refused(await send('/devices/' + device, { method: 'DELETE' }), 401, UNKNOWN_DEVICE);
    await refused(await send('/devices', { token: 'not-a-token' }), 401, UNKNOWN_DEVICE);
    await refused(await send('/devices', { headers: { Authorization: 'Basic abc' } }), 401, UNKNOWN_DEVICE);
    await refused(await send('/devices', { headers: { Authorization: 'Bearer' } }), 401, UNKNOWN_DEVICE);
    await refused(await send('/devices', { headers: { Authorization: 'Bearerabc' } }), 401, UNKNOWN_DEVICE);
  });

  it('the Bearer scheme is matched without regard to case', async () => {
    const device = newDevice();
    const token = await enrol(device, 'Mac');
    const lower = await send('/devices', { headers: { Authorization: 'bearer ' + token } });
    expect(lower.status).toBe(200);
    expect(await json(lower)).toEqual({ devices: expect.arrayContaining([expect.objectContaining({ id: device, current: true })]) });
    const upper = await send('/devices', { headers: { Authorization: 'BEARER ' + token } });
    expect(upper.status).toBe(200);
    expect(await json(upper)).toEqual({ devices: expect.arrayContaining([expect.objectContaining({ id: device, current: true })]) });
  });

  it('routes the space API to the Space', async () => {
    const devA = newDevice();
    const devB = newDevice();
    const devC = newDevice();
    const a = await enrol(devA, 'Mac');
    const b = await enrol(devB, 'iPad');
    await enrol(devC, 'Laptop');
    const listed = await send('/devices', { token: a });
    expect(listed.status).toBe(200);
    expect(await json(listed)).toEqual({
      devices: expect.arrayContaining([
        expect.objectContaining({ id: devA, current: true }),
        expect.objectContaining({ id: devB, current: false }),
      ]),
    });
    const code = await pairingCode(b);
    const claim = await send('/pair/claim', { method: 'POST', body: { code, deviceId: devB, deviceName: 'iPad 2' } });
    expect(claim.status).toBe(200);
    expect(await json(claim)).toMatchObject({ deviceId: devB });
    await refused(await send('/devices/' + newDevice(), { method: 'DELETE', token: a }), 404, {
      error: 'not_found',
      message: 'This device is not in the space.',
    });
    const removed = await send('/devices/' + devC, { method: 'DELETE', token: a });
    expect(removed.status).toBe(200);
    expect(await json(removed)).toEqual({ closed: 0 });
    await refused(await send('/ticket', { method: 'POST', token: a, body: { doc: 'local' } }), 400, {
      error: 'bad_request',
      message: 'The document id is not valid. Update WebBoard on this device.',
    });
  });

  it('a ticket for a plan past the cap answers 409 too_many_plans', async () => {
    const dev = newDevice();
    const token = await enrol(dev, 'Mac');
    await runInDurableObject(env.Space.getByName('space'), (_space, state) => {
      Array.from({ length: 500 }, () => newDoc()).forEach((doc) =>
        state.storage.sql.exec('INSERT INTO joins (device, doc) VALUES (?, ?)', dev, doc),
      );
    });
    await refused(await send('/ticket', { method: 'POST', token, body: { doc: newDoc() } }), 409, {
      error: 'too_many_plans',
      message: 'This device has joined 500 plans, the most one device may join.',
    });
  });

  it('a failing room passes the Space 500 through the router unchanged', async () => {
    const devA = newDevice();
    const devB = newDevice();
    const a = await enrol(devA, 'Mac');
    const b = await enrol(devB, 'iPad');
    const failing = newDoc();
    await ticketFor(b, failing);
    await runInDurableObject(env.Space.getByName('space'), (instance: Space) => {
      const real = instance.rooms.close;
      vi.spyOn(instance.rooms, 'close').mockImplementation(async (doc, deviceId) => {
        if (doc === failing) {
          throw new Error('room down');
        }
        return real(doc, deviceId);
      });
    });
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await refused(await send('/devices/' + devB, { method: 'DELETE', token: a }), 500, CLOSE_FAILED);
    expect(logged.mock.calls).toEqual([
      [`Space: closeDevice(${devB}) failed in room ${failing}`, expect.objectContaining({ message: 'room down' })],
    ]);
    await refused(await send('/devices', { token: b }), 403, REVOKED);
  });

  it('DELETE /plans/<doc> purges a plan, and its tickets and sockets answer 410', async () => {
    const devA = newDevice();
    const devB = newDevice();
    const a = await enrol(devA, 'Mac');
    const b = await enrol(devB, 'iPad');
    const doc = newDoc();
    const late = await ticketFor(a, doc);
    const purged = await send('/plans/' + doc, { method: 'DELETE', token: b });
    expect(purged.status).toBe(200);
    expect(await json(purged)).toEqual({ closed: 0 });
    const again = await send('/plans/' + doc, { method: 'DELETE', token: a });
    expect(again.status).toBe(200);
    expect(await json(again)).toEqual({ closed: 0 });
    await refused(await send('/ticket', { method: 'POST', token: a, body: { doc } }), 410, GONE);
    await refused(await exports.default.fetch(upgrade('/parties/room/' + doc + '?ticket=' + encodeURIComponent(late))), 410, GONE);
  });

  it('DELETE /plans/<doc> of a plan the space does not know is 404 unknown_plan and reaches no room', async () => {
    const a = await enrol(newDevice(), 'Mac');
    const doc = newDoc();
    const unknown = { error: 'unknown_plan', message: 'The server does not know this plan yet. Let it sync, then delete it again.' };
    await refused(await send('/plans/' + doc, { method: 'DELETE', token: a }), 404, unknown);
    expect(await roomExists(doc)).toBe(false);
    expect(await ticketFor(a, doc)).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('DELETE /plans/<doc> refuses unknown and removed devices and docs that are not plans', async () => {
    const devB = newDevice();
    const a = await enrol(newDevice(), 'Mac');
    const b = await enrol(devB, 'iPad');
    const doc = newDoc();
    await refused(await send('/plans/' + doc, { method: 'DELETE' }), 401, UNKNOWN_DEVICE);
    await refused(await send('/plans/' + doc, { method: 'DELETE', token: 'not-a-token' }), 401, UNKNOWN_DEVICE);
    const spaceId = await runInDurableObject(env.Space.getByName('space'), (_space, state) =>
      String(state.storage.sql.exec("SELECT value FROM meta WHERE key = 'spaceId'").one().value),
    );
    const badDoc = { error: 'bad_request', message: 'The document id is not valid. Update WebBoard on this device.' };
    await refused(await send('/plans/ix-' + spaceId, { method: 'DELETE', token: a }), 400, badDoc);
    await refused(await send('/plans/local', { method: 'DELETE', token: a }), 400, badDoc);
    expect((await send('/devices/' + devB, { method: 'DELETE', token: a })).status).toBe(200);
    await refused(await send('/plans/' + doc, { method: 'DELETE', token: b }), 403, REVOKED);
    await refused(await send('/plans/' + doc, { token: a }), 405, expect.objectContaining({ error: 'not_found' }));
    expect(await ticketFor(a, doc)).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('an upgrade without a ticket never reaches a room', async () => {
    const doc = newDoc();
    const response = await exports.default.fetch(upgrade('/parties/room/' + doc, { [DEVICE_HEADER]: newDevice() }));
    await refused(response, 401, { error: 'unauthorized', message: 'The connection has no ticket. Connect again.' });
    const forged = await exports.default.fetch(upgrade('/parties/room/' + doc + '?ticket=forged'));
    await refused(forged, 401, BAD_TICKET);
    expect(await roomExists(doc)).toBe(false);
  });

  it('a ticket connects as its own device, whatever the client sends for the room', async () => {
    const devA = newDevice();
    const devB = newDevice();
    const a = await enrol(devA, 'Mac');
    const doc = newDoc();
    const ticket = await ticketFor(a, doc);
    expect(await roomExists(doc)).toBe(false);
    const seen: { url: string; device: string | null; props: string | null }[] = [];
    await runInDurableObject(env.Room.getByName(doc), (instance: Room) => {
      const real = instance.getConnectionTags.bind(instance);
      vi.spyOn(instance, 'getConnectionTags').mockImplementation((conn, ctx) => {
        seen.push({
          url: ctx.request.url,
          device: ctx.request.headers.get(DEVICE_HEADER),
          props: ctx.request.headers.get('x-partykit-props'),
        });
        return real(conn, ctx);
      });
    });
    const props = btoa(JSON.stringify({ admin: true }));
    const client = await connectDoc(() =>
      exports.default.fetch(
        upgrade('/parties/room/' + doc + '?ticket=' + encodeURIComponent(ticket) + '&_pk=chosen-by-client', {
          [DEVICE_HEADER]: devB,
          'x-partykit-props': props,
        }),
      ),
    );
    clients.push(client);
    await client.synced;
    expect(await roomExists(doc)).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0].device).toBe(devA);
    expect(seen[0].props).toBeNull();
    expect(new URL(seen[0].url).search).toBe('');
    const tags = await runInDurableObject(env.Room.getByName(doc), (room: Room, state) => ({
      a: state.getWebSockets('d:' + devA).length,
      b: state.getWebSockets('d:' + devB).length,
      connections: [...room.getConnections()].map((conn) => ({ id: conn.id, uri: String(conn.uri) })),
    }));
    expect(tags.a).toBe(1);
    expect(tags.b).toBe(0);
    expect(tags.connections).toHaveLength(1);
    expect(tags.connections[0].id).not.toBe('chosen-by-client');
    expect(new URL(tags.connections[0].uri).pathname).toBe('/parties/room/' + doc);
    expect(new URL(tags.connections[0].uri).search).toBe('');
    const reused = await exports.default.fetch(upgrade('/parties/room/' + doc + '?ticket=' + encodeURIComponent(ticket)));
    await refused(reused, 401, BAD_TICKET);
  });

  it('a ticket for another doc is refused', async () => {
    const a = await enrol(newDevice(), 'Mac');
    const ticket = await ticketFor(a, newDoc());
    const other = newDoc();
    await refused(await exports.default.fetch(upgrade('/parties/room/' + other + '?ticket=' + ticket)), 401, BAD_TICKET);
    expect(await roomExists(other)).toBe(false);
  });

  it('a removed device gets 403 before the upgrade', async () => {
    const devB = newDevice();
    const a = await enrol(newDevice(), 'Mac');
    const b = await enrol(devB, 'iPad');
    const doc = newDoc();
    const ticket = await ticketFor(b, doc);
    const removed = await send('/devices/' + devB, { method: 'DELETE', token: a });
    expect(removed.status).toBe(200);
    await refused(await exports.default.fetch(upgrade('/parties/room/' + doc + '?ticket=' + ticket)), 403, REVOKED);
    expect(await runInDurableObject(env.Room.getByName(doc), (_room, state) => state.getWebSockets().length)).toBe(0);
    await refused(await send('/devices', { token: b }), 403, REVOKED);
  });

  it('only /parties/room/<doc> reaches partyserver', async () => {
    await refused(await send('/parties/space/space'), 404, expect.objectContaining({ error: 'not_found' }));
    await refused(await exports.default.fetch(upgrade('/parties/space/space?ticket=t')), 404, expect.objectContaining({ error: 'not_found' }));
    await refused(await send('/parties/room/' + newDoc() + '/x'), 404, expect.objectContaining({ error: 'not_found' }));
    await refused(await exports.default.fetch(upgrade('/parties/room')), 404, expect.objectContaining({ error: 'not_found' }));
    await refused(await exports.default.fetch(upgrade('/parties/other/x?ticket=t')), 404, expect.objectContaining({ error: 'not_found' }));
    const doc = newDoc();
    await refused(await send('/parties/room/' + doc), 404, expect.objectContaining({ error: 'not_found' }));
    expect(await roomExists(doc)).toBe(false);
  });

  it('unknown paths are 404 and wrong methods 405, without CORS', async () => {
    await refused(await send('/nope'), 404, expect.objectContaining({ error: 'not_found' }));
    await refused(await send('/'), 404, expect.objectContaining({ error: 'not_found' }));
    await refused(await send('/ticket'), 405, expect.objectContaining({ error: 'not_found' }));
    const options = await send('/ticket', { method: 'OPTIONS', headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' } });
    await refused(options, 405, expect.objectContaining({ error: 'not_found' }));
    await refused(await send('/devices', { method: 'POST' }), 405, expect.objectContaining({ error: 'not_found' }));
    await refused(await send('/devices/' + newDevice()), 405, expect.objectContaining({ error: 'not_found' }));
    await refused(await send('/space', { method: 'PUT' }), 405, expect.objectContaining({ error: 'not_found' }));
  });

  it('a body over 4 KB is 413', async () => {
    const device = newDevice();
    const pad = (size: number): string => {
      const shell = JSON.stringify({ code: 'ABCD-2345', deviceId: device, deviceName: '' });
      return JSON.stringify({ code: 'ABCD-2345', deviceId: device, deviceName: 'n'.repeat(size - shell.length) });
    };
    expect(new TextEncoder().encode(pad(4097)).length).toBe(4097);
    await refused(await send('/pair/claim', { method: 'POST', body: pad(4097) }), 413, expect.objectContaining({ error: 'too_large' }));
    await refused(await send('/pair/claim', { method: 'POST', body: pad(4096) }), 404, BAD_CODE);
  });

  it('a 4th live pairing code is 429 with Retry-After', async () => {
    const a = await enrol(newDevice(), 'Mac');
    const codes = await Promise.all([1, 2, 3].map(() => pairingCode(a)));
    const fourth = await send('/pair', { method: 'POST', token: a });
    expect(retryAfter(fourth)).toBeGreaterThan(590);
    expect(retryAfter(fourth)).toBeLessThanOrEqual(600);
    await refused(fourth, 429, {
      error: 'rate_limited',
      message: 'Three pairing codes are already live. Use one or wait until one expires.',
    });
    for (const code of codes) {
      await claimed(code);
    }
  });
});
