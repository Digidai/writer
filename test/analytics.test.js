import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { createEnv, browser, signIn } from './helpers/env.js';
import {
  normalizePath, referrerHost, classifyDevice, classifyBrowser, classifyOs, channelFor, viewportBucket, isBot,
} from '../src/analytics.js';

const VIEW = 'a1b2c3d4e5f60718293a4b5c';
const CHROME_MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

// Beacons are recorded after the response; each test step lets them land,
// as real ones (seconds apart) always do.
async function signal(world, client, body) {
  const res = await client.request('/api/signal', { method: 'POST', body });
  await world.settle();
  return res;
}
const view = (world, client, body) => signal(world, client, { type: 'pageview', path: '/', ...body });

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

test('devices, browsers, systems and bots', () => {
  assert.equal(classifyDevice(IPHONE), 'mobile');
  assert.equal(classifyDevice('Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X)'), 'tablet');
  assert.equal(classifyDevice(CHROME_MAC), 'desktop');
  assert.equal(classifyBrowser(CHROME_MAC), 'chrome');
  assert.equal(classifyBrowser(IPHONE), 'safari');
  assert.equal(classifyBrowser(`${CHROME_MAC} Edg/141.0`), 'edge');
  assert.equal(classifyBrowser('Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36 MicroMessenger/8.0'), 'wechat');
  assert.equal(classifyBrowser('Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0'), 'firefox');
  assert.equal(classifyOs(IPHONE), 'ios');
  assert.equal(classifyOs(CHROME_MAC), 'macos');
  assert.equal(classifyOs('Mozilla/5.0 (Phone; OpenHarmony 4.1) AppleWebKit/537.36 Chrome/114 ArkWeb/4.1'), 'harmonyos');
  assert.equal(classifyOs('Mozilla/5.0 (Windows NT 10.0; Win64; x64)'), 'windows');
  assert.equal(classifyOs('Mozilla/5.0 (Linux; Android 14; Pixel 8)'), 'android');
  assert.equal(isBot('Googlebot/2.1 (+http://www.google.com/bot.html)'), true);
  assert.equal(isBot(''), true);
  assert.equal(isBot(CHROME_MAC), false);
});

test('channels: campaign tags first, then where the referrer lives', () => {
  assert.equal(channelFor(null), 'direct');
  assert.equal(channelFor('google.com'), 'search');
  assert.equal(channelFor('google.co.jp'), 'search');
  assert.equal(channelFor('baidu.com'), 'search');
  assert.equal(channelFor('news.ycombinator.com'), 'social');
  assert.equal(channelFor('t.co'), 'social');
  assert.equal(channelFor('chatgpt.com'), 'ai');
  assert.equal(channelFor('perplexity.ai'), 'ai');
  assert.equal(channelFor('gemini.google.com'), 'ai');
  assert.equal(channelFor('mail.google.com'), 'email');
  assert.equal(channelFor('someblog.example'), 'referral');
  assert.equal(channelFor('google.com', { source: 'newsletter', medium: 'email' }), 'email');
  assert.equal(channelFor(null, { source: 'chatgpt.com' }), 'ai');
  assert.equal(channelFor(null, { source: 'launch', campaign: 'oct' }), 'campaign');
  assert.equal(viewportBucket(390), 'xs');
  assert.equal(viewportBucket(1280), 'l');
  assert.equal(viewportBucket('x'), null);
});

test('a page view is stored without the IP address, with where it came from', async () => {
  const world = createEnv();
  const visitor = browser(worker, world, { ip: '203.0.113.99', ua: IPHONE });
  const r = await view(world, visitor, {
    view: VIEW,
    path: '/d/123e4567-e89b-12d3-a456-426614174000',
    referrer: 'https://news.ycombinator.com/item?id=1',
    utm: { source: 'HN', campaign: 'Launch Week' },
    lang: 'zh-CN',
    width: 390,
  });
  assert.equal(r.status, 204);
  await world.settle();
  const row = world.DB.get('SELECT * FROM pageviews');
  assert.equal(row.path, '/d/:id');
  assert.equal(row.view_id, VIEW);
  assert.equal(row.referrer, 'news.ycombinator.com');
  assert.equal(row.channel, 'campaign');
  assert.equal(row.utm_source, 'hn');
  assert.equal(row.utm_campaign, 'launch week');
  assert.equal(row.device, 'mobile');
  assert.equal(row.browser, 'safari');
  assert.equal(row.os, 'ios');
  assert.equal(row.lang, 'zh');
  assert.equal(row.viewport, 'xs');
  assert.equal(row.entry, 1);
  assert.match(row.visitor, /^[0-9a-f]{20}$/);
  assert.ok(!JSON.stringify(row).includes('203.0.113.99'));
  assert.equal(world.DB.get('SELECT COUNT(*) AS n FROM events').n, 0);
});

