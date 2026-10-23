// Email content, in the customer site's brand colours (navy #142b4a, orange #ff8a24). Plain inline
// styles and tables, since email clients ignore most CSS.

const NAVY = '#142b4a';
const ORANGE = '#ff8a24';

// The public website — links in emails point here. (Set SITE_URL to http://localhost:5174 locally to test
// links such as password resets against the local site.)
export function siteUrl() {
  return (process.env.SITE_URL || 'https://www.roamwheels.com').replace(/\/+$/, '');
}

// Always the live site's logo, so it shows in inboxes even when links point to a local copy.
const LOGO_URL = 'https://www.roamwheels.com/logo.png';

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function button(href, label) {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:28px;"><tr>
<td style="border-radius:999px;background:${ORANGE};">
<a href="${href}" style="display:inline-block;padding:13px 28px;font-size:15px;font-weight:bold;color:${NAVY};text-decoration:none;">${label}</a>
</td></tr></table>`;
}

function layout({ preheader, body }) {
  const site = siteUrl();
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>RoamWheels</title></head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:Arial,Helvetica,sans-serif;color:#334155;">
<span style="display:none;max-height:0;overflow:hidden;opacity:0;">${preheader}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:24px 12px;">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:16px;overflow:hidden;">
<tr><td style="background:#ffffff;padding:16px 24px 8px;text-align:center;border-top:6px solid ${NAVY};border-bottom:3px solid ${ORANGE};">
<img src="${LOGO_URL}" alt="RoamWheels" width="110" height="110" style="width:110px;height:110px;border:0;">
</td></tr>
<tr><td style="padding:32px 28px;">${body}</td></tr>
<tr><td style="background:#f8fafc;padding:18px 28px;text-align:center;font-size:12px;color:#94a3b8;">
Self-drive car rentals in Bengaluru · <a href="${site}" style="color:#64748b;">${site.replace(/^https?:\/\//, '')}</a>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

const PERKS = ['Zero security deposit', 'No kilometre limit', 'Pets are most welcome', '2 extra hours free on return'];

// Sent once, when an email is first added to the newsletter list.
export function subscriberWelcomeEmail() {
  const site = siteUrl();
  const perks = PERKS.map(
    (p) => `<tr><td style="padding:4px 0;font-size:14px;color:#334155;"><span style="color:${ORANGE};font-weight:bold;">&#10003;</span>&nbsp; ${p}</td></tr>`
  ).join('');
  const html = layout({
    preheader: 'Thanks for subscribing — offers and deals from RoamWheels are on their way.',
    body: `
<h1 style="margin:0;font-size:24px;line-height:1.3;color:${NAVY};">Welcome to <span style="color:${ORANGE};">RoamWheels</span>!</h1>
<p style="margin:16px 0 0;font-size:15px;line-height:1.6;">Thanks for subscribing. You'll be the first to hear about our offers, exclusive deals and new cars in Bengaluru.</p>
<p style="margin:16px 0 8px;font-size:15px;line-height:1.6;">Why people drive with us:</p>
<table role="presentation" cellpadding="0" cellspacing="0">${perks}</table>
<table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:28px;"><tr>
<td style="border-radius:999px;background:${ORANGE};">
<a href="${site}/" style="display:inline-block;padding:13px 28px;font-size:15px;font-weight:bold;color:${NAVY};text-decoration:none;">Explore cars &rarr;</a>
</td></tr></table>
<p style="margin:28px 0 0;font-size:13px;line-height:1.6;color:#64748b;">Happy roaming,<br>Team RoamWheels</p>`,
  });
  const text = [
    'Welcome to RoamWheels!',
    '',
    "Thanks for subscribing. You'll be the first to hear about our offers, exclusive deals and new cars in Bengaluru.",
    '',
    ...PERKS.map((p) => `- ${p}`),
    '',
    `Explore cars: ${site}/`,
    '',
    'Happy roaming,',
    'Team RoamWheels',
  ].join('\n');
  return { subject: 'Welcome to RoamWheels 🚗', html, text };
}

