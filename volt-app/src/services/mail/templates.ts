// ============================================================================
//  TRANSACTIONAL EMAIL TEMPLATES (welcome, password reset, signup receipts).
//
//  Every message has a plain text part and an HTML part. The HTML is built for
//  email clients, not browsers: tables for layout, inline styles, no web fonts
//  that must load, no images (many clients block them, and the wordmark is
//  set in text so the message still reads as Volt with images off).
//
//  Brand: a Control room band across the top with the name, Paper body, one
//  button in Volt Indigo with white text. No coloured edge bars.
// ============================================================================

export interface Rendered { subject: string; text: string; html: string }

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

function fmtExpiry(d: Date): string {
  const hours = Math.round((d.getTime() - Date.now()) / 3_600_000);
  if (hours <= 1) return 'in 1 hour';
  if (hours < 48) return `in ${hours} hours`;
  return `in ${Math.round(hours / 24)} days`;
}

/** The shared frame: dark band with the name, light body, small print. */
function frame(o: { preheader: string; heading: string; paragraphs: string[]; button?: { label: string; href: string }; after?: string[]; foot: string }): string {
  const p = (t: string) => `<p style="margin:0 0 14px;font:15px/24px Inter,Segoe UI,Arial,sans-serif;color:#1d2330">${t}</p>`;
  const btn = o.button
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:6px 0 20px"><tr><td style="background:#4f46e5;border-radius:8px">
         <a href="${esc(o.button.href)}" style="display:inline-block;padding:12px 22px;font:600 15px/20px Inter,Segoe UI,Arial,sans-serif;color:#ffffff;text-decoration:none">${esc(o.button.label)}</a>
       </td></tr></table>
       <p style="margin:0 0 18px;font:12.5px/19px Inter,Segoe UI,Arial,sans-serif;color:#5b6475">If the button does not work, copy this address into your browser:<br>
         <span style="font-family:JetBrains Mono,Menlo,Consolas,monospace;word-break:break-all;color:#3d3fbf">${esc(o.button.href)}</span></p>`
    : '';
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(o.heading)}</title></head>
<body style="margin:0;padding:0;background:#eef0f5">
<span style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(o.preheader)}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef0f5"><tr><td align="center" style="padding:28px 12px">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #dde1ea">
    <tr><td style="background:#0b0e14;padding:22px 28px">
      <span style="font:800 20px/24px Archivo,Arial Black,Arial,sans-serif;color:#ffffff;letter-spacing:-0.3px">&#9889;&nbsp;Volt</span>
      <span style="font:400 20px/24px Archivo,Arial,sans-serif;color:#8ea6ff">&nbsp;Streaming</span>
    </td></tr>
    <tr><td style="padding:28px 28px 10px">
      <h1 style="margin:0 0 16px;font:700 22px/28px Archivo,Arial,sans-serif;color:#0f1218">${esc(o.heading)}</h1>
      ${o.paragraphs.map(p).join('\n      ')}
      ${btn}
      ${(o.after ?? []).map(p).join('\n      ')}
    </td></tr>
    <tr><td style="padding:16px 28px 22px;border-top:1px solid #e6e9f0">
      <p style="margin:0;font:12px/18px Inter,Segoe UI,Arial,sans-serif;color:#7a8396">${o.foot}</p>
    </td></tr>
  </table>
</td></tr></table>
</body></html>`;
}

