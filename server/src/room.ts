import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import type { Connection, ConnectionContext, WSMessage } from 'partyserver';
import { YServer } from 'y-partyserver';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';
import { CHUNK_BYTES, COMPACT_DELAY_MS, DEVICE_HEADER, MAX_MESSAGE_BYTES } from './limits';
import { blob, int } from './sql';

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;
const DEVICE_ID = /^[A-Za-z0-9_-]{11}$/;

type Frame =
  | { kind: 'step1'; decoder: decoding.Decoder }
  | { kind: 'step2'; update: Uint8Array }
  | { kind: 'update'; update: Uint8Array }
  | { kind: 'awareness' }
  | { kind: 'unknown' };

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  parts.reduce((offset, part) => {
    out.set(part, offset);
    return offset + part.length;
  }, 0);
  return out;
}

function chunks(bytes: Uint8Array): ArrayBuffer[] {
  return Array.from({ length: Math.max(1, Math.ceil(bytes.length / CHUNK_BYTES)) }, (_, i) => {
    const slice = bytes.subarray(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES);
    const part = new Uint8Array(slice.length);
    part.set(slice);
    return part.buffer;
  });
}

function bytesOf(message: ArrayBuffer | ArrayBufferView): Uint8Array {
  return message instanceof ArrayBuffer
    ? new Uint8Array(message)
    : new Uint8Array(message.buffer, message.byteOffset, message.byteLength);
}

function deviceOf(request: Request): string {
  const device = request.headers.get(DEVICE_HEADER);
  if (device === null || !DEVICE_ID.test(device)) {
    throw new Error(`The ${DEVICE_HEADER} header is missing or not a device id`);
  }
  return device;
}

function closedSocket(code: number, reason: string): Response {
  const pair = new WebSocketPair();
  pair[1].accept();
  pair[1].close(code, reason);
  return new Response(null, { status: 101, webSocket: pair[0] });
}

function isEmptyUpdate(update: Uint8Array): boolean {
  return update.length === 2 && update[0] === 0 && update[1] === 0;
}

function readFrame(bytes: Uint8Array): Frame {
  const decoder = decoding.createDecoder(bytes);
  const type = decoding.readVarUint(decoder);
  if (type === MESSAGE_AWARENESS) {
    decoding.readVarUint8Array(decoder);
    return { kind: 'awareness' };
  }
  if (type !== MESSAGE_SYNC) {
    return { kind: 'unknown' };
  }
  const subtype = decoding.readVarUint(decoder);
  if (subtype === syncProtocol.messageYjsSyncStep1) {
    return { kind: 'step1', decoder };
  }
  if (subtype === syncProtocol.messageYjsSyncStep2) {
    return { kind: 'step2', update: decoding.readVarUint8Array(decoder) };
  }
  if (subtype === syncProtocol.messageYjsUpdate) {
    return { kind: 'update', update: decoding.readVarUint8Array(decoder) };
  }
  return { kind: 'unknown' };
}

export class Room extends YServer {
  static options = { hibernate: true };

  stateBytes = 0;

  private loaded = false;

  private tombstone: 'unread' | 'none' | 'erasing' | 'stored' = 'unread';

  private hasTombstone(): boolean {
    const sql = this.ctx.storage.sql;
    if (sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'gone'").toArray().length === 0) {
      return false;
    }
    return sql.exec('SELECT 1 FROM gone LIMIT 1').toArray().length > 0;
  }

  private isGone(): boolean {
    if (this.tombstone === 'unread') {
      this.tombstone = this.hasTombstone() ? 'stored' : 'none';
    }
    return this.tombstone !== 'none';
  }

