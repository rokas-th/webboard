import { env, listDurableObjectIds, runInDurableObject } from 'cloudflare:test';
import { exports } from 'cloudflare:workers';
import { afterAll, describe, expect, it } from 'vitest';
import { handle } from '../src/index';
import { DEVICE_HEADER } from '../src/limits';
import { connectDoc, type TestClient } from './client';
import { newDoc } from './helpers';

const ORIGIN = 'https://webboard.rokass.org';
const SECRET = env.SETUP_SECRET;
const IP = '203.0.113.7';
const DEV_A = 'devA0000000';
const DEV_B = 'devB0000000';
const DEV_C = 'devC0000000';
const NOT_CONFIGURED = {
  error: 'not_configured',
  message: 'The server has no setup secret. Run wrangler secret put SETUP_SECRET.',
};
const BAD_SECRET = { error: 'unauthorized', message: 'The setup secret is not correct.' };
const UNKNOWN_DEVICE = { error: 'unauthorized', message: 'This device is not known to the space. Set up sync again.' };
const NO_ADDRESS = { error: 'bad_request', message: 'The request carries no client address.' };
const EMPTY_NAME = { error: 'bad_request', message: 'The name is empty. Type at least one character.' };

interface Call {
  method?: string;
  token?: string;
  body?: unknown;
  ip?: string | null;
  headers?: Record<string, string>;
}

