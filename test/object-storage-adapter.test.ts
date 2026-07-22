import { describe, expect, it } from 'vitest';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import {
  createObjectStorageAdapter,
  type ObjectStorageClient,
  type ObjectStorageLogEvent,
} from '../src/storage/object-storage-adapter.js';

const ENDPOINT = 'https://example.r2.cloudflarestorage.test';
const BUCKET = 'test-bucket';
const ACCESS_KEY_ID = 'test-access-key-id';
const SECRET_ACCESS_KEY = 'test-secret-access-key';

describe('createObjectStorageAdapter', () => {
  it('sends PutObjectCommand with key, body, and contentType', async () => {
    const calls: PutObjectCommand[] = [];
    const client: ObjectStorageClient = {
      send: (command) => {
        calls.push(command);
        return Promise.resolve({});
      },
    };
    const adapter = createObjectStorageAdapter({
      endpoint: ENDPOINT,
      bucket: BUCKET,
      accessKeyId: ACCESS_KEY_ID,
      secretAccessKey: SECRET_ACCESS_KEY,
      client,
    });

    const body = Buffer.from('hello');
    const result = await adapter.putObject({
      key: 'signals/demo.jpg',
      body,
      contentType: 'image/jpeg',
    });

    expect(result).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    const command = calls[0];
    expect(command).toBeInstanceOf(PutObjectCommand);
    expect(command?.input).toMatchObject({
      Bucket: BUCKET,
      Key: 'signals/demo.jpg',
      Body: body,
      ContentType: 'image/jpeg',
    });
  });

  it('returns typed failure and logs when client.send rejects', async () => {
    const events: ObjectStorageLogEvent[] = [];
    const client: ObjectStorageClient = {
      send: () => Promise.reject(new Error('network')),
    };
    const adapter = createObjectStorageAdapter({
      endpoint: ENDPOINT,
      bucket: BUCKET,
      accessKeyId: ACCESS_KEY_ID,
      secretAccessKey: SECRET_ACCESS_KEY,
      client,
      log: (event) => {
        events.push(event);
      },
    });

    const result = await adapter.putObject({
      key: 'signals/fail.jpg',
      body: Buffer.from('x'),
      contentType: 'image/jpeg',
    });

    expect(result).toEqual({ ok: false, reason: 'sdk_error' });
    expect(events).toEqual([
      {
        event: 'object_storage_put_failed',
        reason: 'sdk_error',
        key: 'signals/fail.jpg',
        errorName: 'Error',
      },
    ]);
  });
});