test('sessions: 30 quiet minutes or a new arrival start one; a reload does not', async () => {
  const world = createEnv();
  const visitor = browser(worker, world);
  await view(world, visitor, { path: '/', referrer: 'https://www.google.com/' });
  await view(world, visitor, { path: '/archive' });
  // Reloading keeps document.referrer: same source, same session.
  await view(world, visitor, { path: '/', referrer: 'https://www.google.com/' });
  await world.settle();
  let rows = world.DB.all('SELECT session, entry, channel, referrer FROM pageviews ORDER BY id');
  assert.equal(new Set(rows.map((r) => r.session)).size, 1);
  assert.deepEqual(rows.map((r) => r.entry), [1, 0, 0]);
  // A continuing view inherits the session's source.
  assert.deepEqual(rows.map((r) => r.channel), ['search', 'search', 'search']);

  await view(world, visitor, { path: '/', referrer: 'https://chatgpt.com/' });
  world.DB.raw.prepare(`UPDATE pageviews SET ts = '2000-01-01T00:00:00.000Z'`).run();
  await view(world, visitor, { path: '/settings' });
  await world.settle();
  rows = world.DB.all('SELECT session, entry, channel FROM pageviews ORDER BY id');
  assert.equal(new Set(rows.map((r) => r.session)).size, 3);
  assert.deepEqual(rows.slice(3).map((r) => [r.entry, r.channel]), [[1, 'ai'], [1, 'direct']]);
});

test('a view reports engaged time, scroll depth and Web Vitals; values are clamped', async () => {
  const world = createEnv();
  const visitor = browser(worker, world);
  await view(world, visitor, { view: VIEW });
  const engage = (body) => signal(world, visitor, { type: 'engage', view: VIEW, ...body });
  await engage({ ms: 42_000, scroll: 60, vitals: { lcp: 1800, fcp: 900, ttfb: 120, cls: 30, inp: 80 } });
  await engage({ ms: 12_000, scroll: 40, vitals: { inp: 240, cls: 999_999 } });
  await engage({ ms: 1, view: 'not-a-view' });
  await world.settle();
  const row = world.DB.get('SELECT engaged_ms, scroll, lcp, fcp, ttfb, cls, inp FROM pageviews');
  assert.deepEqual({ ...row }, { engaged_ms: 42_000, scroll: 60, lcp: 1800, fcp: 900, ttfb: 120, cls: 10_000, inp: 240 });
});

test('bots, admin pages and unknown event types are not recorded', async () => {
  const world = createEnv();
  const bot = browser(worker, world, { ua: 'Googlebot/2.1' });
  await view(world, bot, {});
  const visitor = browser(worker, world);
  await view(world, visitor, { path: '/admin' });
  await visitor.request('/api/signal', { method: 'POST', body: { type: 'signup', path: '/' } });
  await world.settle();
  assert.equal(world.DB.get('SELECT COUNT(*) AS n FROM pageviews').n, 0);
  assert.equal(world.DB.get('SELECT COUNT(*) AS n FROM events').n, 0);
});

test('page views are never tied to an account; product events are, without a visitor hash', async () => {
  const world = createEnv();
  const member = browser(worker, world, { ip: '203.0.113.40' });
  await signIn(member, world.outbox, 'reader@example.com');
  await view(world, member, { view: VIEW, path: '/archive' });
  for (const type of ['completion_shown', 'completion_accept', 'completion_dismiss']) {
    await signal(world, member, { type, view: VIEW, path: '/' });
  }
  const columns = world.DB.all('PRAGMA table_info(pageviews)').map((c) => c.name);
  assert.equal(columns.includes('user_id'), false);
  const events = world.DB.all(`SELECT type, user_id, visitor FROM events WHERE type LIKE 'completion_%' ORDER BY id`);
  assert.deepEqual(events.map((e) => e.type), ['completion_shown', 'completion_accept', 'completion_dismiss']);
  // Nothing to join a member's page views to their account with.
  assert.ok(events.every((e) => e.user_id && e.visitor === null));
  const linked = world.DB.all('SELECT visitor FROM events WHERE user_id IS NOT NULL OR doc_id IS NOT NULL');
  assert.ok(linked.length > 0 && linked.every((e) => e.visitor === null));
});

