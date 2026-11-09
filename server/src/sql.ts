export function blob(value: SqlStorageValue): Uint8Array {
  if (!(value instanceof ArrayBuffer)) {
    throw new Error(`Room storage holds a ${typeof value} where a BLOB belongs`);
  }
  return new Uint8Array(value);
}

export function int(row: Record<string, SqlStorageValue>, column: string): number {
  const value = row[column];
  if (typeof value !== 'number') {
    throw new Error(`Room storage holds a ${typeof value} in ${column} where a number belongs`);
  }
  return value;
}