export function welcomeEmail(o: { accountName: string; inviter: string | null; name: string | null; link: string; expiresAt: Date; selfService?: boolean }): Rendered {
  const hi = o.name ? `Hi ${o.name.split(/\s+/)[0]},` : 'Hello,';
  const who = o.selfService
    ? `Your Volt Streaming account for <b>${esc(o.accountName)}</b> is ready.`
    : `${o.inviter ? esc(o.inviter) : 'An administrator'} has invited you to <b>${esc(o.accountName)}</b> on Volt Streaming.`;
  const whoText = o.selfService
    ? `Your Volt Streaming account for ${o.accountName} is ready.`
    : `${o.inviter ?? 'An administrator'} has invited you to ${o.accountName} on Volt Streaming.`;
  const exp = fmtExpiry(o.expiresAt);
  const subject = o.selfService ? 'Welcome to Volt Streaming: finish setting up your account' : `You have been invited to ${o.accountName} on Volt Streaming`;
  const text = [
    hi, '',
    whoText, '',
    'To finish setting up, open this link. We will email you a 6-digit code to confirm it is you, and then you choose your password.', '',
    o.link, '',
    `The link works once and expires ${exp}.`, '',
    'If you were not expecting this email you can ignore it. No account is active until the steps above are completed.',
  ].join('\n');
  const html = frame({
    preheader: 'Confirm your email and choose a password to start using Volt Streaming.',
    heading: o.selfService ? 'Welcome to Volt Streaming' : 'You have been invited',
    paragraphs: [esc(hi), who, 'To finish setting up, open the link below. We will email you a 6-digit code to confirm it is you, and then you choose your password.'],
    button: { label: 'Set up my account', href: o.link },
    after: [`The link works once and expires ${esc(exp)}.`],
    foot: 'If you were not expecting this email you can ignore it. No account is active until the steps above are completed.',
  });
  return { subject, text, html };
}

export function resetEmail(o: { name: string | null; link: string; expiresAt: Date }): Rendered {
  const hi = o.name ? `Hi ${o.name.split(/\s+/)[0]},` : 'Hello,';
  const exp = fmtExpiry(o.expiresAt);
  const text = [
    hi, '',
    'Someone asked to reset the password for your Volt Streaming account. If it was you, open this link. We will email you a 6-digit code to confirm, and then you choose a new password.', '',
    o.link, '',
    `The link works once and expires ${exp}. Your current password keeps working until a new one is set.`, '',
    'If you did not ask for this, ignore this email. Nothing changes.',
  ].join('\n');
  const html = frame({
    preheader: 'Reset the password for your Volt Streaming account.',
    heading: 'Reset your password',
    paragraphs: [esc(hi), 'Someone asked to reset the password for your Volt Streaming account. If it was you, open the link below. We will email you a 6-digit code to confirm, and then you choose a new password.'],
    button: { label: 'Choose a new password', href: o.link },
    after: [`The link works once and expires ${esc(exp)}. Your current password keeps working until a new one is set.`],
    foot: 'If you did not ask for this, ignore this email. Nothing changes.',
  });
  return { subject: 'Reset your Volt Streaming password', text, html };
}

/** Sent when someone registers with an address that already has an account: no new account, a pointer instead. */
export function alreadyRegisteredEmail(o: { signInUrl: string; resetUrl: string }): Rendered {
  const text = [
    'Hello,', '',
    'Someone tried to register for Volt Streaming with this email address, which already has an account.', '',
    `Sign in: ${o.signInUrl}`,
    `Forgot your password? ${o.resetUrl}`, '',
    'If this was not you, you can ignore this email.',
  ].join('\n');
  const html = frame({
    preheader: 'This email address already has a Volt Streaming account.',
    heading: 'You already have an account',
    paragraphs: ['Someone tried to register for Volt Streaming with this email address, which already has an account.'],
    button: { label: 'Sign in', href: o.signInUrl },
    after: [`Forgot your password? <a href="${esc(o.resetUrl)}" style="color:#3d3fbf">Reset it here</a>.`],
    foot: 'If this was not you, you can ignore this email.',
  });
  return { subject: 'Your Volt Streaming account', text, html };
}

export function waitlistEmail(o: { name: string | null }): Rendered {
  const hi = o.name ? `Hi ${o.name.split(/\s+/)[0]},` : 'Hello,';
  const text = [hi, '', 'Thanks for registering your interest in Volt Streaming. You are on the list, and we will email you as soon as your access is ready.', '', 'Nothing else is needed from you for now.'].join('\n');
  const html = frame({
    preheader: 'You are on the Volt Streaming list.',
    heading: 'You are on the list',
    paragraphs: [esc(hi), 'Thanks for registering your interest in Volt Streaming. We will email you as soon as your access is ready.'],
    foot: 'You received this because this address was entered on the Volt Streaming website. If that was not you, ignore this email and nothing more will be sent.',
  });
  return { subject: 'You are on the Volt Streaming list', text, html };
}
