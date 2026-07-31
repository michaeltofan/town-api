import type { Env } from '../config/env.js';
import {
  createObjectStorageAdapter,
  type TownObjectStorageAdapter,
} from './object-storage-adapter.js';

/**
 * Creates a private object-storage adapter when OBJECT_STORAGE_ENABLED is true.
 * Returns null when storage is disabled (media upload routes should fail honestly).
 */
export function createObjectStorageAdapterFromEnv(env: Env): TownObjectStorageAdapter | null {
  if (!env.OBJECT_STORAGE_ENABLED) {
    return null;
  }

  const endpoint = env.OBJECT_STORAGE_ENDPOINT;
  const bucket = env.OBJECT_STORAGE_BUCKET;
  const accessKeyId = env.OBJECT_STORAGE_ACCESS_KEY_ID;
  const secretAccessKey = env.OBJECT_STORAGE_SECRET_ACCESS_KEY;

  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) {
    throw new Error(
      'OBJECT_STORAGE_ENABLED is true but required OBJECT_STORAGE_* credentials are missing',
    );
  }

  return createObjectStorageAdapter({
    endpoint,
    bucket,
    accessKeyId,
    secretAccessKey,
  });
}
