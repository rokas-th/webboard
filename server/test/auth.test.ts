import { env, runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  claim,
  consumeTicket,
  devices,
  enrol,
  keepUntold,
  markErased,
  normalizeCode,
  pairCode,
  purgePlan,
  removeDevice,
  schema,
  sha256Hex,
  ticket,
  unerased,
} from '../src/auth';
import { int, text } from '../src/sql';
import { value } from './helpers';

const SECRET = env.SETUP_SECRET;
const DEV_A = 'devA0000000';
const DEV_B = 'devB0000000';
const DEV_C = 'devC0000000';
const T = 1_800_000_000_000;
const UNKNOWN = { ok: false, status: 401, error: 'unauthorized', message: 'This device is not known to the space. Set up sync again.' };
const REVOKED = { ok: false, status: 403, error: 'revoked', message: 'This device was removed from the space.' };
const BAD_CODE = {
  ok: false,
  status: 404,
  error: 'bad_code',
  message: 'The pairing code is wrong, used or expired. Show a new code on a device in the space.',
};
const BAD_DEVICE = { ok: false, status: 400, error: 'bad_request', message: 'The device id is not valid. Update WebBoard on this device.' };
const CODE = /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;

const TABLES = ['meta', 'devices', 'codes', 'tickets', 'joins', 'attempts'];

function inSpace<R>(name: string, run: (storage: DurableObjectStorage) => Promise<R>): Promise<R> {
  return runInDurableObject(env.Space.getByName('t-' + name), (_space, state) => {
    schema(state.storage.sql);
    return run(state.storage);
  });
}

function count(storage: DurableObjectStorage, table: string): number {
  return int(storage.sql.exec(`SELECT COUNT(*) AS n FROM ${table}`).one(), 'n');
}

async function enrolled(storage: DurableObjectStorage, device: string, now = T): Promise<{ spaceId: string; token: string }> {
  const admitted = value(await enrol(storage, now, SECRET, SECRET, device, 'Device ' + device, '9.9.9.9'));
  return { spaceId: admitted.enrolled.spaceId, token: admitted.enrolled.token };
}

async function liveCode(storage: DurableObjectStorage, token: string, now = T): Promise<string> {
  return value(await pairCode(storage, now, token)).code;
}

function otherCode(code: string): string {
  const swap = code[0] === 'A' ? 'B' : 'A';
  return swap + code.slice(1);
}

