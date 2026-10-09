// ============================================================================
//  A SMALL SMTP CLIENT, for notification email.
//
//  Small on purpose: plain text mail to one recipient at a time, over SMTPS
//  (port 465) or SMTP with STARTTLS, with AUTH PLAIN or LOGIN. That covers SES,
//  SendGrid, Mailgun, Postmark, Microsoft 365 and Google Workspace relays, all
//  of which take an SMTP URL. No dependency, so a fresh checkout boots without
//  an npm install and nothing about mail can stop the control plane starting.
//
//  Configure with SMTP_URL, e.g. smtps://user:pass@email-smtp.ap-southeast-2.amazonaws.com:465
//  or smtp://user:pass@smtp.example.com:587, and NOTIFY_FROM.
//
//  Errors carry `permanent`: a 5xx reply (bad recipient, rejected sender) will
//  not succeed on retry, a 4xx or a network failure might.
// ============================================================================
import net from 'node:net';
import tls from 'node:tls';
import { randomBytes } from 'node:crypto';
import os from 'node:os';

export class SmtpError extends Error {
  permanent: boolean;
  code: number | null;
  constructor(message: string, code: number | null, permanent: boolean) {
    super(message); this.code = code; this.permanent = permanent;
  }
}

export interface SmtpTarget {
  host: string; port: number; secure: boolean; user?: string; pass?: string;
  /** Upgrade with STARTTLS when offered (default true). */
  starttls: boolean;
  /** Accept a self-signed certificate: tests and private relays only. */
  insecureTls?: boolean;
}

export function parseSmtpUrl(url: string): SmtpTarget {
  const u = new URL(url);
  if (u.protocol !== 'smtp:' && u.protocol !== 'smtps:') throw new Error('SMTP_URL must start with smtp:// or smtps://');
  const secure = u.protocol === 'smtps:';
  return {
    host: u.hostname,
    port: u.port ? Number(u.port) : (secure ? 465 : 587),
    secure,
    user: u.username ? decodeURIComponent(u.username) : undefined,
    pass: u.password ? decodeURIComponent(u.password) : undefined,
    starttls: u.searchParams.get('starttls') !== 'false',
    insecureTls: u.searchParams.get('insecure') === '1',
  };
}

/** RFC 2047 encoded-word for a header that may hold non-ASCII. */
export function encodeHeader(s: string): string {
  const clean = s.replace(/[\r\n]+/g, ' ');
  return /^[\x20-\x7e]*$/.test(clean) ? clean : `=?UTF-8?B?${Buffer.from(clean, 'utf8').toString('base64')}?=`;
}

const ADDRESS = /^[^\s<>@,;"]+@[^\s<>@,;"]+$/;
export function validAddress(a: string): boolean { return ADDRESS.test(a.trim()); }

