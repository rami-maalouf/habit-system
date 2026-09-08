import type { Hashing } from './ports';

export const HABIT_SYSTEM_NAMESPACE = '4d96f757-73e0-561c-99b9-16b7ef2d1903';

export async function uuidV5(name: string, hashing: Pick<Hashing, 'sha1'>): Promise<string> {
  const namespace = HABIT_SYSTEM_NAMESPACE.replaceAll('-', '');
  const prefix = Uint8Array.from({ length: 16 }, (_, index) =>
    parseInt(namespace.slice(index * 2, index * 2 + 2), 16),
  );
  const suffix = new TextEncoder().encode(name);
  const input = new Uint8Array(prefix.length + suffix.length);
  input.set(prefix);
  input.set(suffix, prefix.length);
  const hash = await hashing.sha1(input);
  if (hash.length !== 20) throw new Error('SHA-1 must return 20 bytes.');
  const bytes = hash.slice(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
