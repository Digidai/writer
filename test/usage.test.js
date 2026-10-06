import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { WriterPipeline } from '../src/pipeline.js';
import { upsertDocumentVector } from '../src/semantic.js';
import { usageFrom, estimateTokens, errorCode, listNeurons, USD_PER_NEURON } from '../src/ai-usage.js';
import { createEnv, browser, signIn, fakeAI, chatAnswer } from './helpers/env.js';

const KIMI = '@cf/moonshotai/kimi-k2.6';
const QWEN = '@cf/qwen/qwen3-30b-a3b-fp8';

test('usage comes from the response: tokens, cache hits, reasoning and billed neurons', () => {
  // The shape Kimi K2.6 really returns (captured from Workers AI).
  assert.deepEqual(usageFrom({
    usage: {
      prompt_tokens: 506, completion_tokens: 31, total_tokens: 537,
      prompt_tokens_details: { cached_tokens: 448 }, completion_tokens_details: { reasoning_tokens: 20 }, neurons: 22.798,
    },
  }), { input: 506, cached: 448, output: 31, reasoning: 20, neurons: 22.798, estimated: false });
  // bge-m3 reports in `meta`.
  assert.deepEqual(usageFrom({
    data: [[0.1]], meta: { cost_metric_name_1: 'input_tokens', cost_metric_value_1: 10, cost_metric_name_2: null, neurons: 0.0107 },
  }), { input: 10, cached: 0, output: 0, reasoning: 0, neurons: 0.0107, estimated: false });
  assert.equal(usageFrom({ response: 'hi' }), null);
  assert.equal(usageFrom(null), null);
});

test('list prices reproduce what Workers AI bills', () => {
  // 506 in (448 cached) + 31 out on Kimi was billed 22.798 neurons.
  assert.ok(Math.abs(listNeurons(KIMI, { input: 506, cached: 448, output: 31 }) - 22.798) < 0.01);
  assert.ok(Math.abs(listNeurons(QWEN, { input: 15, output: 14 }) - 0.496) < 0.001);
  assert.equal(listNeurons('@cf/unknown/model', { input: 1000 }), 0);
});

test('token estimates and error codes', () => {
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens('你好世界'), 4);
  assert.equal(estimateTokens('abcdefgh'), 2);
  assert.equal(errorCode('3040: Capacity temporarily exceeded'), '3040');
  assert.equal(errorCode('InferenceUpstreamError: 5035: requires a paid plan'), '5035');
  assert.equal(errorCode('network down'), null);
});

test('a completion is metered with its usage, its writer and the gateway log', async () => {
  const ai = fakeAI(chatAnswer('and the river kept going.', { prompt_tokens: 120, completion_tokens: 8, neurons: 0.8 }));
  const world = createEnv({ AI: ai });
  const writer = browser(worker, world);
  const me = await signIn(writer, world.outbox, 'metered@example.com');
  const r = await writer.json('/api/complete', { method: 'POST', body: { context: 'The water ran under the bridge' } });
  assert.equal(r.body.text, 'and the river kept going.');
  await world.settle();

  const row = world.DB.get('SELECT * FROM ai_calls');
  assert.equal(row.feature, 'completion');
  assert.equal(row.model, QWEN);
  assert.equal(row.status, 'ok');
  assert.equal(row.input_tokens, 120);
  assert.equal(row.output_tokens, 8);
  assert.equal(row.neurons, 0.8);
  assert.equal(row.estimated, 0);
  assert.equal(row.user_id, me.body.user.id);
  assert.equal(row.log_id, 'log-1');
  assert.equal(row.finish_reason, 'stop');
  assert.deepEqual(ai.calls[0].options.gateway, { id: 'default', metadata: { app: 'writer', feature: 'completion' } });
});

test('a failed call is metered too, with its error and no cost', async () => {
  const world = createEnv({ AI: fakeAI(new Error('3040: Capacity temporarily exceeded')) });
  const r = await browser(worker, world).json('/api/complete', { method: 'POST', body: { context: 'Some text to continue' } });
  assert.equal(r.body.text, '');
  await world.settle();
  const row = world.DB.get('SELECT status, error, neurons, user_id FROM ai_calls');
  assert.deepEqual({ ...row }, { status: 'error', error: '3040: Capacity temporarily exceeded', neurons: null, user_id: null });
});

test('responses without usage are estimated and priced from the list', async () => {
  const world = createEnv({ AI: fakeAI({ response: 'more words here' }) });
  await browser(worker, world).json('/api/complete', { method: 'POST', body: { context: 'Words to continue from' } });
  await world.settle();
  const row = world.DB.get('SELECT input_tokens, output_tokens, neurons, estimated FROM ai_calls');
  assert.equal(row.estimated, 1);
  assert.ok(row.input_tokens > 0 && row.output_tokens > 0);
  assert.ok(row.neurons > 0);
});