/** The whole message, CRLF line endings, body base64 so no dot-stuffing or 8-bit worries. */
export function buildMessage(o: { from: string; to: string; subject: string; text: string; date?: Date; messageId?: string }): string {
  const domain = (o.from.split('@')[1] || 'volt.local').replace(/[>\s]/g, '');
  const id = o.messageId ?? `<${Date.now().toString(36)}.${randomBytes(6).toString('hex')}@${domain}>`;
  const body = Buffer.from(o.text.replace(/\r?\n/g, '\r\n'), 'utf8').toString('base64').replace(/.{1,76}/g, '$&\r\n');
  return [
    `From: ${o.from}`,
    `To: ${o.to}`,
    `Subject: ${encodeHeader(o.subject)}`,
    `Date: ${(o.date ?? new Date()).toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: ${id}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    'Auto-Submitted: auto-generated',
    '',
    body,
  ].join('\r\n');
}

/** A line-oriented SMTP conversation over a socket that can be swapped for TLS. */
class Conversation {
  private sock: net.Socket | tls.TLSSocket;
  private buf = '';
  private waiters: ((line: string) => void)[] = [];
  private lines: string[] = [];
  private failed: Error | null = null;

  constructor(sock: net.Socket | tls.TLSSocket) { this.sock = sock; this.attach(sock); }

  private attach(sock: net.Socket | tls.TLSSocket) {
    sock.setEncoding('utf8');
    sock.on('data', (d: string) => {
      this.buf += d;
      let i;
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i).replace(/\r$/, '');
        this.buf = this.buf.slice(i + 1);
        const w = this.waiters.shift();
        if (w) w(line); else this.lines.push(line);
      }
    });
    sock.on('error', (e) => { this.failed = e; for (const w of this.waiters.splice(0)) w(`__error__ ${e.message}`); });
    sock.on('close', () => { for (const w of this.waiters.splice(0)) w('__error__ connection closed'); });
  }

  private nextLine(timeoutMs: number): Promise<string> {
    if (this.lines.length) return Promise.resolve(this.lines.shift()!);
    if (this.failed) return Promise.resolve(`__error__ ${this.failed.message}`);
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve('__error__ timed out waiting for the mail server'), timeoutMs);
      this.waiters.push((l) => { clearTimeout(t); resolve(l); });
    });
  }

  /** Read one (possibly multi-line) reply: "250-a / 250-b / 250 c". */
  async reply(timeoutMs = 30000): Promise<{ code: number; text: string; lines: string[] }> {
    const lines: string[] = [];
    for (;;) {
      const l = await this.nextLine(timeoutMs);
      if (l.startsWith('__error__')) throw new SmtpError(l.slice(10), null, false);
      lines.push(l);
      if (/^\d{3} /.test(l) || /^\d{3}$/.test(l)) break;
      if (!/^\d{3}-/.test(l)) throw new SmtpError(`Unexpected reply from mail server: ${l.slice(0, 120)}`, null, false);
    }
    const code = Number(lines[lines.length - 1].slice(0, 3));
    return { code, text: lines.map((l) => l.slice(4)).join(' '), lines };
  }

  write(s: string) { this.sock.write(s); }

  async cmd(line: string, expect: number[], label = line.split(' ')[0]): Promise<{ code: number; text: string; lines: string[] }> {
    this.write(line + '\r\n');
    const r = await this.reply();
    if (!expect.includes(r.code)) throw new SmtpError(`${label} refused: ${r.code} ${r.text}`.slice(0, 300), r.code, r.code >= 500);
    return r;
  }

  async upgrade(host: string, insecure: boolean): Promise<void> {
    const plain = this.sock as net.Socket;
    plain.removeAllListeners('data'); plain.removeAllListeners('error'); plain.removeAllListeners('close');
    const secured = await new Promise<tls.TLSSocket>((resolve, reject) => {
      const s = tls.connect({ socket: plain, servername: host, rejectUnauthorized: !insecure }, () => resolve(s));
      s.once('error', reject);
    });
    this.sock = secured; this.buf = ''; this.lines = [];
    this.attach(secured);
  }

  end() { try { this.sock.end(); } catch { /* gone */ } }
}

async function open(t: SmtpTarget, timeoutMs: number): Promise<net.Socket | tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { s.destroy(); reject(new SmtpError(`Could not reach ${t.host}:${t.port}`, null, false)); }, timeoutMs);
    const done = () => { clearTimeout(timer); resolve(s); };
    const s: net.Socket | tls.TLSSocket = t.secure
      ? tls.connect({ host: t.host, port: t.port, servername: t.host, rejectUnauthorized: !t.insecureTls }, done)
      : net.connect({ host: t.host, port: t.port }, done);
    s.once('error', (e) => { clearTimeout(timer); reject(new SmtpError(`Could not reach ${t.host}:${t.port}: ${e.message}`, null, false)); });
  });
}

/** Send one plain-text message. Throws SmtpError. */
export async function sendMail(t: SmtpTarget, m: { from: string; to: string; subject: string; text: string }, timeoutMs = 20000): Promise<{ response: string }> {
  if (!validAddress(m.to)) throw new SmtpError(`Not an email address: ${m.to}`, null, true);
  const fromAddr = (/<([^>]+)>/.exec(m.from)?.[1] ?? m.from).trim();
  const c = new Conversation(await open(t, timeoutMs));
  try {
    const greet = await c.reply();
    if (greet.code !== 220) throw new SmtpError(`Mail server greeting: ${greet.code} ${greet.text}`, greet.code, greet.code >= 500);
    const me = os.hostname() || 'volt.local';
    let ehlo = await c.cmd(`EHLO ${me}`, [250]);
    const offers = (k: string) => ehlo.lines.some((l) => l.slice(4).toUpperCase().startsWith(k));
    if (!t.secure && t.starttls && offers('STARTTLS')) {
      await c.cmd('STARTTLS', [220]);
      await c.upgrade(t.host, !!t.insecureTls);
      ehlo = await c.cmd(`EHLO ${me}`, [250]);
    }
    if (t.user) {
      const authLine = ehlo.lines.find((l) => l.slice(4).toUpperCase().startsWith('AUTH')) ?? '';
      if (/\bPLAIN\b/i.test(authLine) || !/\bLOGIN\b/i.test(authLine)) {
        const tok = Buffer.from(`\u0000${t.user}\u0000${t.pass ?? ''}`, 'utf8').toString('base64');
        await c.cmd(`AUTH PLAIN ${tok}`, [235], 'AUTH');
      } else {
        await c.cmd('AUTH LOGIN', [334], 'AUTH');
        await c.cmd(Buffer.from(t.user).toString('base64'), [334], 'AUTH');
        await c.cmd(Buffer.from(t.pass ?? '').toString('base64'), [235], 'AUTH');
      }
    }
    await c.cmd(`MAIL FROM:<${fromAddr}>`, [250], 'MAIL FROM');
    await c.cmd(`RCPT TO:<${m.to.trim()}>`, [250, 251], 'RCPT TO');
    await c.cmd('DATA', [354]);
    // Base64 body lines never start with '.', and headers are ours, so no
    // dot-stuffing is needed beyond the terminator.
    c.write(buildMessage(m) + '\r\n.\r\n');
    const done = await c.reply();
    if (done.code !== 250) throw new SmtpError(`Message refused: ${done.code} ${done.text}`.slice(0, 300), done.code, done.code >= 500);
    try { await c.cmd('QUIT', [221]); } catch { /* the message is already accepted */ }
    return { response: done.text };
  } finally {
    c.end();
  }
}