test('page view and event hashes cannot be joined, even for anonymous visitors', async () => {
  const world = createEnv();
  const visitor = browser(worker, world);
  await view(world, visitor, { view: VIEW });
  await signal(world, visitor, { type: 'auth_prompt', view: VIEW, reason: 'finish' });
  const pv = world.DB.get('SELECT visitor FROM pageviews').visitor;
  const ev = world.DB.get(`SELECT visitor FROM events WHERE type = 'auth_prompt'`).visitor;
  assert.match(ev, /^[0-9a-f]{20}$/);
  assert.notEqual(pv, ev);
});

test('a view id belongs to the visitor who recorded it', async () => {
  const world = createEnv();
  const owner = browser(worker, world, { ip: '203.0.113.60' });
  const other = browser(worker, world, { ip: '198.51.100.61' });
  await view(world, owner, { view: VIEW });
  // The same id again, from someone else: ignored, not a second row.
  await view(world, other, { view: VIEW, path: '/archive' });
  assert.equal(world.DB.get('SELECT COUNT(*) AS n FROM pageviews').n, 1);
  // Someone else cannot report on it either.
  await signal(world, other, { type: 'engage', view: VIEW, ms: 21_600_000, vitals: { lcp: 120_000 } });
  assert.deepEqual({ ...world.DB.get('SELECT engaged_ms, lcp FROM pageviews') }, { engaged_ms: null, lcp: null });
  await signal(world, owner, { type: 'engage', view: VIEW, ms: 5000, vitals: { lcp: 900 } });
  assert.deepEqual({ ...world.DB.get('SELECT engaged_ms, lcp FROM pageviews') }, { engaged_ms: 5000, lcp: 900 });
});

test('product events from the page need a view the server recorded', async () => {
  const world = createEnv();
  const visitor = browser(worker, world);
  await signal(world, visitor, { type: 'completion_accept', view: VIEW });
  await signal(world, visitor, { type: 'completion_accept' });
  assert.equal(world.DB.get('SELECT COUNT(*) AS n FROM events').n, 0);
  await view(world, visitor, { view: VIEW });
  await signal(world, visitor, { type: 'completion_accept', view: VIEW });
  assert.equal(world.DB.get('SELECT COUNT(*) AS n FROM events').n, 1);
});

test('one address can only start so many sessions an hour', async () => {
  const world = createEnv();
  for (let i = 0; i < 65; i++) {
    // A new user agent is a new visitor, and so a new session.
    await view(world, browser(worker, world, { ip: '203.0.113.70', ua: `${CHROME_MAC} Fake/${i}` }), {});
  }
  assert.equal(world.DB.get('SELECT COUNT(*) AS n FROM pageviews').n, 60);
});

test('a long visit on one page is still one visit', async () => {
  const world = createEnv();
  const writer = browser(worker, world);
  await view(world, writer, { view: VIEW });
  // Forty minutes of writing on the editor, reported when the page is left.
  world.DB.raw.prepare(`UPDATE pageviews SET ts = ?`).run(new Date(Date.now() - 45 * 60 * 1000).toISOString());
  await signal(world, writer, { type: 'engage', view: VIEW, ms: 40 * 60 * 1000 });
  await view(world, writer, { path: '/archive' });
  const rows = world.DB.all('SELECT session, entry FROM pageviews ORDER BY id');
  assert.equal(rows[0].session, rows[1].session);
  assert.equal(rows[1].entry, 0);
});

test('event details are always valid JSON, and campaign tags never keep an email', async () => {
  const world = createEnv();
  const visitor = browser(worker, world);
  await signal(world, visitor, { type: 'client_error', message: '\u0001'.repeat(300), source: 'https://writer.example/app.js' });
  const meta = world.DB.get(`SELECT meta FROM events WHERE type = 'client_error'`).meta;
  assert.doesNotThrow(() => JSON.parse(meta));
  await view(world, visitor, { utm: { source: 'jane@example.com', campaign: 'weekly' } });
  const row = world.DB.get('SELECT utm_source, utm_campaign FROM pageviews');
  assert.deepEqual({ ...row }, { utm_source: null, utm_campaign: 'weekly' });
});

