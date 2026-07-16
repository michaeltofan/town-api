import { describe, expect, it } from 'vitest';
import { createTestApp } from './helpers/app.js';

describe('app lifecycle', () => {
  it('creates and closes the app cleanly', async () => {
    const app = await createTestApp();

    const live = await app.inject({ method: 'GET', url: '/health/live' });
    const ready = await app.inject({ method: 'GET', url: '/health/ready' });

    expect(live.statusCode).toBe(200);
    expect(ready.statusCode).toBe(200);

    await expect(app.close()).resolves.toBeUndefined();
  });
});
