import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleUnlock } from '../src/access.js';

test('GET /unlock ignores ?key= and never sets cookie', async () => {
  const req = new Request('https://writer.example/unlock?key=demo-secret');
  const res = await handleUnlock(req, { WRITER_ACCESS_KEY: 'demo-secret' }, new URL(req.url));

  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Set-Cookie'), null);
  const html = await res.text();
  assert.match(html, /<form[^>]+action="\/unlock"/);
});

test('POST /unlock reads key from formData only', async () => {
  const form = new FormData();
  form.set('key', 'demo-secret');
  const req = new Request('https://writer.example/unlock?key=wrong', { method: 'POST', body: form });
  const res = await handleUnlock(req, { WRITER_ACCESS_KEY: 'demo-secret' }, new URL(req.url));

  assert.equal(res.status, 302);
  assert.match(res.headers.get('Set-Cookie') || '', /writer_key=/);
});
