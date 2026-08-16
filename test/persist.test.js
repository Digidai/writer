import { test } from 'node:test';
import assert from 'node:assert/strict';
import { persistArchive } from '../src/persist.js';

test('persistArchive skips when row is no longer processing', async () => {
  const trace = [{ turn: 1, note: 'agent ran' }];
  const env = {
    DB: {
      prepare(sql) {
        assert.match(sql, /WHERE id = \? AND status = 'processing'/);
        return {
          bind() {
            return {
              async run() {
                return { meta: { changes: 0 } };
              },
            };
          },
        };
      },
    },
  };

  const out = await persistArchive(
    env,
    { id: 'doc-1', title: 'old', content: '正文', created_at: '2026-08-16T00:00:00.000Z' },
    { title: 'new', category: '随笔', tags: ['a'], summary: 's', formatted: '正文' },
    trace,
    {}
  );

  assert.equal(out.skipped, true);
  assert.equal(out.reason, 'not-processing');
  assert.deepEqual(trace.at(-1), { turn: 'persist', skipped: true, reason: 'document not processing' });
});

test('persistArchive keeps original content when agentFormatting is false', async () => {
  let boundFormatted = null;
  const doc = {
    id: 'doc-agent-formatting-off',
    title: 'old',
    content: 'Original body should stay untouched.',
    created_at: '2026-08-16T00:00:00.000Z',
  };
  const env = {
    DB: {
      prepare(sql) {
        assert.match(sql, /^UPDATE documents/);
        return {
          bind(...args) {
            boundFormatted = args[4];
            return {
              async run() {
                return { meta: { changes: 1 } };
              },
            };
          },
        };
      },
    },
  };

  const out = await persistArchive(
    env,
    doc,
    { title: 'new', category: '随笔', tags: ['a'], summary: 's', formatted: 'Agent shortened text' },
    [],
    { agentFormatting: false }
  );

  assert.equal(out.skipped, false);
  assert.equal(out.final.formatted, doc.content);
  assert.equal(boundFormatted, doc.content);
});

test('persistArchive rejects overly shortened formatted text and keeps original content', async () => {
  const doc = {
    id: 'doc-too-short',
    title: 'old',
    content: 'abcdefghij',
    created_at: '2026-08-16T00:00:00.000Z',
  };
  const env = {
    DB: {
      prepare(sql) {
        assert.match(sql, /^UPDATE documents/);
        return {
          bind() {
            return {
              async run() {
                return { meta: { changes: 1 } };
              },
            };
          },
        };
      },
    },
  };

  const out = await persistArchive(
    env,
    doc,
    { title: 'new', category: '随笔', tags: [], summary: 'summary', formatted: 'abc' },
    [],
    { agentFormatting: true }
  );

  assert.equal(out.skipped, false);
  assert.equal(out.final.formatted, doc.content);
});
