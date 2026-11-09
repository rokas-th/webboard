import { randomBase64url, type Result } from '../src/auth';

export function value<V>(result: Result<V>): V {
  if (!result.ok) {
    throw new Error(`Expected ok, got ${result.status} ${result.error}: ${result.message}`);
  }
  return result.value;
}

export function newDoc(): string {
  return randomBase64url(8);
}
