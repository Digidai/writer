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