  private tables(): void {
    const sql = this.ctx.storage.sql;
    sql.exec('CREATE TABLE IF NOT EXISTS snapshot (part INTEGER PRIMARY KEY, data BLOB NOT NULL)');
    sql.exec(
      'CREATE TABLE IF NOT EXISTS updates (id INTEGER NOT NULL, part INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (id, part))',
    );
    sql.exec('CREATE TABLE IF NOT EXISTS revoked (device TEXT PRIMARY KEY)');
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return super.fetch(request);
    }
    try {
      if (this.isGone()) {
        return closedSocket(4410, 'Plan deleted');
      }
      deviceOf(request);
      this.load();
    } catch (error) {
      console.error(`Room ${this.name} failed while opening a connection:`, error);
      return closedSocket(4500, 'Server error');
    }
    return super.fetch(request);
  }

  private load(): void {
    if (this.loaded || this.isGone()) {
      return;
    }
    this.tables();
    const sql = this.ctx.storage.sql;
    const snapshot = concat(sql.exec('SELECT data FROM snapshot ORDER BY part').toArray().map((row) => blob(row.data)));
    const rows = sql.exec('SELECT id, data FROM updates ORDER BY id, part').toArray();
    const updates = [...Map.groupBy(rows, (row) => int(row, 'id')).values()].map((parts) =>
      concat(parts.map((row) => blob(row.data))),
    );
    if (snapshot.length > 0) {
      Y.applyUpdate(this.document, snapshot);
    }
    updates.forEach((update) => Y.applyUpdate(this.document, update));
    this.stateBytes = updates.reduce((sum, update) => sum + update.length, snapshot.length);
    this.loaded = true;
  }

  async onLoad(): Promise<undefined> {
    this.load();
    return undefined;
  }

  async onMessage(conn: Connection, message: WSMessage): Promise<void> {
    try {
      await this.receive(conn, message);
    } catch (error) {
      console.error(`Room ${this.name} failed while handling a message:`, error);
      try {
        conn.close(4500, 'Server error');
      } catch (closing) {
        console.error(`Room ${this.name} could not close the socket after that failure:`, closing);
      }
    }
  }

  private async receive(conn: Connection, message: WSMessage): Promise<void> {
    if (conn.readyState !== WebSocket.READY_STATE_OPEN) {
      return;
    }
    if (this.isGone()) {
      conn.close(4410, 'Plan deleted');
      return;
    }
    if (typeof message === 'string') {
      conn.close(1007, 'Malformed message');
      return;
    }
    const bytes = bytesOf(message);
    if (bytes.length > MAX_MESSAGE_BYTES) {
      conn.close(4413, 'Message too large');
      return;
    }
    let frame: Frame;
    try {
      frame = readFrame(bytes);
    } catch (error) {
      console.error(`Room ${this.name} refused a malformed message:`, error);
      conn.close(1007, 'Malformed message');
      return;
    }
    if (frame.kind === 'unknown') {
      conn.close(1007, 'Malformed message');
      return;
    }
    if (frame.kind === 'awareness') {
      this.handleMessage(conn, message);
      return;
    }
    if (frame.kind === 'step1') {
      this.answerStep1(conn, frame.decoder);
      return;
    }
    if (!isEmptyUpdate(frame.update)) {
      await this.store(conn, frame);
    }
  }

  private answerStep1(conn: Connection, decoder: decoding.Decoder): void {
    const reply = encoding.createEncoder();
    encoding.writeVarUint(reply, MESSAGE_SYNC);
    try {
      syncProtocol.readSyncStep1(decoder, reply, this.document);
    } catch (error) {
      console.error(`Room ${this.name} refused a malformed sync step 1:`, error);
      conn.close(1007, 'Malformed message');
      return;
    }
    conn.send(encoding.toUint8Array(reply));
  }

  private async store(conn: Connection, frame: { kind: 'step2' | 'update'; update: Uint8Array }): Promise<void> {
    const update = frame.update;
    try {
      Y.decodeUpdate(update);
    } catch (error) {
      console.error(`Room ${this.name} refused a malformed update:`, error);
      conn.close(1007, 'Malformed update');
      return;
    }
    if (frame.kind === 'step2' && Y.snapshotContainsUpdate(Y.snapshot(this.document), update)) {
      return;
    }
    let id: number;
    try {
      id = this.append(update);
    } catch (error) {
      console.error(`Room ${this.name} could not store an update:`, error);
      conn.close(4500, 'Server could not store the update');
      return;
    }
    try {
      Y.applyUpdate(this.document, update, conn);
    } catch (error) {
      this.ctx.storage.transactionSync(() => {
        this.ctx.storage.sql.exec('DELETE FROM updates WHERE id = ?', id);
      });
      console.error(`Room ${this.name} could not apply update ${id} and dropped it:`, error);
      conn.close(1007, 'Malformed update');
      return;
    }
    this.stateBytes += update.length;
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + COMPACT_DELAY_MS);
    }
  }

  private append(update: Uint8Array): number {
    const sql = this.ctx.storage.sql;
    return this.ctx.storage.transactionSync(() => {
      const id = int(sql.exec('SELECT COALESCE(MAX(id), 0) + 1 AS next FROM updates').one(), 'next');
      chunks(update).forEach((data, part) => sql.exec('INSERT INTO updates (id, part, data) VALUES (?, ?, ?)', id, part, data));
      return id;
    });
  }

  getConnectionTags(_conn: Connection, ctx: ConnectionContext): string[] {
    return ['d:' + deviceOf(ctx.request)];
  }

  onConnect(conn: Connection, ctx: ConnectionContext): void {
    try {
      this.admit(conn, ctx);
    } catch (error) {
      console.error(`Room ${this.name} failed while opening a connection:`, error);
      try {
        conn.close(4500, 'Server error');
      } catch (closing) {
        console.error(`Room ${this.name} could not close the socket after that failure:`, closing);
      }
    }
  }

  private admit(conn: Connection, ctx: ConnectionContext): void {
    if (this.isGone()) {
      conn.close(4410, 'Plan deleted');
      return;
    }
    const device = ctx.request.headers.get(DEVICE_HEADER);
    const revoked = this.ctx.storage.sql.exec('SELECT 1 FROM revoked WHERE device = ?', device).toArray().length > 0;
    if (revoked) {
      conn.close(4403, 'Device removed');
      return;
    }
    if (this.stateBytes > MAX_MESSAGE_BYTES) {
      this.compact();
    }
    if (this.stateBytes > MAX_MESSAGE_BYTES) {
      conn.close(4413, 'Too large to sync');
      return;
    }
    super.onConnect(conn, ctx);
  }

  onAlarm(): void {
    if (this.isGone()) {
      return;
    }
    this.compact();
  }

  private compact(): void {
    const sql = this.ctx.storage.sql;
    const compacted = this.ctx.storage.transactionSync(() => {
      const maxId = int(sql.exec('SELECT COALESCE(MAX(id), 0) AS maxId FROM updates').one(), 'maxId');
      const encoded = Y.encodeStateAsUpdate(this.document);
      sql.exec('DELETE FROM snapshot');
      chunks(encoded).forEach((data, part) => sql.exec('INSERT INTO snapshot (part, data) VALUES (?, ?)', part, data));
      sql.exec('DELETE FROM updates WHERE id <= ?', maxId);
      return encoded.length;
    });
    this.stateBytes = compacted;
  }

  async closeDevice(deviceId: string): Promise<number> {
    if (this.isGone()) {
      return 0;
    }
    this.tables();
    this.ctx.storage.sql.exec('INSERT INTO revoked (device) VALUES (?) ON CONFLICT (device) DO NOTHING', deviceId);
    const open = [...this.getConnections('d:' + deviceId)];
    open.forEach((conn) => conn.close(4403, 'Device removed'));
    return open.length;
  }

  async restoreDevice(deviceId: string): Promise<void> {
    if (this.isGone()) {
      return;
    }
    this.tables();
    this.ctx.storage.sql.exec('DELETE FROM revoked WHERE device = ?', deviceId);
  }

  async purge(): Promise<number> {
    const open = [...this.getConnections()];
    this.isGone();
    if (this.tombstone === 'stored') {
      open.forEach((conn) => conn.close(4410, 'Plan deleted'));
      return open.length;
    }
    this.tombstone = 'erasing';
    open.forEach((conn) => conn.close(4410, 'Plan deleted'));
    await this.ctx.storage.deleteAll();
    this.ctx.storage.sql.exec('CREATE TABLE gone (at INTEGER NOT NULL)');
    this.ctx.storage.sql.exec('INSERT INTO gone (at) VALUES (?)', Date.now());
    this.tombstone = 'stored';
    return open.length;
  }
}
