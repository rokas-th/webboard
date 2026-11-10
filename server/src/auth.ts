import { int, text } from './sql';

export type ErrorCode =
  | 'unauthorized'
  | 'revoked'
  | 'rate_limited'
  | 'bad_code'
  | 'bad_request'
  | 'not_found'
  | 'too_large'
  | 'too_many_plans'
  | 'unknown_plan'
  | 'gone'
  | 'purge_pending'
  | 'not_configured'
  | 'internal';

export type Failure = {
  ok: false;
  status: 400 | 401 | 403 | 404 | 405 | 409 | 410 | 413 | 429 | 500 | 503;
  error: ErrorCode;
  message: string;
  retryAfter?: number;
};

export type Result<T> = { ok: true; value: T } | Failure;

export interface Enrolled {
  spaceId: string;
  deviceId: string;
  token: string;
}

export interface DeviceEntry {
  id: string;
  name: string;
  createdAt: number;
  lastSeenAt: number;
  current: boolean;
}

export interface Admission {
  enrolled: Enrolled;
  joins: string[];
}

const ATTEMPT_WINDOW_MS = 600_000;
const CODE_TTL_MS = 600_000;
const TICKET_TTL_MS = 60_000;
const TICKET_KEEP_MS = 3_600_000;
const MAX_LIVE_CODES = 3;
const MAX_ENROL_FAILURES_PER_IP = 5;
const MAX_CLAIM_FAILURES_PER_IP = 5;
const MAX_CLAIM_FAILURES_PER_SPACE = 20;
const MIN_SECRET_BYTES = 32;
const MAX_PLANS_PER_DEVICE = 500;
const UNTOLD_FIRST_RETRY_MS = 60_000;
const UNTOLD_MAX_RETRY_MS = 3_600_000;

const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_LENGTH = 8;
const DEVICE_ID = /^[A-Za-z0-9_-]{11}$/;
const PLAN_DOC = /^[A-Za-z0-9_-]{11}$/;

const NOT_CONFIGURED: Failure = {
  ok: false,
  status: 503,
  error: 'not_configured',
  message: 'The server has no setup secret. Run wrangler secret put SETUP_SECRET.',
};
const BAD_DEVICE_ID: Failure = {
  ok: false,
  status: 400,
  error: 'bad_request',
  message: 'The device id is not valid. Update WebBoard on this device.',
};
const BAD_SECRET: Failure = { ok: false, status: 401, error: 'unauthorized', message: 'The setup secret is not correct.' };
const UNKNOWN_DEVICE: Failure = {
  ok: false,
  status: 401,
  error: 'unauthorized',
  message: 'This device is not known to the space. Set up sync again.',
};
const REVOKED: Failure = { ok: false, status: 403, error: 'revoked', message: 'This device was removed from the space.' };
const BAD_CODE: Failure = {
  ok: false,
  status: 404,
  error: 'bad_code',
  message: 'The pairing code is wrong, used or expired. Show a new code on a device in the space.',
};
const BAD_TICKET: Failure = {
  ok: false,
  status: 401,
  error: 'unauthorized',
  message: 'The connection ticket is unknown, used or expired. Connect again.',
};
const BAD_DOC: Failure = {
  ok: false,
  status: 400,
  error: 'bad_request',
  message: 'The document id is not valid. Update WebBoard on this device.',
};
const TOO_MANY_PLANS: Failure = {
  ok: false,
  status: 409,
  error: 'too_many_plans',
  message: `This device has joined ${MAX_PLANS_PER_DEVICE} plans, the most one device may join.`,
};
const GONE: Failure = { ok: false, status: 410, error: 'gone', message: 'This plan was deleted forever on another device.' };
const UNKNOWN_PLAN: Failure = {
  ok: false,
  status: 404,
  error: 'unknown_plan',
  message: 'The server does not know this plan yet. Let it sync, then delete it again.',
};
export const PURGE_PENDING: Failure = {
  ok: false,
  status: 500,
  error: 'purge_pending',
  message: 'The plan is deleted, but the server has not erased its history yet. It tries again every minute.',
};
const REMOVE_SELF: Failure = { ok: false, status: 400, error: 'bad_request', message: 'Remove this device from another device.' };
const NO_SUCH_DEVICE: Failure = { ok: false, status: 404, error: 'not_found', message: 'This device is not in the space.' };

function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

function limited(message: string, retryAfter: number): Failure {
  return { ok: false, status: 429, error: 'rate_limited', message, retryAfter };
}

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

export function randomBase64url(length: number): string {
  return base64url(crypto.getRandomValues(new Uint8Array(length)));
}

function hex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, '0')).join('');
}

