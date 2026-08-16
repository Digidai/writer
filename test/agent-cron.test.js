import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sweepIdleDrafts, launchPipeline } from '../src/agent.js';

const DOC_ID = '123e4567-e89b-12d3-a456-426614174000';

test('sweepIdleDrafts keeps draft sweep disabled when idleArchiveMinutes is 0', async () => {
  let docQueryArgs = null;
  let pipelineCalls = 0;
  const env = {
    DB: {
      prepare(sql) {
        if (sql === 'SELECT data FROM settings WHERE id = 1') {
          return {
            async first() {
              return { data: JSON.stringify({ idleArchiveMinutes: 0 }) };
            },
          };
        }
        if (sql.includes('SELECT id FROM documents')) {
          return {
            bind(...args) {
              docQueryArgs = args;
              return { async all() { return { results: [] }; } };
            },
          };
        }
        throw new Error(`Unexpected SQL in idle=0 test: ${sql}`);
      },
    },
    PIPELINE: {
      async create() {
        pipelineCalls += 1;
      },
    },
  };

  await sweepIdleDrafts(env);
  assert.equal(Array.isArray(docQueryArgs), true);
  assert.equal(docQueryArgs[0], null);
  assert.equal(docQueryArgs[1], null);
  assert.equal(typeof docQueryArgs[2], 'string');
  assert.equal(pipelineCalls, 0);
});

test('sweepIdleDrafts still reclaims stale processing rows when idle draft archive is off', async () => {
  let pipelinePayload = null;
  const env = {
    DB: {
      prepare(sql) {
        if (sql === 'SELECT data FROM settings WHERE id = 1') {
          return {
            async first() {
              return { data: JSON.stringify({ idleArchiveMinutes: 0 }) };
            },
          };
        }
        if (sql.includes('SELECT id FROM documents')) {
          return {
            bind(draftCutoff, draftCutoff2, stuckCutoff) {
              assert.equal(draftCutoff, null);
              assert.equal(draftCutoff2, null);
              assert.equal(typeof stuckCutoff, 'string');
              return { async all() { return { results: [{ id: DOC_ID }] }; } };
            },
          };
        }
        if (sql.includes("WHERE id = ? AND status IN ('draft', 'processing')")) {
          return {
            bind(updatedAt, id) {
              assert.equal(typeof updatedAt, 'string');
              assert.equal(id, DOC_ID);
              return { async run() { return { meta: { changes: 1 } }; } };
            },
          };
        }
        throw new Error(`Unexpected SQL in stale processing test: ${sql}`);
      },
    },
    PIPELINE: {
      async create(payload) {
        pipelinePayload = payload;
      },
    },
  };

  await sweepIdleDrafts(env);
  assert.equal(Boolean(pipelinePayload), true);
  assert.equal(pipelinePayload.params.docId, DOC_ID);
  assert.match(pipelinePayload.id, new RegExp(`^${DOC_ID}-\\d+$`));
});

test('launchPipeline is a no-op when status guard updates zero rows', async () => {
  let pipelineCalls = 0;
  const env = {
    DB: {
      prepare(sql) {
        assert.match(sql, /^UPDATE documents SET status = 'processing'/);
        return {
          bind(updatedAt, id) {
            assert.equal(typeof updatedAt, 'string');
            assert.equal(id, DOC_ID);
            return { async run() { return { meta: { changes: 0 } }; } };
          },
        };
      },
    },
    PIPELINE: {
      async create() {
        pipelineCalls += 1;
      },
    },
  };

  const launched = await launchPipeline(env, DOC_ID);
  assert.equal(launched, false);
  assert.equal(pipelineCalls, 0);
});
