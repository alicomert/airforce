import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProviderError, classifyError } from '../../lib/providers/base.js';

test('ProviderError stores status, body, category', () => {
  const err = new ProviderError('boom', { status: 500, body: 'srv', category: 'transient' });
  assert.equal(err.message, 'boom');
  assert.equal(err.status, 500);
  assert.equal(err.body, 'srv');
  assert.equal(err.category, 'transient');
  assert.equal(err.name, 'ProviderError');
});

test('classifyError: 5xx and 408/425/429 are transient', () => {
  for (const s of [408, 425, 429, 500, 502, 503, 504]) {
    assert.equal(classifyError(s, ''), 'transient', `status ${s}`);
  }
});

test('classifyError: 401/403 are auth', () => {
  assert.equal(classifyError(401, ''), 'auth');
  assert.equal(classifyError(403, ''), 'auth');
});

test('classifyError: 404 is bad_model', () => {
  assert.equal(classifyError(404, ''), 'bad_model');
});

test('classifyError: 400 with model_not_found is bad_model', () => {
  assert.equal(classifyError(400, '{"error":{"code":"model_not_found"}}'), 'bad_model');
  assert.equal(classifyError(400, 'unknown model "foo"'), 'bad_model');
});

test('classifyError: other 4xx is client', () => {
  assert.equal(classifyError(400, '{"error":{"message":"bad messages"}}'), 'client');
  assert.equal(classifyError(422, ''), 'client');
});

test('classifyError: 2xx is ok', () => {
  assert.equal(classifyError(200, ''), 'ok');
  assert.equal(classifyError(201, ''), 'ok');
});

test('classifyError: network errors (status=0) are transient', () => {
  assert.equal(classifyError(0, ''), 'transient');
});
