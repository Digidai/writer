import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { createEnv, browser, signIn } from './helpers/env.js';
import { normalizePath, referrerHost, classifyDevice, isBot } from '../src/analytics.js';

test('paths drop document ids, queries and trailing slashes', () => {
  assert.equal(normalizePath('/d/123e4567-e89b-12d3-a456-426614174000'), '/d/:id');
  assert.equal(normalizePath('/archive/?q=secret#x'), '/archive');
  assert.equal(normalizePath('https://writer.example/settings?x=1'), '/settings');
  assert.equal(normalizePath(''), '/');
  assert.equal(normalizePath(`/${'a'.repeat(200)}`).length, 80);
});

test('referrers keep only a foreign host', () => {
  assert.equal(referrerHost('https://www.google.com/search?q=private', 'writer.example'), 'google.com');
  assert.equal(referrerHost('https://writer.example/archive', 'writer.example'), null);
  assert.equal(referrerHost('javascript:alert(1)', 'writer.example'), null);
  assert.equal(referrerHost('', 'writer.example'), null);
});

test('devices and bots', () => {
  assert.equal(classifyDevice('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile'), 'mobile');
  assert.equal(classifyDevice('Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X)'), 'tablet');
  assert.equal(classifyDevice('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'), 'desktop');
  assert.equal(isBot('Googlebot/2.1 (+http://www.google.com/bot.html)'), true);
  assert.equal(isBot(''), true);
  assert.equal(isBot('Mozilla/5.0 (Macintosh)'), false);
});

test('a page view is stored without the IP address', async () => {
  const world = createEnv();
  const visitor = browser(worker, world, { ip: '203.0.113.99' });
  const r = await visitor.request('/api/signal', {
    method: 'POST',
    body: { type: 'pageview', path: '/d/123e4567-e89b-12d3-a456-426614174000', referrer: 'https://news.ycombinator.com/item?id=1' },
  });
  assert.equal(r.status, 204);
  await world.settle();
  const row = world.DB.get(`SELECT * FROM events WHERE type = 'pageview'`);
  assert.equal(row.path, '/d/:id');
  assert.equal(row.referrer, 'news.ycombinator.com');
  assert.equal(row.device, 'desktop');
  assert.match(row.visitor, /^[0-9a-f]{20}$/);
  assert.ok(!JSON.stringify(row).includes('203.0.113.99'));
});

test('bots, admin pages and unknown event types are not recorded', async () => {
  const world = createEnv();
  const bot = browser(worker, world, { ua: 'Googlebot/2.1' });
  await bot.request('/api/signal', { method: 'POST', body: { type: 'pageview', path: '/' } });
  const visitor = browser(worker, world);
  await visitor.request('/api/signal', { method: 'POST', body: { type: 'pageview', path: '/admin' } });
  await visitor.request('/api/signal', { method: 'POST', body: { type: 'signup', path: '/' } });
  await world.settle();
  assert.equal(world.DB.get('SELECT COUNT(*) AS n FROM events').n, 0);
});

test('the same visitor counts once a day; the overview adds it all up', async () => {
  const world = createEnv({ ADMIN_PASSWORD: 'pw-for-test' });
  const visitor = browser(worker, world, { ip: '203.0.113.5' });
  for (const path of ['/', '/archive', '/']) {
    await visitor.request('/api/signal', { method: 'POST', body: { type: 'pageview', path } });
  }
  await browser(worker, world, { ip: '203.0.113.6' }).request('/api/signal', { method: 'POST', body: { type: 'pageview', path: '/' } });
  await signIn(browser(worker, world, { ip: '203.0.113.7' }), world.outbox, 'counted@example.com');
  await world.settle();

  const admin = browser(worker, world, { ip: '198.51.100.2' });
  await admin.json('/api/admin/login', { method: 'POST', body: { password: 'pw-for-test' } });
  const o = (await admin.json('/api/admin/overview?days=7')).body;
  assert.equal(o.traffic.pageviews, 4);
  assert.equal(o.traffic.visitors, 2);
  assert.equal(o.accounts.signups, 1);
  assert.equal(o.daily[o.daily.length - 1].pageviews, 4);

  const tr = (await admin.json('/api/admin/traffic?days=7')).body;
  assert.deepEqual(tr.paths.map((p) => [p.key, p.views]), [['/', 3], ['/archive', 1]]);
});

test('page views are never tied to an account, even when signed in', async () => {
  const world = createEnv();
  const member = browser(worker, world, { ip: '203.0.113.40' });
  await signIn(member, world.outbox, 'reader@example.com');
  await member.request('/api/signal', { method: 'POST', body: { type: 'pageview', path: '/archive' } });
  await member.request('/api/signal', { method: 'POST', body: { type: 'completion_accept', path: '/' } });
  await world.settle();
  assert.equal(world.DB.get(`SELECT user_id FROM events WHERE type = 'pageview'`).user_id, null);
  assert.ok(world.DB.get(`SELECT user_id FROM events WHERE type = 'completion_accept'`).user_id);
});

test('visitor hashes depend on the analytics secret', async () => {
  const hashWith = async (secret) => {
    const world = createEnv(secret ? { ANALYTICS_SECRET: secret } : {});
    await browser(worker, world, { ip: '203.0.113.41' }).request('/api/signal', {
      method: 'POST', body: { type: 'pageview', path: '/' },
    });
    await world.settle();
    return world.DB.get(`SELECT visitor FROM events`).visitor;
  };
  const a = await hashWith('secret-a');
  assert.equal(await hashWith('secret-a'), a);
  assert.notEqual(await hashWith('secret-b'), a);
});
