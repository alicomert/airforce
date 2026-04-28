import { test } from 'node:test';
import assert from 'node:assert/strict';

import { extractToolCalls } from '../lib/tool-engine/parse.js';

test('canonical: simple tool call parsed', () => {
  const text = `Bir saniye, hava durumunu çekiyorum.

<tool_calls>
  <invoke name="get_weather">
    <parameter name="city">Istanbul</parameter>
    <parameter name="unit">c</parameter>
  </invoke>
</tool_calls>`;
  const r = extractToolCalls(text);
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0].name, 'get_weather');
  assert.deepEqual(r.calls[0].args, { city: 'Istanbul', unit: 'c' });
  assert.equal(r.textWithoutBlocks, 'Bir saniye, hava durumunu çekiyorum.');
});

test('canonical: multiple invokes within one block', () => {
  const text = `<tool_calls>
  <invoke name="read_file"><parameter name="path">a.txt</parameter></invoke>
  <invoke name="read_file"><parameter name="path">b.txt</parameter></invoke>
</tool_calls>`;
  const r = extractToolCalls(text);
  assert.equal(r.calls.length, 2);
  assert.equal(r.calls[0].args.path, 'a.txt');
  assert.equal(r.calls[1].args.path, 'b.txt');
});

test('JSON-typed parameter is parsed as object', () => {
  const text = `<tool_calls><invoke name="search">
  <parameter name="filter">{"status":"open","limit":10}</parameter>
</invoke></tool_calls>`;
  const r = extractToolCalls(text);
  assert.equal(r.calls.length, 1);
  assert.deepEqual(r.calls[0].args.filter, { status: 'open', limit: 10 });
});

test('numbers and booleans are coerced', () => {
  const text = `<tool_calls><invoke name="x">
  <parameter name="n">42</parameter>
  <parameter name="ok">true</parameter>
  <parameter name="off">false</parameter>
</invoke></tool_calls>`;
  const r = extractToolCalls(text);
  assert.deepEqual(r.calls[0].args, { n: 42, ok: true, off: false });
});

test('anti-leak: tool_calls inside fenced code block is ignored', () => {
  const text = `\`\`\`xml
<tool_calls>
  <invoke name="should_not_call">
    <parameter name="x">1</parameter>
  </invoke>
</tool_calls>
\`\`\`

Bu sadece bir örnek.`;
  const r = extractToolCalls(text);
  assert.equal(r.calls.length, 0);
});

test('anti-leak: outside fenced block still parsed', () => {
  const text = `\`\`\`xml
<tool_calls><invoke name="example"><parameter name="a">1</parameter></invoke></tool_calls>
\`\`\`

<tool_calls><invoke name="real"><parameter name="a">2</parameter></invoke></tool_calls>`;
  const r = extractToolCalls(text);
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0].name, 'real');
  assert.equal(r.calls[0].args.a, 2);
});

test('loose <invoke> without parent <tool_calls> is parsed', () => {
  const text = `<invoke name="get_weather"><parameter name="city">London</parameter></invoke>`;
  const r = extractToolCalls(text);
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0].args.city, 'London');
});

test('DSML format is parsed', () => {
  const text = `<|DSML|tool_calls>
  <|DSML|invoke name="get_weather">
    <|DSML|parameter name="city">Berlin</|DSML|parameter>
  </|DSML|invoke>
</|DSML|tool_calls>`;
  const r = extractToolCalls(text);
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0].name, 'get_weather');
  assert.equal(r.calls[0].args.city, 'Berlin');
});

test('text without tool calls returned intact', () => {
  const text = 'Sadece düz bir cevap.';
  const r = extractToolCalls(text);
  assert.equal(r.calls.length, 0);
  assert.equal(r.textWithoutBlocks, text);
});
