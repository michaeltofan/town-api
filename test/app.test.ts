import { describe, expect, it } from 'vitest';
import { createFakeDatabase } from './helpers/database.js';
import { createTestApp } from './helpers/app.js';

describe('app lifecycle', () => {
  it('creates and closes the app cleanly with injected database', async () => {
    const database = createFakeDatabase({ ready: true });
    const app = await createTestApp({ database });

    const live = await app.inject({ method: 'GET', url: '/health/live' });
    const ready = await app.inject({ method: 'GET', url: '/health/ready' });

    expect(live.statusCode).toBe(200);
    expect(ready.statusCode).toBe(200);

    await expect(app.close()).resolves.toBeUndefined();
    expect(database.closed).toBe(true);
  });
});