test('visitor hashes depend on the analytics secret', async () => {
  const hashWith = async (secret) => {
    const world = createEnv(secret ? { ANALYTICS_SECRET: secret } : {});
    await view(world, browser(worker, world, { ip: '203.0.113.41' }), {});
    await world.settle();
    return world.DB.get('SELECT visitor FROM pageviews').visitor;
  };
  const a = await hashWith('secret-a');
  assert.equal(await hashWith('secret-a'), a);
  assert.notEqual(await hashWith('secret-b'), a);
});

test('browser errors keep no URLs and are capped per address', async () => {
  const world = createEnv();
  const visitor = browser(worker, world);
  for (let i = 0; i < 25; i++) {
    await visitor.request('/api/signal', {
      method: 'POST',
      body: { type: 'client_error', path: '/', message: `boom at https://writer.example/d/x?token=1 #${i}`, source: 'https://writer.example/app.js?v=1', line: 12, col: 3 },
    });
  }
  await world.settle();
  const rows = world.DB.all(`SELECT meta FROM events WHERE type = 'client_error'`);
  assert.equal(rows.length, 20);
  const meta = JSON.parse(rows[0].meta);
  assert.equal(meta.message, 'boom at [url] #0');
  assert.equal(meta.source, '/app.js');
  assert.equal(meta.line, 12);
});

test('sign-in prompts keep only a known reason', async () => {
  const world = createEnv();
  const visitor = browser(worker, world);
  await view(world, visitor, { view: VIEW });
  await signal(world, visitor, { type: 'auth_prompt', view: VIEW, reason: 'finish' });
  await signal(world, visitor, { type: 'auth_prompt', view: VIEW, reason: '<script>' });
  assert.deepEqual(world.DB.all(`SELECT meta FROM events ORDER BY id`).map((r) => JSON.parse(r.meta).reason), ['finish', 'signin']);
});

test('every save counts toward the day it happened, once per document', async () => {
  const world = createEnv();
  const writer = browser(worker, world);
  const created = await writer.json('/api/documents', { method: 'POST', body: { content: 'One line.' } });
  let rev = created.body.updated_at;
  for (const content of ['One line. Two.', 'One line. Two. Three.']) {
    await world.settle();
    const r = await writer.json(`/api/documents/${created.body.id}`, { method: 'PUT', body: { content, rev } });
    rev = r.body.updated_at;
  }
  await world.settle();
  let row = world.DB.get('SELECT * FROM writing_days');
  assert.equal(row.saves, 3);
  assert.equal(row.chars, 'One line. Two. Three.'.length);
  assert.equal(row.user_id, null);
  assert.equal(row.anon, 1);
  // No visitor hash next to a document: a draft cannot link visits.
  assert.equal('visitor' in row, false);

  // Signing in claims the draft; the next save puts the day on the account.
  const verified = await signIn(writer, world.outbox, 'claims@example.com');
  await writer.json(`/api/documents/${created.body.id}`, { method: 'PUT', body: { content: 'Claimed and saved.', rev } });
  await world.settle();
  row = world.DB.get('SELECT * FROM writing_days');
  assert.equal(row.user_id, verified.body.user.id);
  assert.equal(row.anon, 1, 'written anonymously that day, still counted as such');
  assert.equal(row.saves, 4);
});

test('the funnel sees the sign-in wall and who got past it', async () => {
  const world = createEnv();
  const visitor = browser(worker, world);
  await view(world, visitor, {});
  const created = await visitor.json('/api/documents', { method: 'POST', body: { content: 'Written before any account.' } });
  const blocked = await visitor.json(`/api/documents/${created.body.id}/finalize`, { method: 'POST', body: { auto: false } });
  assert.equal(blocked.status, 401);
  await signIn(visitor, world.outbox, 'convert@example.com');
  const done = await visitor.json(`/api/documents/${created.body.id}/finalize`, { method: 'POST', body: { auto: false } });
  assert.equal(done.status, 202);
  await world.settle();
  const types = world.DB.all('SELECT type, doc_id, visitor FROM events ORDER BY id');
  assert.deepEqual(types.map((e) => e.type), ['doc_create', 'finalize_blocked', 'auth_code_sent', 'signup', 'finalize']);
  assert.ok(types.filter((e) => e.type !== 'auth_code_sent' && e.type !== 'signup').every((e) => e.doc_id === created.body.id));
  // Only the event with neither an account nor a document carries a hash.
  assert.deepEqual(types.map((e) => Boolean(e.visitor)), [false, false, true, false, false]);
  assert.equal(world.workflows[0].params.trigger, 'manual');
});