function request(path: string, call: Call = {}): Request {
  const headers = new Headers(call.headers);
  if (call.token !== undefined) {
    headers.set('Authorization', 'Bearer ' + call.token);
  }
  const ip = call.ip === undefined ? IP : call.ip;
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

async function refused(response: Response, status: number, body: unknown): Promise<void> {
  expect(response.status).toBe(status);
  expect(response.webSocket).toBeNull();
  expect(await json(response)).toEqual(body);
  expect([...response.headers.keys()].filter((key) => key.startsWith('access-control-'))).toEqual([]);
}

async function roomExists(doc: string): Promise<boolean> {
  const id = env.Room.idFromName(doc);
  return (await listDurableObjectIds(env.Room)).some((listed) => listed.equals(id));
}

async function enrol(device: string, name: string): Promise<string> {
  const response = await send('/space', { method: 'POST', token: SECRET, body: { deviceId: device, deviceName: name } });
  expect(response.status).toBe(200);
  const body = await response.json<{ spaceId: string; deviceId: string; token: string }>();
  expect(body.deviceId).toBe(device);
  return body.token;
}

async function ticketFor(token: string, doc: string): Promise<string> {
  const response = await send('/ticket', { method: 'POST', token, body: { doc } });
  expect(response.status).toBe(200);
  return (await response.json<{ ticket: string; expiresAt: number }>()).ticket;
}

describe('the worker', () => {
  const clients: TestClient[] = [];

  afterAll(async () => {
    clients.forEach((client) => client.close());
    await Promise.all(clients.map((client) => client.closed));
  });

  it('an unconfigured server answers 503 everywhere', async () => {
    const doc = newDoc();
    const requests = (): Request[] => [
      request('/space', { method: 'POST', token: 'x'.repeat(31), body: { deviceId: DEV_C, deviceName: 'Mac' } }),
      request('/pair', { method: 'POST', token: 'tok' }),
      request('/pair/claim', { method: 'POST', body: { code: 'ABCD-2345', deviceId: DEV_C, deviceName: 'Mac' } }),
      request('/ticket', { method: 'POST', token: 'tok', body: { doc } }),
      request('/devices', { token: 'tok' }),
      request('/devices/dev00000000', { method: 'DELETE', token: 'tok' }),
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
    expect(SECRET).toBe('x'.repeat(32));
    const response = await handle(
      request('/space', { method: 'POST', token: 'x'.repeat(32), body: { deviceId: DEV_C, deviceName: 'Mac' } }),
      { ...env, SETUP_SECRET: 'x'.repeat(32) },
    );
    expect(response.status).toBe(200);
    expect(await json(response)).toMatchObject({ deviceId: DEV_C });
  });

  it('POST /space refuses a missing or wrong setup secret', async () => {
    const body = { deviceId: DEV_A, deviceName: 'Mac' };
    await refused(await send('/space', { method: 'POST', body }), 401, BAD_SECRET);
    await refused(await send('/space', { method: 'POST', body, token: 'wrong' }), 401, BAD_SECRET);
  });

  it('an enrolment without a client address is refused', async () => {
    await refused(
      await handle(request('/space', { method: 'POST', token: SECRET, ip: null, body: { deviceId: DEV_A, deviceName: 'Mac' } }), env),
      400,
      NO_ADDRESS,
    );
    await refused(
      await handle(
        request('/pair/claim', { method: 'POST', ip: null, body: { code: 'ABCD-2345', deviceId: DEV_A, deviceName: 'Mac' } }),
        env,
      ),
      400,
      NO_ADDRESS,
    );
  });

  it('an empty device name is refused before the space', async () => {
    await refused(await send('/space', { method: 'POST', token: SECRET, body: { deviceId: DEV_A, deviceName: '  ' } }), 400, EMPTY_NAME);
    await refused(
      await send('/pair/claim', { method: 'POST', body: { code: 'ABCD-2345', deviceId: DEV_A, deviceName: '' } }),
      400,
      EMPTY_NAME,
    );
  });

  it('a body that is not the expected JSON is refused', async () => {
    const malformed = { error: 'bad_request', message: 'The request body is not what this server expects. Update WebBoard on this device.' };
    await refused(await send('/space', { method: 'POST', token: SECRET, body: '{' }), 400, malformed);
    await refused(await send('/space', { method: 'POST', token: SECRET, body: { deviceId: DEV_A } }), 400, malformed);
    await refused(await send('/pair/claim', { method: 'POST', body: [] }), 400, malformed);
    await refused(await send('/ticket', { method: 'POST', token: 'tok', body: { doc: 7 } }), 400, malformed);
    const notUtf8 = new Request(ORIGIN + '/ticket', {
      method: 'POST',
      headers: { Authorization: 'Bearer tok', 'CF-Connecting-IP': IP },
      body: new Uint8Array([0x7b, 0x22, 0x64, 0x6f, 0x63, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]),
    });
    await refused(await exports.default.fetch(notUtf8), 400, malformed);
  });

  it('every Bearer route refuses an unknown device', async () => {
    await refused(await send('/devices'), 401, UNKNOWN_DEVICE);
    await refused(await send('/pair', { method: 'POST' }), 401, UNKNOWN_DEVICE);
    await refused(await send('/ticket', { method: 'POST', body: { doc: newDoc() } }), 401, UNKNOWN_DEVICE);
    await refused(await send('/devices/dev00000000', { method: 'DELETE' }), 401, UNKNOWN_DEVICE);
    await refused(await send('/devices', { token: 'not-a-token' }), 401, UNKNOWN_DEVICE);
    await refused(await send('/devices', { headers: { Authorization: 'Basic abc' } }), 401, UNKNOWN_DEVICE);
  });

  it('routes the space API to the Space', async () => {
    const a = await enrol(DEV_A, 'Mac');
    const b = await enrol(DEV_B, 'iPad');
    const listed = await send('/devices', { token: a });
    expect(listed.status).toBe(200);
    const { devices } = await listed.json<{ devices: { id: string; current: boolean }[] }>();
    expect(devices.filter((d) => d.id === DEV_A || d.id === DEV_B)).toEqual([
      expect.objectContaining({ id: DEV_A, current: true }),
      expect.objectContaining({ id: DEV_B, current: false }),
    ]);
    const paired = await send('/pair', { method: 'POST', token: b });
    expect(paired.status).toBe(200);
    const { code } = await paired.json<{ code: string; expiresAt: number }>();
    const claimed = await send('/pair/claim', { method: 'POST', body: { code, deviceId: DEV_B, deviceName: 'iPad 2' } });
    expect(claimed.status).toBe(200);
    expect(await json(claimed)).toMatchObject({ deviceId: DEV_B });
    await refused(await send('/devices/devZ0000000', { method: 'DELETE', token: a }), 404, {
      error: 'not_found',
      message: 'This device is not in the space.',
    });
    const removed = await send('/devices/' + DEV_C, { method: 'DELETE', token: a });
    expect(removed.status).toBe(200);
    expect(await json(removed)).toEqual({ closed: 0 });
    await refused(await send('/ticket', { method: 'POST', token: a, body: { doc: 'local' } }), 400, {
      error: 'bad_request',
      message: 'The document id is not valid. Update WebBoard on this device.',
    });
  });

  it('an upgrade without a ticket never reaches a room', async () => {
    const doc = newDoc();
    const response = await exports.default.fetch(upgrade('/parties/room/' + doc, { [DEVICE_HEADER]: DEV_A }));
    await refused(response, 401, { error: 'unauthorized', message: 'The connection has no ticket. Connect again.' });
    const forged = await exports.default.fetch(upgrade('/parties/room/' + doc + '?ticket=forged'));
    await refused(forged, 401, { error: 'unauthorized', message: 'The connection ticket is unknown, used or expired. Connect again.' });
    expect(await roomExists(doc)).toBe(false);
  });

  it('a ticket connects as its own device, whatever device header the client sends', async () => {
    const a = await enrol(DEV_A, 'Mac');
    const doc = newDoc();
    const ticket = await ticketFor(a, doc);
    const client = await connectDoc(() =>
      exports.default.fetch(upgrade('/parties/room/' + doc + '?ticket=' + encodeURIComponent(ticket), { [DEVICE_HEADER]: DEV_B })),
    );
    clients.push(client);
    await client.synced;
    const tags = await runInDurableObject(env.Room.getByName(doc), (room, state) => ({
      a: state.getWebSockets('d:' + DEV_A).length,
      b: state.getWebSockets('d:' + DEV_B).length,
      uris: [...room.getConnections()].map((conn) => String(conn.uri)),
    }));
    expect(tags.a).toBe(1);
    expect(tags.b).toBe(0);
    expect(tags.uris).toHaveLength(1);
    expect(tags.uris[0]).toContain('/parties/room/' + doc);
    expect(tags.uris[0]).not.toContain(ticket);
    expect(tags.uris[0]).not.toContain('ticket=');
    const reused = await exports.default.fetch(upgrade('/parties/room/' + doc + '?ticket=' + encodeURIComponent(ticket)));
    await refused(reused, 401, { error: 'unauthorized', message: 'The connection ticket is unknown, used or expired. Connect again.' });
  });

  it('a ticket for another doc is refused', async () => {
    const a = await enrol(DEV_A, 'Mac');
    const ticket = await ticketFor(a, newDoc());
    const other = newDoc();
    await refused(await exports.default.fetch(upgrade('/parties/room/' + other + '?ticket=' + ticket)), 401, {
      error: 'unauthorized',
      message: 'The connection ticket is unknown, used or expired. Connect again.',
    });
    expect(await roomExists(other)).toBe(false);
  });

  it('a removed device gets 403 before the upgrade', async () => {
    const a = await enrol(DEV_A, 'Mac');
    const b = await enrol(DEV_B, 'iPad');
    const doc = newDoc();
    const ticket = await ticketFor(b, doc);
    const removed = await send('/devices/' + DEV_B, { method: 'DELETE', token: a });
    expect(removed.status).toBe(200);
    await refused(await exports.default.fetch(upgrade('/parties/room/' + doc + '?ticket=' + ticket)), 403, {
      error: 'revoked',
      message: 'This device was removed from the space.',
    });
    expect(await runInDurableObject(env.Room.getByName(doc), (_room, state) => state.getWebSockets().length)).toBe(0);
    await refused(await send('/devices', { token: b }), 403, { error: 'revoked', message: 'This device was removed from the space.' });
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
    await refused(await send('/devices/' + DEV_A), 405, expect.objectContaining({ error: 'not_found' }));
    await refused(await send('/space', { method: 'PUT' }), 405, expect.objectContaining({ error: 'not_found' }));
  });

  it('a body over 4 KB is 413', async () => {
    const pad = (size: number): string => {
      const shell = JSON.stringify({ code: 'ABCD-2345', deviceId: DEV_A, deviceName: '' });
      return JSON.stringify({ code: 'ABCD-2345', deviceId: DEV_A, deviceName: 'n'.repeat(size - shell.length) });
    };
    expect(new TextEncoder().encode(pad(4097)).length).toBe(4097);
    await refused(await send('/pair/claim', { method: 'POST', body: pad(4097) }), 413, expect.objectContaining({ error: 'too_large' }));
    const atLimit = await send('/pair/claim', { method: 'POST', body: pad(4096) });
    expect(atLimit.status).toBe(404);
    expect(await json(atLimit)).toMatchObject({ error: 'bad_code' });
  });

  it('a 4th live pairing code is 429 with Retry-After', async () => {
    const a = await enrol(DEV_A, 'Mac');
    const codes = await Promise.all([1, 2, 3].map(() => send('/pair', { method: 'POST', token: a })));
    expect(codes.map((response) => response.status)).toEqual([200, 200, 200]);
    const fourth = await send('/pair', { method: 'POST', token: a });
    expect(fourth.headers.get('Retry-After')).toBe('600');
    await refused(fourth, 429, {
      error: 'rate_limited',
      message: 'Three pairing codes are already live. Use one or wait until one expires.',
    });
  });
});
