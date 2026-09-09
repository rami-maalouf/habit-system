import * as Crypto from 'expo-crypto';

import type { Hashing } from '@/core/domain/ports';
import type { DomainResult } from '@/core/domain/result';
import { ok } from '@/core/domain/result';
import { initializeProductDatabase } from '@/core/persistence/bootstrap';
import { createSampleRuntime } from '@/core/sample/generator';

import { openMemorySqlDatabase } from './memory';
import type { ProductCore } from './product-core';

const hashing: Hashing = {
  sha1: async (bytes) => new Uint8Array(await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA1, new Uint8Array(bytes))),
  sha256: async (bytes) => new Uint8Array(await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, new Uint8Array(bytes))),
};

export async function openSampleCore(): Promise<DomainResult<ProductCore>> {
  const runtime = createSampleRuntime();
  const db = await openMemorySqlDatabase();
  try {
    const initialized = await initializeProductDatabase(db, runtime.ids, hashing);
    const populated = initialized.ok ? await runtime.populate(db, hashing) : initialized;
    if (!populated.ok) {
      await db.closeAsync().catch(() => undefined);
      return populated;
    }
    return ok({ db, clock: runtime.clock, ids: runtime.ids, hashing });
  } catch (cause) {
    await db.closeAsync().catch(() => undefined);
    throw cause;
  }
}