// "Forgot password" — a one-time link to choose a new password. `mobile` is shown masked, so a guest with
// more than one account on the same email knows which one the link is for.
export function passwordResetEmail({ name, mobile, link, validMinutes }) {
  const firstName = escapeHtml(String(name || '').trim().split(/\s+/)[0] || 'there');
  const masked = mobile ? `•••••${String(mobile).slice(-5)}` : '';
  const html = layout({
    preheader: `Reset your RoamWheels password — this link works for ${validMinutes} minutes.`,
    body: `
<h1 style="margin:0;font-size:24px;line-height:1.3;color:${NAVY};">Reset your <span style="color:${ORANGE};">password</span></h1>
<p style="margin:16px 0 0;font-size:15px;line-height:1.6;">Hi ${firstName}, we got a request to reset the password for your RoamWheels account${
      masked ? ` with mobile number <strong>${masked}</strong>` : ''
    }.</p>
<p style="margin:12px 0 0;font-size:15px;line-height:1.6;">Tap the button below to choose a new password. The link works once, for the next <strong>${validMinutes} minutes</strong>.</p>
${button(link, 'Set a new password &rarr;')}
<p style="margin:24px 0 0;font-size:13px;line-height:1.6;color:#64748b;">If the button doesn't work, copy this link into your browser:<br><a href="${link}" style="color:#64748b;word-break:break-all;">${link}</a></p>
<p style="margin:16px 0 0;font-size:13px;line-height:1.6;color:#64748b;">Didn't ask for this? You can ignore this email — your password stays the same.</p>
<p style="margin:24px 0 0;font-size:13px;line-height:1.6;color:#64748b;">Team RoamWheels</p>`,
  });
  const text = [
    `Hi ${String(name || '').trim().split(/\s+/)[0] || 'there'},`,
    '',
    `We got a request to reset the password for your RoamWheels account${masked ? ` with mobile number ${masked}` : ''}.`,
    `Open this link to choose a new password (it works once, for the next ${validMinutes} minutes):`,
    link,
    '',
    "Didn't ask for this? You can ignore this email — your password stays the same.",
    '',
    'Team RoamWheels',
  ].join('\n');
  return { subject: 'Reset your RoamWheels password', html, text };
}

// Email verification code — at signup, or when changing the email on a profile.
export function emailCodeEmail({ code, purpose, name, validMinutes }) {
  const firstName = escapeHtml(String(name || '').trim().split(/\s+/)[0] || 'there');
  const why =
    purpose === 'login'
      ? 'Use this code to log in to your RoamWheels account.'
      : purpose === 'change-email'
        ? 'Use this code to confirm the new email address for your RoamWheels account.'
        : 'Use this code to verify your email and finish creating your RoamWheels account.';
  const digits = escapeHtml(code)
    .split('')
    .map((d) => `<td style="padding:0 3px;"><div style="width:40px;height:52px;line-height:52px;border-radius:10px;background:#fff7ed;border:1px solid #fed7aa;font-size:26px;font-weight:bold;color:${NAVY};text-align:center;">${d}</div></td>`)
    .join('');
  const html = layout({
    preheader: `Your RoamWheels code is ${code}. It works for ${validMinutes} minutes.`,
    body: `
<h1 style="margin:0;font-size:24px;line-height:1.3;color:${NAVY};">Your verification <span style="color:${ORANGE};">code</span></h1>
<p style="margin:16px 0 0;font-size:15px;line-height:1.6;">Hi ${firstName}, ${why}</p>
<table role="presentation" cellpadding="0" cellspacing="0" style="margin:24px auto 0;"><tr>${digits}</tr></table>
<p style="margin:20px 0 0;font-size:14px;line-height:1.6;text-align:center;color:#64748b;">This code works once, for the next <strong>${validMinutes} minutes</strong>. Don't share it with anyone — our team will never ask for it.</p>
<p style="margin:24px 0 0;font-size:13px;line-height:1.6;color:#64748b;">Didn't ask for this? You can ignore this email${purpose === 'login' ? ' — nobody can log in without the code' : ''}.</p>
<p style="margin:16px 0 0;font-size:13px;line-height:1.6;color:#64748b;">Team RoamWheels</p>`,
  });
  const text = [
    `Hi ${String(name || '').trim().split(/\s+/)[0] || 'there'},`,
    '',
    why,
    '',
    `Your code: ${code}`,
    `It works once, for the next ${validMinutes} minutes. Don't share it with anyone.`,
    '',
    "Didn't ask for this? You can ignore this email.",
    '',
    'Team RoamWheels',
  ].join('\n');
  const subject = purpose === 'login' ? `${code} is your RoamWheels login code` : `${code} is your RoamWheels verification code`;
  return { subject, html, text };
}