const finishCall = {
  id: 'call-1',
  type: 'function',
  function: { name: 'finish', arguments: JSON.stringify({ title: 'On rivers', category: 'Nature', tags: ['water'], summary: 'Rivers.' }) },
};

test('an agent turn that falls back records both calls, pinned to the document', async () => {
  const ai = fakeAI(
    new Error('5035: This model requires a Workers Paid plan'),
    chatAnswer('', { prompt_tokens: 900, completion_tokens: 60, neurons: 2.2 }, { toolCalls: [finishCall] }),
  );
  const world = createEnv({ AI: ai });
  const pipeline = new WriterPipeline({}, world.env);
  const doc = { id: '11111111-2222-3333-4444-555555555555', user_id: 'u1', content: 'Rivers.' };
  const r = await pipeline.turn([{ role: 'system', content: 'file it' }, { role: 'user', content: 'Rivers.' }], doc, 1);
  assert.equal(r.finish.title, 'On rivers');

  const rows = world.DB.all('SELECT model, status, fallback, turn, doc_id, user_id, feature, error FROM ai_calls ORDER BY id');
  assert.deepEqual(rows.map((x) => [x.model, x.status, x.fallback, x.turn]), [[KIMI, 'error', 0, 1], [QWEN, 'ok', 1, 1]]);
  assert.ok(rows.every((x) => x.doc_id === doc.id && x.user_id === 'u1' && x.feature === 'agent'));
  assert.match(rows[0].error, /^5035/);
  // Kimi gets the prompt-cache affinity header and the gateway tags.
  assert.deepEqual(ai.calls[0].options.extraHeaders, { 'x-session-affinity': `writer-${doc.id}` });
  assert.deepEqual(ai.calls[0].options.gateway.metadata, { app: 'writer', feature: 'agent', doc: doc.id });
  assert.equal(ai.calls[1].options.gateway.metadata.fallback, true);
});

test('a whole run records its turns and an archived event with timing and trigger', async () => {
  const ai = fakeAI(chatAnswer('', { prompt_tokens: 1200, completion_tokens: 90, prompt_tokens_details: { cached_tokens: 1000 }, neurons: 5.1 }, { toolCalls: [finishCall] }));
  const world = createEnv({ AI: ai });
  const id = '22222222-3333-4444-5555-666666666666';
  world.DB.raw.prepare(
    `INSERT INTO documents (id, title, content, status, created_at, updated_at, user_id)
     VALUES (?, 'x', 'Rivers run to the sea.', 'processing', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z', 'u2')`
  ).run(id);
  const step = { do: async (_name, a, b) => (typeof a === 'function' ? a() : b()) };
  const pipeline = new WriterPipeline({}, world.env);
  const out = await pipeline.run({ payload: { docId: id, trigger: 'idle' }, timestamp: new Date(Date.now() - 4000) }, step);
  assert.equal(out.archived, id);

  const call = world.DB.get('SELECT turn, cached_tokens, neurons FROM ai_calls');
  assert.deepEqual({ ...call }, { turn: 1, cached_tokens: 1000, neurons: 5.1 });
  const archived = world.DB.get(`SELECT doc_id, user_id, value, meta FROM events WHERE type = 'archived'`);
  assert.equal(archived.doc_id, id);
  assert.equal(archived.user_id, 'u2');
  assert.ok(archived.value >= 4000);
  const meta = JSON.parse(archived.meta);
  assert.equal(meta.trigger, 'idle');
  assert.equal(meta.chars, 'Rivers run to the sea.'.length);
  assert.equal(meta.turns, 1);
});

test('embeddings are metered from the meta Workers AI returns', async () => {
  const ai = fakeAI({ data: [[0.1, 0.2, 0.3]], meta: { cost_metric_name_1: 'input_tokens', cost_metric_value_1: 42, neurons: 0.045 } });
  const upserts = [];
  const world = createEnv({ AI: ai, WRITER_ACCESS_KEY: 'k', ARCHIVE_INDEX: { upsert: async (v) => upserts.push(v) } });
  const ok = await upsertDocumentVector(world.env, { id: 'doc-e', title: 'T', summary: 'S', content: 'Body', user_id: 'u3' });
  assert.equal(ok, true);
  const row = world.DB.get('SELECT feature, model, input_tokens, neurons, estimated, doc_id, user_id FROM ai_calls');
  assert.deepEqual({ ...row }, {
    feature: 'embed', model: '@cf/baai/bge-m3', input_tokens: 42, neurons: 0.045, estimated: 0, doc_id: 'doc-e', user_id: 'u3',
  });
});

test('dollars are neurons at $0.011 per thousand', () => {
  assert.equal(USD_PER_NEURON, 0.011 / 1000);
});
