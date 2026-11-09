import { routePartykitRequest, type Lobby } from 'partyserver';
import type { ErrorCode, Result } from './auth';
import type { Space } from './space';
import { DEVICE_HEADER } from './limits';

export { Room } from './room';
export { Space } from './space';

type Config = Omit<Env, 'SETUP_SECRET'> & { SETUP_SECRET?: string };

interface Call {
  env: Env;
  req: Request;
  match: RegExpExecArray;
  body: Uint8Array;
}

interface Route {
  path: RegExp;
  method: string;
  run(call: Call): Promise<Response>;
}

const MIN_SECRET_BYTES = 32;
const MAX_BODY_BYTES = 4096;
const SPACE_NAME = 'space';
const ROOM_PATH = /^\/parties\/room\/[^/]+$/;
const JSON_TYPE = 'application/json';

const NOT_CONFIGURED = 'The server has no setup secret. Run wrangler secret put SETUP_SECRET.';
const NOT_FOUND = 'There is nothing at this address on the WebBoard server.';
const WRONG_METHOD = 'This address does not take that method.';
const TOO_LARGE = 'The request body is larger than 4 KB.';
const NO_ADDRESS = 'The request carries no client address.';
const MALFORMED = 'The request body is not what this server expects. Update WebBoard on this device.';
const EMPTY_NAME = 'The name is empty. Type at least one character.';
const BAD_SECRET = 'The setup secret is not correct.';
const UNKNOWN_DEVICE = 'This device is not known to the space. Set up sync again.';
const NO_TICKET = 'The connection has no ticket. Connect again.';

function refuse(status: number, error: ErrorCode, message: string, retryAfter?: number): Response {
  const headers = new Headers({ 'Content-Type': JSON_TYPE });
  if (retryAfter !== undefined) {
    headers.set('Retry-After', String(retryAfter));
  }
  return new Response(JSON.stringify({ error, message }), { status, headers });
}

function answer<T>(result: Result<T>): Response {
  if (!result.ok) {
    return refuse(result.status, result.error, result.message, result.retryAfter);
  }
  return new Response(JSON.stringify(result.value), { status: 200, headers: { 'Content-Type': JSON_TYPE } });
}

function isConfigured(env: Config): env is Env {
  return env.SETUP_SECRET !== undefined && new TextEncoder().encode(env.SETUP_SECRET).length >= MIN_SECRET_BYTES;
}

function space(env: Env): DurableObjectStub<Space> {
  return env.Space.getByName(SPACE_NAME);
}

function bearer(req: Request): string | null {
  const header = req.headers.get('Authorization');
  return header !== null && header.startsWith('Bearer ') && header.length > 'Bearer '.length ? header.slice('Bearer '.length) : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parse(body: Uint8Array): Record<string, unknown> | null {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(body));
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof TypeError) {
      return null;
    }
    throw error;
  }
  return isRecord(value) ? value : null;
}

async function readBody(req: Request): Promise<Uint8Array | null> {
  if (req.body === null) {
    return new Uint8Array(0);
  }
  const parts: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of req.body) {
    size += chunk.byteLength;
    if (size > MAX_BODY_BYTES) {
      return null;
    }
    parts.push(chunk);
  }
  const bytes = new Uint8Array(size);
  parts.reduce((offset, part) => {
    bytes.set(part, offset);
    return offset + part.byteLength;
  }, 0);
  return bytes;
}

function address(req: Request): string | null {
  const ip = req.headers.get('CF-Connecting-IP');
  return ip === null || ip === '' ? null : ip;
}

function named(name: string): boolean {
  return name.trim().length > 0;
}

