// One page view per load, sent as a beacon so it never delays anything.
// The server keeps no IP and no cookie for this: see src/analytics.js.
export function track(type, extra = {}) {
  try {
    const body = JSON.stringify({
      type,
      path: location.pathname,
      referrer: type === 'pageview' ? document.referrer : '',
      ...extra,
    });
    const blob = new Blob([body], { type: 'application/json' });
    if (navigator.sendBeacon && navigator.sendBeacon('/api/signal', blob)) return;
    fetch('/api/signal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      keepalive: true,
    }).catch(() => {});
  } catch {
    /* analytics never breaks a page */
  }
}

track('pageview');
