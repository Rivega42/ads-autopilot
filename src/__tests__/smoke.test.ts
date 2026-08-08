import { describe, expect, it } from 'vitest';

import { buildApp } from '../server.js';

describe('smoke', () => {
  it('GET /health returns ok', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('ok');
    expect(typeof body.ts).toBe('string');
    expect(typeof body.version).toBe('string');
    await app.close();
  });

  it('x-request-id header is echoed back', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { 'x-request-id': 'test-req-123' },
    });
    expect(res.headers['x-request-id']).toBe('test-req-123');
    await app.close();
  });

  it('generates x-request-id when absent', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    await app.close();
  });
});
