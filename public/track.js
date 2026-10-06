// Page analytics without cookies or storage. One view per load, then a
// summary whenever the page is hidden: how long it was actually used,
// how far it was scrolled, and its Web Vitals. The view id lives only in
// this page's memory. The server keeps no IP: see src/analytics.js.
const ENDPOINT = '/api/signal';
// Time counts while the page is visible and was used in the last two minutes.
const IDLE_MS = 2 * 60 * 1000;
const TICK_MS = 5000;
const MAX_ERRORS = 3;

function send(body) {
  try {
    const json = JSON.stringify(body);
    const blob = new Blob([json], { type: 'application/json' });
    if (navigator.sendBeacon && navigator.sendBeacon(ENDPOINT, blob)) return;
    fetch(ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: json, keepalive: true })
      .catch(() => {});
  } catch {
    /* analytics never breaks a page */
  }
}

function randomId() {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Product events from the page (suggestion shown, accepted, sign-in asked).
export function track(type, extra = {}) {
  send({ type, path: location.pathname, ...extra });
}

const view = { id: randomId(), engaged: 0, lastTick: 0, lastInput: 0, scroll: 0, vitals: {} };

function campaign() {
  const p = new URLSearchParams(location.search);
  return {
    source: p.get('utm_source') || p.get('ref') || undefined,
    medium: p.get('utm_medium') || undefined,
    campaign: p.get('utm_campaign') || undefined,
  };
}

function startView() {
  const now = performance.now();
  Object.assign(view, { engaged: 0, lastTick: now, lastInput: now, scroll: 0 });
  measureScroll();
  send({
    type: 'pageview',
    view: view.id,
    path: location.pathname,
    referrer: document.referrer,
    utm: campaign(),
    lang: navigator.language,
    width: window.innerWidth,
  });
}

function tick() {
  const now = performance.now();
  if (document.visibilityState === 'visible' && now - view.lastInput <= IDLE_MS) {
    view.engaged += Math.min(now - view.lastTick, TICK_MS * 2);
  }
  view.lastTick = now;
}

function measureScroll() {
  const doc = document.documentElement;
  const height = Math.max(doc.scrollHeight, document.body ? document.body.scrollHeight : 0);
  const seen = height <= window.innerHeight ? 100 : ((window.scrollY + window.innerHeight) / height) * 100;
  view.scroll = Math.max(view.scroll, Math.min(100, Math.round(seen)));
}

function report() {
  tick();
  send({ type: 'engage', view: view.id, path: location.pathname, ms: Math.round(view.engaged), scroll: view.scroll, vitals: view.vitals });
}

for (const name of ['pointerdown', 'keydown', 'wheel', 'touchstart']) {
  addEventListener(name, () => {
    tick();
    view.lastInput = performance.now();
  }, { capture: true, passive: true });
}
addEventListener('scroll', () => {
  view.lastInput = performance.now();
  measureScroll();
}, { passive: true });
setInterval(tick, TICK_MS);

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') report();
  else {
    view.lastTick = performance.now();
    view.lastInput = view.lastTick;
  }
});
addEventListener('pagehide', report);
// Back/forward cache: a restored page is a new view.
addEventListener('pageshow', (e) => {
  if (!e.persisted) return;
  view.id = randomId();
  view.vitals = {};
  startView();
});

// ---------------------------------------------------------------- vitals
// The Web Vitals definitions, measured directly: LCP is the last largest
// paint before the first input, CLS the worst burst of layout shifts (gaps
// under 1 s, windows under 5 s), INP close to the 98th percentile of
// interaction latency.

function observe(type, onEntries, options = {}) {
  try {
    if (!PerformanceObserver.supportedEntryTypes || !PerformanceObserver.supportedEntryTypes.includes(type)) return;
    new PerformanceObserver((list) => onEntries(list.getEntries())).observe({ type, buffered: true, ...options });
  } catch {
    /* unsupported: that vital is simply absent */
  }
}

const nav = performance.getEntriesByType && performance.getEntriesByType('navigation')[0];
const activation = (nav && nav.activationStart) || 0;
if (nav && nav.responseStart > 0) view.vitals.ttfb = Math.max(0, Math.round(nav.responseStart - activation));

observe('paint', (entries) => {
  for (const e of entries) {
    if (e.name === 'first-contentful-paint') view.vitals.fcp = Math.max(0, Math.round(e.startTime - activation));
  }
});

let lcpFinal = false;
observe('largest-contentful-paint', (entries) => {
  if (lcpFinal) return;
  const last = entries[entries.length - 1];
  if (last) view.vitals.lcp = Math.max(0, Math.round(last.startTime - activation));
});
for (const name of ['keydown', 'pointerdown']) addEventListener(name, () => { lcpFinal = true; }, { once: true, capture: true });

let clsWorst = 0;
let clsWindow = 0;
let clsFirst = 0;
let clsLast = 0;
observe('layout-shift', (entries) => {
  for (const e of entries) {
    if (e.hadRecentInput) continue;
    if (clsWindow && e.startTime - clsLast < 1000 && e.startTime - clsFirst < 5000) clsWindow += e.value;
    else {
      clsWindow = e.value;
      clsFirst = e.startTime;
    }
    clsLast = e.startTime;
    clsWorst = Math.max(clsWorst, clsWindow);
  }
  view.vitals.cls = Math.round(clsWorst * 1000);
});

// Keep the ten slowest interactions and a count: one in fifty is ignored.
const slowest = [];
let interactions = 0;
observe('event', (entries) => {
  const batch = new Map();
  for (const e of entries) {
    if (!e.interactionId) continue;
    batch.set(e.interactionId, Math.max(batch.get(e.interactionId) || 0, e.duration));
  }
  for (const duration of batch.values()) {
    interactions += 1;
    slowest.push(duration);
    slowest.sort((a, b) => b - a);
    if (slowest.length > 10) slowest.pop();
  }
  if (slowest.length) view.vitals.inp = Math.round(slowest[Math.min(slowest.length - 1, Math.floor(interactions / 50))]);
}, { durationThreshold: 40 });

// ---------------------------------------------------------------- errors
// Our own scripts only (not extensions), a few per page, no stack traces.

let errors = 0;
function reportError(message, source, line, col) {
  if (errors >= MAX_ERRORS) return;
  if (source && !String(source).startsWith(location.origin)) return;
  if (/ResizeObserver loop|Script error\.?$/.test(String(message))) return;
  errors += 1;
  send({ type: 'client_error', path: location.pathname, message: String(message).slice(0, 200), source, line, col });
}
addEventListener('error', (e) => {
  if (e.target && e.target !== window) return; // resource load errors
  reportError(e.message, e.filename, e.lineno, e.colno);
});
addEventListener('unhandledrejection', (e) => {
  const reason = e.reason;
  if (reason && reason.name === 'AbortError') return;
  reportError(reason && reason.message ? reason.message : String(reason), reason && reason.fileName, null, null);
});

startView();