async function digest(input: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
}

export async function sha256Hex(input: string): Promise<string> {
  return hex(await digest(input));
}

export function normalizeCode(input: string): string {
  return input.toUpperCase().replace(/[-\s]/g, '').replaceAll('O', '0').replace(/[IL]/g, '1');
}

function newCode(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(CODE_LENGTH)), (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}

export function schema(sql: SqlStorage): void {
  sql.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  sql.exec(
    'CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, revoked_at INTEGER)',
  );
  sql.exec('CREATE TABLE IF NOT EXISTS codes (hash TEXT PRIMARY KEY, issuer TEXT NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER)');
  sql.exec(
    'CREATE TABLE IF NOT EXISTS tickets (hash TEXT PRIMARY KEY, doc TEXT NOT NULL, device TEXT NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER)',
  );
  sql.exec('CREATE TABLE IF NOT EXISTS joins (device TEXT NOT NULL, doc TEXT NOT NULL, PRIMARY KEY (device, doc))');
  sql.exec('CREATE TABLE IF NOT EXISTS untold (device TEXT NOT NULL, doc TEXT NOT NULL, PRIMARY KEY (device, doc))');
  sql.exec('CREATE TABLE IF NOT EXISTS retry (device TEXT PRIMARY KEY, delay INTEGER NOT NULL, due INTEGER NOT NULL)');
  sql.exec(
    'CREATE TABLE IF NOT EXISTS purged (doc TEXT PRIMARY KEY, device TEXT NOT NULL, at INTEGER NOT NULL, erased_at INTEGER)',
  );
  sql.exec('CREATE TABLE IF NOT EXISTS attempts (scope TEXT NOT NULL, at INTEGER NOT NULL)');
  sql.exec('CREATE INDEX IF NOT EXISTS attempts_scope ON attempts (scope, at)');
}

function inTransaction<T>(storage: DurableObjectStorage, run: (sql: SqlStorage) => T): T {
  return storage.transactionSync(() => run(storage.sql));
}

function spaceIdOf(sql: SqlStorage): string | null {
  const rows = sql.exec("SELECT value FROM meta WHERE key = 'spaceId'").toArray();
  return rows.length === 0 ? null : text(rows[0], 'value');
}

function requireSpaceId(sql: SqlStorage): string {
  const spaceId = spaceIdOf(sql);
  if (spaceId === null) {
    throw new Error('The space has devices or codes but no space id');
  }
  return spaceId;
}

function retryAfter(sql: SqlStorage, scope: string, limit: number, now: number): number | null {
  const times = sql
    .exec('SELECT at FROM attempts WHERE scope = ? AND at > ? ORDER BY at', scope, now - ATTEMPT_WINDOW_MS)
    .toArray()
    .map((row) => int(row, 'at'));
  return times.length < limit ? null : Math.ceil((times[times.length - limit] + ATTEMPT_WINDOW_MS - now) / 1000);
}

function recordFailure(sql: SqlStorage, scopes: readonly string[], now: number): void {
  sql.exec('DELETE FROM attempts WHERE at <= ?', now - ATTEMPT_WINDOW_MS);
  scopes.forEach((scope) => sql.exec('INSERT INTO attempts (scope, at) VALUES (?, ?)', scope, now));
}

type Caller = { ok: true; id: string } | Failure;

function caller(sql: SqlStorage, tokenHash: string): Caller {
  const rows = sql.exec('SELECT id, revoked_at IS NOT NULL AS revoked FROM devices WHERE token_hash = ?', tokenHash).toArray();
  if (rows.length === 0) {
    return UNKNOWN_DEVICE;
  }
  return int(rows[0], 'revoked') === 1 ? REVOKED : { ok: true, id: text(rows[0], 'id') };
}

function joinsOf(sql: SqlStorage, device: string): string[] {
  return sql
    .exec('SELECT doc FROM joins WHERE device = ? ORDER BY doc', device)
    .toArray()
    .map((row) => text(row, 'doc'));
}

function isPurged(sql: SqlStorage, doc: string): boolean {
  return sql.exec('SELECT 1 FROM purged WHERE doc = ?', doc).toArray().length > 0;
}

function plansFull(sql: SqlStorage, device: string, doc: string, index: string): boolean {
  if (sql.exec('SELECT 1 FROM joins WHERE device = ? AND doc = ?', device, doc).toArray().length > 0) {
    return false;
  }
  const joined = int(sql.exec('SELECT COUNT(*) AS n FROM joins WHERE device = ? AND doc != ?', device, index).one(), 'n');
  return joined >= MAX_PLANS_PER_DEVICE;
}