describe('auth', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('stores tokens only as SHA-256 hashes', async () => {
    await inSpace('hashes', async (storage) => {
      const admitted = value(await enrol(storage, T, SECRET, SECRET, DEV_A, 'Mac', '1.1.1.1'));
      expect(admitted.enrolled.spaceId).toMatch(/^[A-Za-z0-9_-]{11}$/);
      expect(admitted.enrolled.deviceId).toBe(DEV_A);
      expect(admitted.enrolled.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      const hash = text(storage.sql.exec('SELECT token_hash FROM devices WHERE id = ?', DEV_A).one(), 'token_hash');
      expect(hash).toBe(await sha256Hex(admitted.enrolled.token));
      const code = await liveCode(storage, admitted.enrolled.token);
      const issued = value(await ticket(storage, T, admitted.enrolled.token, 'docA0000000'));
      expect(issued.ticket).toMatch(/^[A-Za-z0-9_-]{43}$/);
      const secrets = [admitted.enrolled.token, code, code.replace('-', ''), issued.ticket];
      const cells = TABLES.flatMap((table) =>
        storage.sql.exec(`SELECT * FROM ${table}`).toArray().flatMap((row) => Object.values(row)),
      );
      expect(cells.filter((cell) => secrets.includes(String(cell)))).toEqual([]);
      expect(text(storage.sql.exec('SELECT hash FROM tickets').one(), 'hash')).toBe(await sha256Hex(issued.ticket));
      expect(text(storage.sql.exec('SELECT hash FROM codes').one(), 'hash')).toBe(await sha256Hex(code.replace('-', '')));
    });
  });

  it('answers not_configured without a setup secret of 32 bytes', async () => {
    await inSpace('not-configured', async (storage) => {
      const refused = {
        ok: false,
        status: 503,
        error: 'not_configured',
        message: 'The server has no setup secret. Run wrangler secret put SETUP_SECRET.',
      };
      const short = 'x'.repeat(31);
      expect(await enrol(storage, T, undefined, short, DEV_A, 'Mac', '1.1.1.1')).toEqual(refused);
      expect(await enrol(storage, T, '', '', DEV_A, 'Mac', '1.1.1.1')).toEqual(refused);
      expect(await enrol(storage, T, short, short, DEV_A, 'Mac', '1.1.1.1')).toEqual(refused);
      expect(await enrol(storage, T, undefined, SECRET, 'short', 'Mac', '1.1.1.1')).toEqual(refused);
      expect(TABLES.map((table) => count(storage, table))).toEqual([0, 0, 0, 0, 0, 0]);
      const wide = 'é'.repeat(16);
      expect(value(await enrol(storage, T, wide, wide, DEV_A, 'Mac', '1.1.1.1')).enrolled.deviceId).toBe(DEV_A);
      expect(count(storage, 'devices')).toBe(1);
      expect(count(storage, 'attempts')).toBe(0);
    });
  });

  it('401s carry the exact messages', async () => {
    await inSpace('messages', async (storage) => {
      expect(await enrol(storage, T, SECRET, SECRET + 'x', DEV_A, 'Mac', '1.1.1.1')).toEqual({
        ok: false,
        status: 401,
        error: 'unauthorized',
        message: 'The setup secret is not correct.',
      });
      const { spaceId } = await enrolled(storage, DEV_A);
      expect(await devices(storage, 'tok_unknown')).toEqual(UNKNOWN);
      expect(await pairCode(storage, T, 'tok_unknown')).toEqual(UNKNOWN);
      expect(await ticket(storage, T, 'tok_unknown', 'ix-' + spaceId)).toEqual(UNKNOWN);
      expect(await removeDevice(storage, T, 'tok_unknown', DEV_A)).toEqual(UNKNOWN);
    });
  });

  it('refuses a device id that is not 11 base64url characters', async () => {
    await inSpace('device-id', async (storage) => {
      const { token } = await enrolled(storage, DEV_A);
      const code = await liveCode(storage, token);
      const bad = ['short', 'devA000000!', 'devA00000000'];
      const devicesBefore = count(storage, 'devices');
      const attemptsBefore = count(storage, 'attempts');
      for (const id of bad) {
        expect(await enrol(storage, T, SECRET, SECRET, id, 'Mac', '1.1.1.1')).toEqual(BAD_DEVICE);
        expect(await claim(storage, T, code, id, 'Mac', '1.1.1.1')).toEqual(BAD_DEVICE);
      }
      expect(count(storage, 'devices')).toBe(devicesBefore);
      expect(count(storage, 'attempts')).toBe(attemptsBefore);
      expect(value(await claim(storage, T, code, DEV_B, 'iPad', '1.1.1.1')).enrolled.deviceId).toBe(DEV_B);
    });
  });

  it('enrol creates the space once and joins it after', async () => {
    await inSpace('create-join', async (storage) => {
      const a = await enrolled(storage, DEV_A);
      const b = await enrolled(storage, DEV_B, T + 5);
      expect(b.spaceId).toBe(a.spaceId);
      expect(count(storage, 'meta')).toBe(1);
      const listed = value(await devices(storage, b.token)).devices;
      expect(listed).toEqual([
        { id: DEV_A, name: 'Device ' + DEV_A, createdAt: T, lastSeenAt: T, current: false },
        { id: DEV_B, name: 'Device ' + DEV_B, createdAt: T + 5, lastSeenAt: T + 5, current: true },
      ]);
    });
  });

  it('enrol re-admits a known device with a new token', async () => {
    await inSpace('readmit-enrol', async (storage) => {
      const a = await enrolled(storage, DEV_A);
      const b = await enrolled(storage, DEV_B);
      value(await ticket(storage, T, a.token, 'docA0000000'));
      value(await removeDevice(storage, T, b.token, DEV_A));
      expect(await devices(storage, a.token)).toEqual(REVOKED);
      const again = value(await enrol(storage, T + 10, SECRET, SECRET, DEV_A, 'Mac Studio', '1.1.1.1'));
      expect(again.enrolled).toEqual({ spaceId: a.spaceId, deviceId: DEV_A, token: again.enrolled.token });
      expect(again.enrolled.token).not.toBe(a.token);
      expect(again.joins).toEqual(['docA0000000']);
      expect(await devices(storage, a.token)).toEqual(UNKNOWN);
      const listed = value(await devices(storage, again.enrolled.token)).devices;
      expect(listed.filter((d) => d.id === DEV_A)).toEqual([
        { id: DEV_A, name: 'Mac Studio', createdAt: T, lastSeenAt: T + 10, current: true },
      ]);
      expect(count(storage, 'devices')).toBe(2);
    });
  });

  it('refuses the 6th enrolment from one IP after 5 failures in 10 min', async () => {
    await inSpace('enrol-limit', async (storage) => {
      for (let i = 0; i < 5; i += 1) {
        expect(await enrol(storage, T, SECRET, 'wrong', DEV_A, 'Mac', '1.1.1.1')).toMatchObject({ ok: false, status: 401 });
      }
      expect(await enrol(storage, T, SECRET, SECRET, DEV_A, 'Mac', '1.1.1.1')).toEqual({
        ok: false,
        status: 429,
        error: 'rate_limited',
        message: 'Too many wrong setup secrets from this address.',
        retryAfter: 600,
      });
      expect(value(await enrol(storage, T, SECRET, SECRET, DEV_B, 'Mac', '2.2.2.2')).enrolled.deviceId).toBe(DEV_B);
      expect(await enrol(storage, T + 599_999, SECRET, SECRET, DEV_A, 'Mac', '1.1.1.1')).toMatchObject({
        ok: false,
        status: 429,
        retryAfter: 1,
      });
      expect(value(await enrol(storage, T + 600_000, SECRET, SECRET, DEV_A, 'Mac', '1.1.1.1')).enrolled.deviceId).toBe(DEV_A);
    });
  });

  it('old attempts are pruned', async () => {
    await inSpace('prune', async (storage) => {
      for (let i = 0; i < 5; i += 1) {
        await enrol(storage, T, SECRET, 'wrong', DEV_A, 'Mac', '1.1.1.1');
      }
      expect(count(storage, 'attempts')).toBe(5);
      await enrol(storage, T + 600_000, SECRET, 'wrong', DEV_A, 'Mac', '2.2.2.2');
      expect(count(storage, 'attempts')).toBe(1);
    });
  });

  it('makes pairing codes of the code alphabet that live 10 minutes', async () => {
    await inSpace('code-shape', async (storage) => {
      const { token } = await enrolled(storage, DEV_A);
      const made = value(await pairCode(storage, T, token));
      expect(made.code).toMatch(CODE);
      expect(made.expiresAt).toBe(T + 600_000);
    });
  });

  it('reads a pairing code typed loosely', async () => {
    expect(normalizeCode(' ab0o-1il L ')).toBe('AB001111');
    expect(normalizeCode('abcd efgh')).toBe('ABCDEFGH');
    await inSpace('code-loose', async (storage) => {
      const { token } = await enrolled(storage, DEV_A);
      const code = await liveCode(storage, token);
      const typed = code.toLowerCase().replace('-', ' ').replaceAll('0', 'o').replaceAll('1', 'l');
      expect(value(await claim(storage, T, typed, DEV_B, 'iPad', '1.1.1.1')).enrolled.deviceId).toBe(DEV_B);
    });
  });

  it('a pairing code claims once, until it expires', async () => {
    await inSpace('code-once', async (storage) => {
      const { spaceId, token } = await enrolled(storage, DEV_A);
      const code = await liveCode(storage, token);
      const claimed = value(await claim(storage, T + 599_999, code, DEV_B, 'iPad', '1.1.1.1'));
      expect(claimed.enrolled).toEqual({ spaceId, deviceId: DEV_B, token: claimed.enrolled.token });
      expect(claimed.joins).toEqual([]);
      expect(await claim(storage, T + 599_999, code, DEV_C, 'iPhone', '1.1.1.1')).toEqual(BAD_CODE);
      const late = await liveCode(storage, token);
      expect(await claim(storage, T + 600_000, late, DEV_C, 'iPhone', '1.1.1.1')).toEqual(BAD_CODE);
    });
  });

  it('refuses a 4th live pairing code in a space', async () => {
    await inSpace('code-limit', async (storage) => {
      const { token } = await enrolled(storage, DEV_A);
      const codes = [await liveCode(storage, token), await liveCode(storage, token), await liveCode(storage, token)];
      expect(await pairCode(storage, T, token)).toEqual({
        ok: false,
        status: 429,
        error: 'rate_limited',
        message: 'Three pairing codes are already live. Use one or wait until one expires.',
        retryAfter: 600,
      });
      value(await claim(storage, T, codes[1], DEV_B, 'iPad', '1.1.1.1'));
      expect(await pairCode(storage, T, token)).toMatchObject({ ok: true });
      expect(await pairCode(storage, T, token)).toMatchObject({ ok: false, status: 429 });
      expect(await pairCode(storage, T + 600_000, token)).toMatchObject({ ok: true });
    });
  });

  it('a right code joins from an address over its limit, a wrong one is refused there', async () => {
    await inSpace('claim-ip-limit', async (storage) => {
      const { token } = await enrolled(storage, DEV_A);
      const code = await liveCode(storage, token);
      for (let i = 0; i < 5; i += 1) {
        expect(await claim(storage, T, otherCode(code), DEV_B, 'iPad', '1.1.1.1')).toEqual(BAD_CODE);
      }
      expect(await claim(storage, T, otherCode(code), DEV_B, 'iPad', '1.1.1.1')).toEqual({
        ok: false,
        status: 429,
        error: 'rate_limited',
        message: 'Too many wrong pairing codes.',
        retryAfter: 600,
      });
      expect(value(await claim(storage, T, code, DEV_B, 'iPad', '1.1.1.1')).enrolled.deviceId).toBe(DEV_B);
      expect(await claim(storage, T, otherCode(code), DEV_C, 'iPhone', '2.2.2.2')).toEqual(BAD_CODE);
    });
  });

  it('a right code joins after 4 addresses sent 5 wrong codes each, and a wrong code is then rate limited', async () => {
    await inSpace('claim-space-limit', async (storage) => {
      const { token } = await enrolled(storage, DEV_A);
      const code = await liveCode(storage, token);
      for (const host of [1, 2, 3, 4]) {
        for (let i = 0; i < 5; i += 1) {
          expect(await claim(storage, T, otherCode(code), DEV_B, 'iPad', `10.0.0.${host}`)).toEqual(BAD_CODE);
        }
      }
      expect(await claim(storage, T, otherCode(code), DEV_C, 'iPhone', '10.0.0.5')).toEqual({
        ok: false,
        status: 429,
        error: 'rate_limited',
        message: 'Too many wrong pairing codes.',
        retryAfter: 600,
      });
      expect(value(await claim(storage, T, code, DEV_B, 'iPad', '10.0.0.6')).enrolled.deviceId).toBe(DEV_B);
      expect(await claim(storage, T + 599_999, otherCode(code), DEV_C, 'iPhone', '10.0.0.7')).toEqual({
        ok: false,
        status: 429,
        error: 'rate_limited',
        message: 'Too many wrong pairing codes.',
        retryAfter: 1,
      });
      const fresh = await liveCode(storage, token, T + 600_000);
      expect(await claim(storage, T + 600_000, otherCode(fresh), DEV_C, 'iPhone', '10.0.0.7')).toEqual(BAD_CODE);
      expect(value(await claim(storage, T + 600_000, fresh, DEV_C, 'iPhone', '10.0.0.7')).enrolled.deviceId).toBe(DEV_C);
    });
  });

  it('a wrong code is refused and counted against the address and the space', async () => {
    await inSpace('claim-counted', async (storage) => {
      const { token } = await enrolled(storage, DEV_A);
      const code = await liveCode(storage, token);
      expect(await claim(storage, T, otherCode(code), DEV_B, 'iPad', '1.1.1.1')).toEqual(BAD_CODE);
      expect(
        storage.sql
          .exec('SELECT scope FROM attempts ORDER BY scope')
          .toArray()
          .map((row) => text(row, 'scope')),
      ).toEqual(['claim', 'claim:1.1.1.1']);
      value(await claim(storage, T, code, DEV_B, 'iPad', '1.1.1.1'));
      expect(count(storage, 'attempts')).toBe(2);
    });
  });

  it('a code of a removed issuer is refused and counted, with clean counters', async () => {
    await inSpace('claim-revoked-counted', async (storage) => {
      const a = await enrolled(storage, DEV_A);
      const b = await enrolled(storage, DEV_B);
      const code = await liveCode(storage, a.token);
      storage.sql.exec('UPDATE devices SET revoked_at = ? WHERE id = ?', T, DEV_A);
      expect(count(storage, 'attempts')).toBe(0);
      expect(await claim(storage, T + 1, code, DEV_C, 'iPhone', '1.1.1.1')).toEqual(BAD_CODE);
      expect(count(storage, 'attempts')).toBe(2);
      expect(value(await devices(storage, b.token)).devices.map((d) => d.id)).toEqual([DEV_B]);
    });
  });

  it('a claim with a known device id re-admits it', async () => {
    await inSpace('readmit-claim', async (storage) => {
      const a = await enrolled(storage, DEV_A);
      const b = await enrolled(storage, DEV_B);
      value(await ticket(storage, T, a.token, 'docA0000000'));
      value(await ticket(storage, T, a.token, 'ix-' + a.spaceId));
      value(await removeDevice(storage, T, b.token, DEV_A));
      const code = await liveCode(storage, b.token);
      const again = value(await claim(storage, T + 1, code, DEV_A, 'iPad 2', '1.1.1.1'));
      expect(again.enrolled.deviceId).toBe(DEV_A);
      expect([...again.joins].sort()).toEqual(['docA0000000', 'ix-' + a.spaceId].sort());
      expect(await devices(storage, a.token)).toEqual(UNKNOWN);
      expect(value(await devices(storage, again.enrolled.token)).devices.map((d) => [d.id, d.name])).toEqual([
        [DEV_A, 'iPad 2'],
        [DEV_B, 'Device ' + DEV_B],
      ]);
    });
  });

  it('a pairing code records the device that made it', async () => {
    await inSpace('code-issuer', async (storage) => {
      const { token } = await enrolled(storage, DEV_A);
      const code = await liveCode(storage, token);
      const row = storage.sql.exec('SELECT issuer FROM codes WHERE hash = ?', await sha256Hex(code.replace('-', ''))).one();
      expect(text(row, 'issuer')).toBe(DEV_A);
    });
  });

  it('removing a device deletes the unused codes it made, and only those', async () => {
    await inSpace('remove-codes', async (storage) => {
      const a = await enrolled(storage, DEV_A);
      const b = await enrolled(storage, DEV_B);
      const used = await liveCode(storage, a.token);
      value(await claim(storage, T, used, DEV_C, 'iPhone', '1.1.1.1'));
      const stashed = await liveCode(storage, a.token);
      const kept = await liveCode(storage, b.token);
      value(await removeDevice(storage, T, b.token, DEV_A));
      expect(
        storage.sql
          .exec('SELECT issuer, used_at IS NOT NULL AS used FROM codes ORDER BY issuer')
          .toArray()
          .map((row) => [text(row, 'issuer'), int(row, 'used')]),
      ).toEqual([
        [DEV_A, 1],
        [DEV_B, 0],
      ]);
      expect(await claim(storage, T + 1, stashed, 'devD0000000', 'Laptop', '2.2.2.2')).toEqual(BAD_CODE);
      expect(await claim(storage, T + 1, stashed, DEV_A, 'Phone', '3.3.3.3')).toEqual(BAD_CODE);
      expect(await devices(storage, a.token)).toEqual(REVOKED);
      expect(value(await claim(storage, T + 1, kept, 'devD0000000', 'Laptop', '4.4.4.4')).enrolled.deviceId).toBe('devD0000000');
    });
  });

  it('a claim refuses a code whose issuer was removed', async () => {
    await inSpace('claim-revoked-issuer', async (storage) => {
      const a = await enrolled(storage, DEV_A);
      const code = await liveCode(storage, a.token);
      storage.sql.exec('UPDATE devices SET revoked_at = ? WHERE id = ?', T, DEV_A);
      expect(await claim(storage, T + 1, code, DEV_B, 'iPad', '1.1.1.1')).toEqual(BAD_CODE);
      expect(int(storage.sql.exec('SELECT used_at IS NULL AS unused FROM codes').one(), 'unused')).toBe(1);
    });
  });

  it('refuses a ticket for a 501st plan, and keeps the joined plans and the index open', async () => {
    await inSpace('join-cap', async (storage) => {
      const { spaceId, token } = await enrolled(storage, DEV_A);
      const plans = Array.from({ length: 500 }, (_, i) => 'p' + String(i).padStart(10, '0'));
      for (const doc of plans) {
        value(await ticket(storage, T, token, doc));
      }
      const tickets = count(storage, 'tickets');
      expect(await ticket(storage, T, token, 'pX000000000')).toEqual({
        ok: false,
        status: 409,
        error: 'too_many_plans',
        message: 'This device has joined 500 plans, the most one device may join.',
      });
      expect(count(storage, 'tickets')).toBe(tickets);
      expect(count(storage, 'joins')).toBe(500);
      expect(await ticket(storage, T, token, plans[0])).toMatchObject({ ok: true });
      expect(await ticket(storage, T, token, 'ix-' + spaceId)).toMatchObject({ ok: true });
      expect(count(storage, 'joins')).toBe(501);
      const other = await enrolled(storage, DEV_B);
      expect(await ticket(storage, T, other.token, 'pX000000000')).toMatchObject({ ok: true });
    });
  });

  it('a purge records the first purging device, drops the plan rows and is then erased once', async () => {
    await inSpace('purge-rows', async (storage) => {
      const a = await enrolled(storage, DEV_A);
      const b = await enrolled(storage, DEV_B);
      value(await ticket(storage, T, a.token, 'docA0000000'));
      value(await ticket(storage, T, a.token, 'docB0000000'));
      keepUntold(storage, T, DEV_A, ['docA0000000'], true);
      expect(await purgePlan(storage, T + 1, b.token, 'docA0000000')).toEqual({ ok: true, value: { device: DEV_B } });
      expect(await purgePlan(storage, T + 2, a.token, 'docA0000000')).toEqual({ ok: true, value: { device: DEV_A } });
      expect(count(storage, 'joins')).toBe(1);
      expect(count(storage, 'tickets')).toBe(1);
      expect(count(storage, 'untold')).toBe(0);
      expect(unerased(storage)).toEqual([{ doc: 'docA0000000', device: DEV_B }]);
      markErased(storage, T + 4, 'docA0000000');
      markErased(storage, T + 5, 'docA0000000');
      expect(unerased(storage)).toEqual([]);
      expect(int(storage.sql.exec("SELECT erased_at FROM purged WHERE doc = 'docA0000000'").one(), 'erased_at')).toBe(T + 4);
    });
  });

  it('a purge refuses unknown and removed devices and docs that are not plans', async () => {
    await inSpace('purge-refused', async (storage) => {
      const a = await enrolled(storage, DEV_A);
      const b = await enrolled(storage, DEV_B);
      const bad = { ok: false, status: 400, error: 'bad_request', message: 'The document id is not valid. Update WebBoard on this device.' };
      expect(await purgePlan(storage, T, a.token, 'ix-' + a.spaceId)).toEqual(bad);
      expect(await purgePlan(storage, T, a.token, '../x')).toEqual(bad);
      expect(await purgePlan(storage, T, 'nope', 'docA0000000')).toEqual(UNKNOWN);
      value(await removeDevice(storage, T, a.token, DEV_B));
      expect(await purgePlan(storage, T, b.token, 'docA0000000')).toEqual(REVOKED);
      expect(count(storage, 'purged')).toBe(0);
    });
  });

  it('a purge of a plan no device joined and nobody purged is 404 unknown_plan and stores nothing', async () => {
    await inSpace('purge-unknown', async (storage) => {
      const a = await enrolled(storage, DEV_A);
      const b = await enrolled(storage, DEV_B);
      value(await ticket(storage, T, a.token, 'docA0000000'));
      const unknown = {
        ok: false,
        status: 404,
        error: 'unknown_plan',
        message: 'The server does not know this plan yet. Let it sync, then delete it again.',
      };
      expect(await purgePlan(storage, T, a.token, 'docC0000000')).toEqual(unknown);
      expect(await purgePlan(storage, T, b.token, 'docC0000000')).toEqual(unknown);
      expect(count(storage, 'purged')).toBe(0);
      expect(count(storage, 'joins')).toBe(1);
      expect(await purgePlan(storage, T + 1, b.token, 'docA0000000')).toEqual({ ok: true, value: { device: DEV_B } });
      expect(await purgePlan(storage, T + 2, a.token, 'docA0000000')).toEqual({ ok: true, value: { device: DEV_A } });
      expect(unerased(storage)).toEqual([{ doc: 'docA0000000', device: DEV_B }]);
    });
  });

  it('a purged plan gets no ticket and its issued tickets are 410', async () => {
    await inSpace('purge-tickets', async (storage) => {
      const a = await enrolled(storage, DEV_A);
      const issued = value(await ticket(storage, T, a.token, 'docA0000000'));
      value(await purgePlan(storage, T, a.token, 'docA0000000'));
      const gone = { ok: false, status: 410, error: 'gone', message: 'This plan was deleted forever on another device.' };
      expect(await ticket(storage, T, a.token, 'docA0000000')).toEqual(gone);
      expect(await consumeTicket(storage, T, issued.ticket, 'docA0000000')).toEqual(gone);
      expect(await consumeTicket(storage, T, 'tik_unknown', 'docA0000000')).toEqual(gone);
      expect(count(storage, 'joins')).toBe(0);
      expect(await ticket(storage, T, a.token, 'ix-' + a.spaceId)).toMatchObject({ ok: true });
    });
  });

  it('a ticket is single use, lives 60 s and is bound to its doc', async () => {
    await inSpace('ticket-life', async (storage) => {
      const { token } = await enrolled(storage, DEV_A);
      const doc = 'docA0000000';
      const first = value(await ticket(storage, T, token, doc));
      expect(first.expiresAt).toBe(T + 60_000);
      const refused = await consumeTicket(storage, T, first.ticket, 'docB0000000');
      expect(refused).toMatchObject({ ok: false, status: 401, error: 'unauthorized' });
      expect(await consumeTicket(storage, T + 59_999, first.ticket, doc)).toEqual({ ok: true, value: { deviceId: DEV_A } });
      expect(await consumeTicket(storage, T + 59_999, first.ticket, doc)).toEqual(refused);
      const second = value(await ticket(storage, T, token, doc));
      expect(await consumeTicket(storage, T + 60_000, second.ticket, doc)).toEqual(refused);
      expect(await consumeTicket(storage, T, 'tik_unknown', doc)).toEqual(refused);
    });
  });

  it('refuses tickets for docs outside the space', async () => {
    await inSpace('ticket-docs', async (storage) => {
      const { spaceId, token } = await enrolled(storage, DEV_A);
      const bad = { ok: false, status: 400, error: 'bad_request', message: 'The document id is not valid. Update WebBoard on this device.' };
      expect(await ticket(storage, T, token, 'local')).toEqual(bad);
      expect(await ticket(storage, T, token, 'ix-other00000')).toEqual(bad);
      expect(await ticket(storage, T, token, '../x')).toEqual(bad);
      expect(await ticket(storage, T, token, 'ix-' + spaceId)).toMatchObject({ ok: true });
      expect(await ticket(storage, T, token, 'docA0000000')).toMatchObject({ ok: true });
      expect(count(storage, 'joins')).toBe(2);
    });
  });

  it('issuing a ticket records the join, the last seen time and drops tickets older than an hour', async () => {
    await inSpace('ticket-issue', async (storage) => {
      const { token } = await enrolled(storage, DEV_A);
      value(await ticket(storage, T, token, 'docA0000000'));
      value(await ticket(storage, T + 1_000, token, 'docA0000000'));
      expect(count(storage, 'joins')).toBe(1);
      expect(count(storage, 'tickets')).toBe(2);
      value(await ticket(storage, T + 3_599_999, token, 'docB0000000'));
      expect(count(storage, 'tickets')).toBe(3);
      value(await ticket(storage, T + 3_600_000, token, 'docB0000000'));
      expect(count(storage, 'tickets')).toBe(3);
      value(await ticket(storage, T + 3_601_000, token, 'docB0000000'));
      expect(count(storage, 'tickets')).toBe(3);
      expect(count(storage, 'joins')).toBe(2);
      expect(int(storage.sql.exec('SELECT last_seen_at FROM devices WHERE id = ?', DEV_A).one(), 'last_seen_at')).toBe(
        T + 3_601_000,
      );
    });
  });

  it('a ticket for a device with no row is a storage fault, not a 403', async () => {
    await inSpace('ticket-orphan', async (storage) => {
      const { token } = await enrolled(storage, DEV_A);
      const issued = value(await ticket(storage, T, token, 'docA0000000'));
      storage.sql.exec('DELETE FROM devices WHERE id = ?', DEV_A);
      await expect(consumeTicket(storage, T, issued.ticket, 'docA0000000')).rejects.toThrow(
        'Space: ticket for unknown device ' + DEV_A,
      );
    });
  });

  it('consuming a ticket of a removed device answers 403', async () => {
    await inSpace('ticket-revoked', async (storage) => {
      const a = await enrolled(storage, DEV_A);
      const b = await enrolled(storage, DEV_B);
      const issued = value(await ticket(storage, T, a.token, 'docA0000000'));
      value(await removeDevice(storage, T, b.token, DEV_A));
      expect(await consumeTicket(storage, T, issued.ticket, 'docA0000000')).toEqual(REVOKED);
    });
  });

  it('a removed device keeps its hash and answers 403 everywhere', async () => {
    await inSpace('revoked-token', async (storage) => {
      const a = await enrolled(storage, DEV_A);
      const b = await enrolled(storage, DEV_B);
      value(await ticket(storage, T, a.token, 'docA0000000'));
      expect(value(await removeDevice(storage, T, b.token, DEV_A))).toEqual({ joins: ['docA0000000'] });
      expect(text(storage.sql.exec('SELECT token_hash FROM devices WHERE id = ?', DEV_A).one(), 'token_hash')).toBe(
        await sha256Hex(a.token),
      );
      expect(await pairCode(storage, T, a.token)).toEqual(REVOKED);
      expect(await ticket(storage, T, a.token, 'docA0000000')).toEqual(REVOKED);
      expect(await devices(storage, a.token)).toEqual(REVOKED);
      expect(await removeDevice(storage, T, a.token, DEV_B)).toEqual(REVOKED);
    });
  });

  it('removing a removed device keeps the first removal time and fans out again', async () => {
    await inSpace('remove-twice', async (storage) => {
      const a = await enrolled(storage, DEV_A);
      const b = await enrolled(storage, DEV_B);
      value(await ticket(storage, T, a.token, 'docA0000000'));
      expect(value(await removeDevice(storage, T, b.token, DEV_A))).toEqual({ joins: ['docA0000000'] });
      expect(value(await removeDevice(storage, T + 5_000, b.token, DEV_A))).toEqual({ joins: ['docA0000000'] });
      expect(int(storage.sql.exec('SELECT revoked_at FROM devices WHERE id = ?', DEV_A).one(), 'revoked_at')).toBe(T);
    });
  });

  it('devices leaves out removed devices', async () => {
    await inSpace('device-list', async (storage) => {
      const a = await enrolled(storage, DEV_A);
      const b = await enrolled(storage, DEV_B);
      value(await removeDevice(storage, T, b.token, DEV_A));
      expect(value(await devices(storage, b.token)).devices.map((d) => d.id)).toEqual([DEV_B]);
      expect(a.spaceId).toBe(b.spaceId);
    });
  });

  it('refuses to remove the calling device or an unknown one', async () => {
    await inSpace('remove-refusals', async (storage) => {
      const a = await enrolled(storage, DEV_A);
      expect(await removeDevice(storage, T, a.token, DEV_A)).toEqual({
        ok: false,
        status: 400,
        error: 'bad_request',
        message: 'Remove this device from another device.',
      });
      expect(await removeDevice(storage, T, a.token, DEV_C)).toEqual({
        ok: false,
        status: 404,
        error: 'not_found',
        message: 'This device is not in the space.',
      });
      expect(value(await devices(storage, a.token)).devices.map((d) => d.id)).toEqual([DEV_A]);
    });
  });
});
