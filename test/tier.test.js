import { test } from 'node:test';
import assert from 'node:assert/strict';

import { classifyTier, tierAllowed, tierPriority } from '../lib/tier.js';

test('multiplier 1 ve altı → free', () => {
  assert.equal(classifyTier(0), 'free');
  assert.equal(classifyTier(1), 'free');
  assert.equal(classifyTier(null), 'free');
  assert.equal(classifyTier(undefined), 'free');
});

test('multiplier 2..10 → premium', () => {
  assert.equal(classifyTier(2), 'premium');
  assert.equal(classifyTier(5), 'premium');
  assert.equal(classifyTier(10), 'premium');
});

test('multiplier > 10 → p2g', () => {
  assert.equal(classifyTier(11), 'p2g');
  assert.equal(classifyTier(100), 'p2g');
});

test('tierAllowed: free probe sadece free dahil', () => {
  assert.equal(tierAllowed('free', 'free'), true);
  assert.equal(tierAllowed('premium', 'free'), false);
  assert.equal(tierAllowed('p2g', 'free'), false);
});

test('tierAllowed: premium probe free + premium', () => {
  assert.equal(tierAllowed('free', 'premium'), true);
  assert.equal(tierAllowed('premium', 'premium'), true);
  assert.equal(tierAllowed('p2g', 'premium'), false);
});

test('tierAllowed: all probe her şey', () => {
  assert.equal(tierAllowed('free', 'all'), true);
  assert.equal(tierAllowed('premium', 'all'), true);
  assert.equal(tierAllowed('p2g', 'all'), true);
});

test('tierPriority: free < premium < p2g', () => {
  assert.ok(tierPriority('free') < tierPriority('premium'));
  assert.ok(tierPriority('premium') < tierPriority('p2g'));
});