function dropSettledRetries(sql: SqlStorage): void {
  sql.exec('DELETE FROM retry WHERE device NOT IN (SELECT device FROM untold)');
}

function admit(
  sql: SqlStorage,
  spaceId: string,
  deviceId: string,
  deviceName: string,
  token: string,
  tokenHash: string,
  now: number,
): Admission {
  sql.exec(
    'INSERT INTO devices (id, name, token_hash, created_at, last_seen_at, revoked_at) VALUES (?, ?, ?, ?, ?, NULL) ON CONFLICT (id) DO UPDATE SET name = excluded.name, token_hash = excluded.token_hash, last_seen_at = excluded.last_seen_at, revoked_at = NULL',
    deviceId,
    deviceName,
    tokenHash,
    now,
    now,
  );
  sql.exec('DELETE FROM untold WHERE device = ?', deviceId);
  dropSettledRetries(sql);
  return { enrolled: { spaceId, deviceId, token }, joins: joinsOf(sql, deviceId) };
}

export async function enrol(
  storage: DurableObjectStorage,
  now: number,
  setupSecret: string | undefined,
  secret: string,
  deviceId: string,
  deviceName: string,
  ip: string,
): Promise<Result<Admission>> {
  if (setupSecret === undefined || new TextEncoder().encode(setupSecret).length < MIN_SECRET_BYTES) {
    return NOT_CONFIGURED;
  }
  if (!DEVICE_ID.test(deviceId)) {
    return BAD_DEVICE_ID;
  }
  const matches = crypto.subtle.timingSafeEqual(await digest(secret), await digest(setupSecret));
  const token = randomBase64url(32);
  const tokenHash = await sha256Hex(token);
  const scope = 'enrol:' + ip;
  return inTransaction(storage, (sql): Result<Admission> => {
    const wait = retryAfter(sql, scope, MAX_ENROL_FAILURES_PER_IP, now);
    if (wait !== null) {
      return limited('Too many wrong setup secrets from this address.', wait);
    }
    if (!matches) {
      recordFailure(sql, [scope], now);
      return BAD_SECRET;
    }
    const existing = spaceIdOf(sql);
    const spaceId = existing ?? randomBase64url(8);
    if (existing === null) {
      sql.exec("INSERT INTO meta (key, value) VALUES ('spaceId', ?)", spaceId);
    }
    return ok(admit(sql, spaceId, deviceId, deviceName, token, tokenHash, now));
  });
}

export async function pairCode(
  storage: DurableObjectStorage,
  now: number,
  token: string,
): Promise<Result<{ code: string; expiresAt: number }>> {
  const tokenHash = await sha256Hex(token);
  const code = newCode();
  const codeHash = await sha256Hex(code);
  return inTransaction(storage, (sql): Result<{ code: string; expiresAt: number }> => {
    const who = caller(sql, tokenHash);
    if (!who.ok) {
      return who;
    }
    sql.exec('DELETE FROM codes WHERE expires_at <= ?', now);
    const live = sql
      .exec('SELECT expires_at FROM codes WHERE used_at IS NULL ORDER BY expires_at')
      .toArray()
      .map((row) => int(row, 'expires_at'));
    if (live.length >= MAX_LIVE_CODES) {
      return limited(
        'Three pairing codes are already live. Use one or wait until one expires.',
        Math.ceil((live[0] - now) / 1000),
      );
    }
    const expiresAt = now + CODE_TTL_MS;
    sql.exec('INSERT INTO codes (hash, issuer, expires_at, used_at) VALUES (?, ?, ?, NULL)', codeHash, who.id, expiresAt);
    return ok({ code: code.slice(0, 4) + '-' + code.slice(4), expiresAt });
  });
}

export async function claim(
  storage: DurableObjectStorage,
  now: number,
  code: string,
  deviceId: string,
  deviceName: string,
  ip: string,
): Promise<Result<Admission>> {
  if (!DEVICE_ID.test(deviceId)) {
    return BAD_DEVICE_ID;
  }
  const codeHash = await sha256Hex(normalizeCode(code));
  const token = randomBase64url(32);
  const tokenHash = await sha256Hex(token);
  const ipScope = 'claim:' + ip;
  const spaceScope = 'claim';
  return inTransaction(storage, (sql): Result<Admission> => {
    const found = sql
      .exec(
        'SELECT codes.hash FROM codes JOIN devices ON devices.id = codes.issuer WHERE codes.hash = ? AND codes.used_at IS NULL AND codes.expires_at > ? AND devices.revoked_at IS NULL',
        codeHash,
        now,
      )
      .toArray();
    if (found.length > 0) {
      sql.exec('UPDATE codes SET used_at = ? WHERE hash = ?', now, codeHash);
      return ok(admit(sql, requireSpaceId(sql), deviceId, deviceName, token, tokenHash, now));
    }
    const waits = [
      retryAfter(sql, ipScope, MAX_CLAIM_FAILURES_PER_IP, now),
      retryAfter(sql, spaceScope, MAX_CLAIM_FAILURES_PER_SPACE, now),
    ].filter((wait) => wait !== null);
    if (waits.length > 0) {
      return limited('Too many wrong pairing codes.', Math.max(...waits));
    }
    recordFailure(sql, [ipScope, spaceScope], now);
    return BAD_CODE;
  });
}

