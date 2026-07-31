import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

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
  getObject: (input: { key: string }) => Promise<ObjectStorageGetResult>;
};

export type ObjectStoragePutResult = { ok: true } | { ok: false; reason: 'sdk_error' };

export type ObjectStorageGetResult =
  | {
      ok: true;
      body: Buffer;
      contentType: string | undefined;
    }
  | { ok: false; reason: 'not_found' | 'sdk_error' };

export type ObjectStorageLogEvent = {
  event: 'object_storage_put_failed' | 'object_storage_get_failed';
  reason: 'sdk_error' | 'not_found';
  key?: string;
  errorName: string;
  errorCode?: string;
};

/** Minimal client surface for production S3Client and test doubles. */
export type ObjectStorageClient = {
  send: (command: PutObjectCommand | GetObjectCommand) => Promise<unknown>;
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

function errorCodeOf(error: unknown): string | undefined {
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
  ) {
    return error.code;
  }
  return undefined;
}

function errorNameOf(error: unknown): string {
  if (error instanceof Error && error.name.length > 0) {
    return error.name;
  }
  if (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    typeof error.name === 'string' &&
    error.name.length > 0
  ) {
    return error.name;
  }
  return 'UnknownError';
}

async function bodyToBuffer(body: unknown): Promise<Buffer> {
  if (body == null) {
    return Buffer.alloc(0);
  }
  if (Buffer.isBuffer(body)) {
    return body;
  }
  if (body instanceof Uint8Array) {
    return Buffer.from(body);
  }
  if (typeof body === 'string') {
    return Buffer.from(body);
  }
  if (typeof body === 'object' && 'transformToByteArray' in body) {
    const transformable = body as { transformToByteArray: () => Promise<Uint8Array> };
    const bytes = await transformable.transformToByteArray();
    return Buffer.from(bytes);
  }
  throw new Error('Unsupported object storage body type');
}

/**
 * S3-compatible object-storage adapter (Cloudflare R2 via S3 API).
 * Exposes putObject and getObject; never retries.
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
        const errorCode = errorCodeOf(error);
        log?.({
          event: 'object_storage_put_failed',
          reason: 'sdk_error',
          key: input.key,
          errorName: errorNameOf(error),
          ...(errorCode !== undefined ? { errorCode } : {}),
        });
        return { ok: false, reason: 'sdk_error' };
      }
    },

    async getObject(input): Promise<ObjectStorageGetResult> {
      try {
        const response = (await client.send(
          new GetObjectCommand({
            Bucket: bucket,
            Key: input.key,
          }),
        )) as {
          Body?: unknown;
          ContentType?: string;
        };
        const body = await bodyToBuffer(response.Body);
        return {
          ok: true,
          body,
          contentType: response.ContentType,
        };
      } catch (error) {
        const errorCode = errorCodeOf(error);
        const errorName = errorNameOf(error);
        const notFound =
          errorCode === 'NoSuchKey' ||
          errorCode === 'NotFound' ||
          errorCode === '404' ||
          errorName === 'NoSuchKey' ||
          errorName === 'NotFound' ||
          (error instanceof Error && /not\s*found|nosuchkey/i.test(error.message));
        log?.({
          event: 'object_storage_get_failed',
          reason: notFound ? 'not_found' : 'sdk_error',
          key: input.key,
          errorName,
          ...(errorCode !== undefined ? { errorCode } : {}),
        });
        return { ok: false, reason: notFound ? 'not_found' : 'sdk_error' };
      }
    },
  };
}

/**
 * In-memory adapter for tests. Not for production use.
 */
export function createInMemoryObjectStorageAdapter(): TownObjectStorageAdapter & {
  objects: Map<string, { body: Buffer; contentType: string }>;
} {
  const objects = new Map<string, { body: Buffer; contentType: string }>();
  return {
    objects,
    async putObject(input) {
      const body = Buffer.isBuffer(input.body)
        ? input.body
        : typeof input.body === 'string'
          ? Buffer.from(input.body)
          : Buffer.from(input.body);
      objects.set(input.key, { body, contentType: input.contentType });
      return { ok: true };
    },
    async getObject(input) {
      const found = objects.get(input.key);
      if (!found) {
        return { ok: false, reason: 'not_found' };
      }
      return { ok: true, body: found.body, contentType: found.contentType };
    },
  };
}
