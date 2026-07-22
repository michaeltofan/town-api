import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

/**
 * Bounded object-storage adapter surface. Only the calls required by the
 * current slice are exposed; the concrete client owns all SDK details.
 */
export type TownObjectStorageAdapter = {
  putObject: (input: {
    key: string;
    body: Uint8Array | Buffer | string;
    contentType: string;
  }) => Promise<ObjectStoragePutResult>;
};

export type ObjectStoragePutResult =
  | { ok: true }
  | { ok: false; reason: 'sdk_error' };

export type ObjectStorageLogEvent = {
  event: 'object_storage_put_failed';
  reason: 'sdk_error';
  key?: string;
  errorName: string;
  errorCode?: string;
};

/** Minimal client surface for production S3Client and test doubles. */
export type ObjectStorageClient = {
  send: (command: PutObjectCommand) => Promise<unknown>;
};

export type CreateObjectStorageAdapterOptions = {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Injected solely for tests; when absent a real S3Client is constructed. */
  client?: ObjectStorageClient;
  log?: (event: ObjectStorageLogEvent) => void;
};

/**
 * S3-compatible object-storage adapter (Cloudflare R2 via S3 API).
 * Exposes putObject only; never retries.
 */
export function createObjectStorageAdapter(
  options: CreateObjectStorageAdapterOptions,
): TownObjectStorageAdapter {
  const { endpoint, bucket, accessKeyId, secretAccessKey, log } = options;
  const client: ObjectStorageClient =
    options.client ??
    new S3Client({
      region: 'auto',
      endpoint,
      credentials: {
        accessKeyId,
        secretAccessKey,
      },
    });

  return {
    async putObject(input): Promise<ObjectStoragePutResult> {
      try {
        await client.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: input.key,
            Body: input.body,
            ContentType: input.contentType,
          }),
        );
        return { ok: true };
      } catch (error) {
        log?.({
          event: 'object_storage_put_failed',
          reason: 'sdk_error',
          key: input.key,
          errorName: error instanceof Error ? error.name : 'UnknownError',
          ...(typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          typeof error.code === 'string'
            ? { errorCode: error.code }
            : {}),
        });
        return { ok: false, reason: 'sdk_error' };
      }
    },
  };
}