export async function ticket(
  storage: DurableObjectStorage,
  now: number,
  token: string,
  doc: string,
): Promise<Result<{ ticket: string; expiresAt: number }>> {
  const tokenHash = await sha256Hex(token);
  const issued = randomBase64url(32);
  const ticketHash = await sha256Hex(issued);
  return inTransaction(storage, (sql): Result<{ ticket: string; expiresAt: number }> => {
    const who = caller(sql, tokenHash);
    if (!who.ok) {
      return who;
    }
    const index = 'ix-' + requireSpaceId(sql);
    if (!PLAN_DOC.test(doc) && doc !== index) {
      return BAD_DOC;
    }
    if (doc !== index && isPurged(sql, doc)) {
      return GONE;
    }
    if (doc !== index && plansFull(sql, who.id, doc, index)) {
      return TOO_MANY_PLANS;
    }
    const expiresAt = now + TICKET_TTL_MS;
    sql.exec('DELETE FROM tickets WHERE expires_at - ? <= ?', TICKET_TTL_MS, now - TICKET_KEEP_MS);
    sql.exec('INSERT INTO joins (device, doc) VALUES (?, ?) ON CONFLICT (device, doc) DO NOTHING', who.id, doc);
    sql.exec('UPDATE devices SET last_seen_at = ? WHERE id = ?', now, who.id);
    sql.exec(
      'INSERT INTO tickets (hash, doc, device, expires_at, used_at) VALUES (?, ?, ?, ?, NULL)',
      ticketHash,
      doc,
      who.id,
      expiresAt,
    );
    return ok({ ticket: issued, expiresAt });
  });
}

export async function consumeTicket(
  storage: DurableObjectStorage,
  now: number,
  presented: string,
  doc: string,
): Promise<Result<{ deviceId: string }>> {
  const ticketHash = await sha256Hex(presented);
  return inTransaction(storage, (sql): Result<{ deviceId: string }> => {
    if (isPurged(sql, doc)) {
      return GONE;
    }
    const rows = sql
      .exec(
        'SELECT device FROM tickets WHERE hash = ? AND doc = ? AND used_at IS NULL AND expires_at > ?',
        ticketHash,
        doc,
        now,
      )
      .toArray();
    if (rows.length === 0) {
      return BAD_TICKET;
    }
    const deviceId = text(rows[0], 'device');
    sql.exec('UPDATE tickets SET used_at = ? WHERE hash = ?', now, ticketHash);
    const device = sql.exec('SELECT revoked_at IS NOT NULL AS revoked FROM devices WHERE id = ?', deviceId).toArray();
    if (device.length === 0) {
      throw new Error('Space: ticket for unknown device ' + deviceId);
    }
    return int(device[0], 'revoked') === 1 ? REVOKED : ok({ deviceId });
  });
}

export async function devices(storage: DurableObjectStorage, token: string): Promise<Result<{ devices: DeviceEntry[] }>> {
  const tokenHash = await sha256Hex(token);
  return inTransaction(storage, (sql): Result<{ devices: DeviceEntry[] }> => {
    const who = caller(sql, tokenHash);
    if (!who.ok) {
      return who;
    }
    const listed = sql
      .exec('SELECT id, name, created_at, last_seen_at FROM devices WHERE revoked_at IS NULL ORDER BY created_at, id')
      .toArray()
      .map(
        (row): DeviceEntry => ({
          id: text(row, 'id'),
          name: text(row, 'name'),
          createdAt: int(row, 'created_at'),
          lastSeenAt: int(row, 'last_seen_at'),
          current: text(row, 'id') === who.id,
        }),
      );
    return ok({ devices: listed });
  });
}

