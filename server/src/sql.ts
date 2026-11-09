export function blob(value: SqlStorageValue): Uint8Array {
  if (!(value instanceof ArrayBuffer)) {
    throw new Error(`Storage holds a ${typeof value} where a BLOB belongs`);
  }
  return new Uint8Array(value);
}

export function int(row: Record<string, SqlStorageValue>, column: string): number {
  const value = row[column];
  if (typeof value !== 'number') {
    throw new Error(`Storage holds a ${typeof value} in ${column} where a number belongs`);
  }
  return value;
}

export function text(row: Record<string, SqlStorageValue>, column: string): string {
  const value = row[column];
  if (typeof value !== 'string') {
    throw new Error(`Storage holds a ${typeof value} in ${column} where text belongs`);
  }
  return value;
}