const ROUTES: readonly Route[] = [
  {
    path: /^\/space$/,
    method: 'POST',
    run: async ({ env, req, body }) => {
      const ip = address(req);
      if (ip === null) {
        return refuse(400, 'bad_request', NO_ADDRESS);
      }
      const secret = bearer(req);
      if (secret === null) {
        return refuse(401, 'unauthorized', BAD_SECRET);
      }
      const fields = parse(body);
      if (fields === null || typeof fields.deviceId !== 'string' || typeof fields.deviceName !== 'string') {
        return refuse(400, 'bad_request', MALFORMED);
      }
      if (!named(fields.deviceName)) {
        return refuse(400, 'bad_request', EMPTY_NAME);
      }
      return answer(await space(env).enrol(secret, fields.deviceId, fields.deviceName, ip));
    },
  },
  {
    path: /^\/pair$/,
    method: 'POST',
    run: async ({ env, req }) => {
      const token = bearer(req);
      if (token === null) {
        return refuse(401, 'unauthorized', UNKNOWN_DEVICE);
      }
      return answer(await space(env).pairCode(token));
    },
  },
  {
    path: /^\/pair\/claim$/,
    method: 'POST',
    run: async ({ env, req, body }) => {
      const ip = address(req);
      if (ip === null) {
        return refuse(400, 'bad_request', NO_ADDRESS);
      }
      const fields = parse(body);
      if (
        fields === null ||
        typeof fields.code !== 'string' ||
        typeof fields.deviceId !== 'string' ||
        typeof fields.deviceName !== 'string'
      ) {
        return refuse(400, 'bad_request', MALFORMED);
      }
      if (!named(fields.deviceName)) {
        return refuse(400, 'bad_request', EMPTY_NAME);
      }
      return answer(await space(env).claim(fields.code, fields.deviceId, fields.deviceName, ip));
    },
  },
  {
    path: /^\/ticket$/,
    method: 'POST',
    run: async ({ env, req, body }) => {
      const token = bearer(req);
      if (token === null) {
        return refuse(401, 'unauthorized', UNKNOWN_DEVICE);
      }
      const fields = parse(body);
      if (fields === null || typeof fields.doc !== 'string') {
        return refuse(400, 'bad_request', MALFORMED);
      }
      return answer(await space(env).ticket(token, fields.doc));
    },
  },
  {
    path: /^\/devices$/,
    method: 'GET',
    run: async ({ env, req }) => {
      const token = bearer(req);
      if (token === null) {
        return refuse(401, 'unauthorized', UNKNOWN_DEVICE);
      }
      return answer(await space(env).devices(token));
    },
  },
  {
    path: /^\/devices\/([^/]+)$/,
    method: 'DELETE',
    run: async ({ env, req, match }) => {
      const token = bearer(req);
      if (token === null) {
        return refuse(401, 'unauthorized', UNKNOWN_DEVICE);
      }
      return answer(await space(env).removeDevice(token, match[1]));
    },
  },
];

async function api(req: Request, env: Env, pathname: string): Promise<Response> {
  const matching = ROUTES.flatMap((route) => {
    const match = route.path.exec(pathname);
    return match === null ? [] : [{ route, match }];
  });
  if (matching.length === 0) {
    return refuse(404, 'not_found', NOT_FOUND);
  }
  const chosen = matching.find(({ route }) => route.method === req.method);
  if (chosen === undefined) {
    return refuse(405, 'not_found', WRONG_METHOD);
  }
  const body = await readBody(req);
  if (body === null) {
    return refuse(413, 'too_large', TOO_LARGE);
  }
  return chosen.route.run({ env, req, match: chosen.match, body });
}

async function admit(req: Request, lobby: Lobby<Env>, env: Env): Promise<Request | Response> {
  if (lobby.className !== 'Room') {
    return refuse(404, 'not_found', NOT_FOUND);
  }
  const url = new URL(req.url);
  const ticket = url.searchParams.get('ticket');
  if (ticket === null) {
    return refuse(401, 'unauthorized', NO_TICKET);
  }
  const consumed = await space(env).consumeTicket(ticket, lobby.name);
  if (!consumed.ok) {
    return answer(consumed);
  }
  url.searchParams.delete('ticket');
  const forwarded = new Request(url.toString(), req);
  forwarded.headers.set(DEVICE_HEADER, consumed.value.deviceId);
  return forwarded;
}

async function room(req: Request, env: Env, pathname: string): Promise<Response> {
  const routed = await routePartykitRequest(req, env, {
    onBeforeConnect: (incoming, lobby) => admit(incoming, lobby, env),
    onBeforeRequest: () => refuse(404, 'not_found', NOT_FOUND),
  });
  if (routed === null) {
    throw new Error(`partyserver did not route ${pathname}`);
  }
  return routed;
}

export async function handle(req: Request, env: Config): Promise<Response> {
  if (!isConfigured(env)) {
    return refuse(503, 'not_configured', NOT_CONFIGURED);
  }
  const pathname = new URL(req.url).pathname;
  return ROOM_PATH.test(pathname) ? room(req, env, pathname) : api(req, env, pathname);
}

export default { fetch: handle };