export async function removeDevice(
  storage: DurableObjectStorage,
  now: number,
  token: string,
  id: string,
): Promise<Result<{ joins: string[] }>> {
  const tokenHash = await sha256Hex(token);
  return inTransaction(storage, (sql): Result<{ joins: string[] }> => {
    const who = caller(sql, tokenHash);
    if (!who.ok) {
      return who;
    }
    if (id === who.id) {
      return REMOVE_SELF;
    }
    if (sql.exec('SELECT 1 FROM devices WHERE id = ?', id).toArray().length === 0) {
      return NO_SUCH_DEVICE;
    }
    sql.exec('UPDATE devices SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?', now, id);
    sql.exec('DELETE FROM codes WHERE issuer = ? AND used_at IS NULL', id);
    return ok({ joins: joinsOf(sql, id) });
  });
}

export function keepUntold(storage: DurableObjectStorage, now: number, device: string, docs: readonly string[], fresh: boolean): void {
  inTransaction(storage, (sql) => {
    sql.exec('DELETE FROM untold WHERE device = ?', device);
    docs.forEach((doc) => sql.exec('INSERT INTO untold (device, doc) VALUES (?, ?)', device, doc));
    if (docs.length > 0) {
      sql.exec(
        fresh
          ? 'INSERT INTO retry (device, delay, due) VALUES (?, ?, ?) ON CONFLICT (device) DO UPDATE SET delay = excluded.delay, due = excluded.due'
          : 'INSERT INTO retry (device, delay, due) VALUES (?, ?, ?) ON CONFLICT (device) DO NOTHING',
        device,
        UNTOLD_FIRST_RETRY_MS,
        now + UNTOLD_FIRST_RETRY_MS,
      );
    }
    dropSettledRetries(sql);
  });
}

export function nextUntoldRetry(storage: DurableObjectStorage): number | null {
  const rows = storage.sql.exec('SELECT due FROM retry ORDER BY due LIMIT 1').toArray();
  return rows.length === 0 ? null : int(rows[0], 'due');
}

export function backOffUntold(storage: DurableObjectStorage, now: number, device: string): void {
  const rows = storage.sql.exec('SELECT delay FROM retry WHERE device = ?', device).toArray();
  if (rows.length === 0) {
    throw new Error(`Space: no untold retry to back off for ${device}`);
  }
  const delay = Math.min(int(rows[0], 'delay') * 2, UNTOLD_MAX_RETRY_MS);
  storage.sql.exec('UPDATE retry SET delay = ?, due = ? WHERE device = ?', delay, now + delay, device);
}

export function hasUntoldRetry(storage: DurableObjectStorage, device: string): boolean {
  return storage.sql.exec('SELECT 1 FROM retry WHERE device = ?', device).toArray().length > 0;
}

export function dueUntoldDevices(storage: DurableObjectStorage, now: number): string[] {
  return storage.sql
    .exec('SELECT device FROM retry WHERE due <= ? ORDER BY device', now)
    .toArray()
    .map((row) => text(row, 'device'));
}

export function untoldOf(storage: DurableObjectStorage, device: string): string[] {
  return storage.sql
    .exec('SELECT doc FROM untold WHERE device = ? ORDER BY doc', device)
    .toArray()
    .map((row) => text(row, 'doc'));
}

export async function purgePlan(
  storage: DurableObjectStorage,
  now: number,
  token: string,
  doc: string,
): Promise<Result<{ device: string }>> {
  const tokenHash = await sha256Hex(token);
  return inTransaction(storage, (sql): Result<{ device: string }> => {
    const who = caller(sql, tokenHash);
    if (!who.ok) {
      return who;
    }
    if (!PLAN_DOC.test(doc)) {
      return BAD_DOC;
    }
    if (!isPurged(sql, doc) && sql.exec('SELECT 1 FROM joins WHERE doc = ? LIMIT 1', doc).toArray().length === 0) {
      return UNKNOWN_PLAN;
    }
    sql.exec('INSERT INTO purged (doc, device, at, erased_at) VALUES (?, ?, ?, NULL) ON CONFLICT (doc) DO NOTHING', doc, who.id, now);
    ['joins', 'tickets', 'untold'].forEach((table) => sql.exec(`DELETE FROM ${table} WHERE doc = ?`, doc));
    dropSettledRetries(sql);
    return ok({ device: who.id });
  });
}

export function markErased(storage: DurableObjectStorage, now: number, doc: string): void {
  storage.sql.exec('UPDATE purged SET erased_at = ? WHERE doc = ? AND erased_at IS NULL', now, doc);
}

export function unerased(storage: DurableObjectStorage): { doc: string; device: string }[] {
  return storage.sql
    .exec('SELECT doc, device FROM purged WHERE erased_at IS NULL ORDER BY at, doc')
    .toArray()
    .map((row) => ({ doc: text(row, 'doc'), device: text(row, 'device') }));
}
