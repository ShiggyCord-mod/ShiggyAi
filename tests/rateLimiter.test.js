import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RateLimiter } from '../src/rateLimiter.js';

test('remaining() startet bei maxPerMinute', () => {
  const limiter = new RateLimiter(3);
  assert.equal(limiter.remaining(), 3);
});

test('acquire() reduziert remaining() bis das Limit erreicht ist', async () => {
  const limiter = new RateLimiter(2);
  await limiter.acquire();
  assert.equal(limiter.remaining(), 1);
  await limiter.acquire();
  assert.equal(limiter.remaining(), 0);
});

test('remaining() erholt sich, sobald alte Timestamps aus dem 60s-Fenster fallen', () => {
  const limiter = new RateLimiter(1);
  limiter.timestamps.push(Date.now() - 61_000);
  assert.equal(limiter.remaining(), 1);
});

test('acquire() wartet, bis wieder ein Slot frei ist', async () => {
  const limiter = new RateLimiter(1);
  limiter.timestamps.push(Date.now() - 59_900);

  const start = Date.now();
  await limiter.acquire();
  const elapsed = Date.now() - start;

  assert.ok(elapsed >= 90, `sollte auf freien Slot warten, hat aber nur ${elapsed}ms gewartet`);
});
