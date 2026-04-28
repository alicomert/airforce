import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { CircuitBreaker } from '../lib/circuit-breaker.js';

let breaker;

beforeEach(() => {
  breaker = new CircuitBreaker('test', { failThreshold: 3, openSeconds: 60, windowSeconds: 10 });
});

test('starts closed', () => {
  assert.equal(breaker.isOpen(), false);
  assert.equal(breaker.state, 'closed');
});

test('opens after fail threshold consecutive transient failures', () => {
  breaker.recordFailure();
  breaker.recordFailure();
  assert.equal(breaker.isOpen(), false);
  breaker.recordFailure();
  assert.equal(breaker.isOpen(), true);
  assert.equal(breaker.state, 'open');
});

test('successes within window reset failure count', () => {
  breaker.recordFailure();
  breaker.recordFailure();
  breaker.recordSuccess();
  breaker.recordFailure();
  breaker.recordFailure();
  assert.equal(breaker.isOpen(), false);
});

test('failures outside window do not accumulate', () => {
  const now = { t: 0 };
  const b = new CircuitBreaker('t2', {
    failThreshold: 3, openSeconds: 60, windowSeconds: 10,
    now: () => now.t,
  });
  b.recordFailure(); b.recordFailure();
  now.t = 11_000;
  b.recordFailure();
  assert.equal(b.isOpen(), false);
});

test('open transitions to half-open after openSeconds', () => {
  const now = { t: 0 };
  const b = new CircuitBreaker('t3', {
    failThreshold: 3, openSeconds: 60, windowSeconds: 10,
    now: () => now.t,
  });
  b.recordFailure(); b.recordFailure(); b.recordFailure();
  assert.equal(b.state, 'open');
  now.t = 60_001;
  assert.equal(b.isOpen(), false);
  assert.equal(b.state, 'half-open');
});

test('half-open success closes; failure reopens', () => {
  const now = { t: 0 };
  const b = new CircuitBreaker('t4', {
    failThreshold: 3, openSeconds: 60, windowSeconds: 10,
    now: () => now.t,
  });
  b.recordFailure(); b.recordFailure(); b.recordFailure();
  now.t = 60_001;
  void b.isOpen();
  assert.equal(b.state, 'half-open');
  b.recordSuccess();
  assert.equal(b.state, 'closed');

  b.recordFailure(); b.recordFailure(); b.recordFailure();
  now.t = 120_002;
  void b.isOpen();
  b.recordFailure();
  assert.equal(b.state, 'open');
});

test('tripUntil opens until given timestamp', () => {
  const now = { t: 0 };
  const b = new CircuitBreaker('t5', {
    failThreshold: 3, openSeconds: 60, windowSeconds: 10,
    now: () => now.t,
  });
  b.tripUntil(5_000_000, 'auth error');
  assert.equal(b.isOpen(), true);
  assert.equal(b.reason, 'auth error');
  now.t = 5_000_001;
  assert.equal(b.isOpen(), false);
});

test('reset() forces closed and clears counters', () => {
  breaker.recordFailure();
  breaker.recordFailure();
  breaker.recordFailure();
  assert.equal(breaker.state, 'open');
  breaker.reset();
  assert.equal(breaker.state, 'closed');
  assert.equal(breaker.isOpen(), false);
});
