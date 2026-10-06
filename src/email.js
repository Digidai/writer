// Sign-in codes go out through Cloudflare Email Service (the send_email
// binding). The sending domain must be onboarded in the dashboard:
// Compute > Email Service > Email Sending > Onboard Domain.
import { makeT } from '../public/i18n.js';

const DEFAULT_FROM = 'Writer <noreply@genedai.md>';

export class EmailUnavailableError extends Error {
  constructor(reason) {
    super(`email unavailable: ${reason}`);
    this.reason = reason;
  }
}

export function emailConfigured(env) {
  return Boolean(env && env.EMAIL && typeof env.EMAIL.send === 'function');
}

export async function sendLoginCode(env, { to, code, lang = 'en' }) {
  if (!emailConfigured(env)) throw new EmailUnavailableError('no-binding');
  const t = makeT(lang);
  const minutes = 10;
  const text = [
    t('email.codeIntro'),
    '',
    `    ${code}`,
    '',
    t('email.codeExpires', { minutes }),
    t('email.codeIgnore'),
    '',
    'Writer · https://writer.genedai.md',
  ].join('\n');

  const html = `<!doctype html><html><body style="margin:0;padding:32px 16px;background:#f2efe9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC',sans-serif;color:#1c1b18">
<div style="max-width:420px;margin:0 auto;background:#fffdf9;border:1px solid rgba(31,27,18,.08);border-radius:3px;padding:32px 28px">
<p style="margin:0 0 20px;font:italic 19px Georgia,serif">writer<span style="color:#b3432b;font-style:normal">.</span></p>
<p style="margin:0 0 18px;font-size:15px;line-height:1.7">${escape(t('email.codeIntro'))}</p>
<p style="margin:0 0 18px;font-size:30px;letter-spacing:.3em;font-variant-numeric:tabular-nums">${escape(code)}</p>
<p style="margin:0;font-size:13px;line-height:1.7;color:#6f6a60">${escape(t('email.codeExpires', { minutes }))}<br>${escape(t('email.codeIgnore'))}</p>
</div></body></html>`;

  try {
    const result = await env.EMAIL.send({
      to,
      from: env.MAIL_FROM || DEFAULT_FROM,
      subject: t('email.codeSubject', { code }),
      text,
      html,
    });
    return { messageId: result && result.messageId ? result.messageId : null };
  } catch (err) {
    throw new EmailUnavailableError((err && (err.code || err.message)) || 'send-failed');
  }
}

function escape(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
