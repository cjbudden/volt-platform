// A fake SMTP server for the notification checks. Plain SMTP (no TLS), AUTH
// PLAIN accepted for user "volt" / pass "secret", every accepted message
// appended to OUT as one JSON line. RCPT rules: fail@... answers 450
// (temporary), permanent@... answers 550 (permanent).
//
//   node test/lib/fake-smtp.mjs <port> <out.jsonl>
import net from 'node:net';
import { appendFileSync } from 'node:fs';

export function startFakeSmtp(port, out) {
  const srv = net.createServer((sock) => {
    let buf = '', inData = false, data = '', from = '', to = [], authed = false;
    const send = (s) => sock.write(s + '\r\n');
    send('220 fake.smtp ESMTP ready');
    sock.on('data', (d) => {
      buf += d.toString('utf8');
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        if (inData) {
          if (line === '.') {
            inData = false;
            appendFileSync(out, JSON.stringify({ from, to, authed, data }) + '\n');
            send('250 2.0.0 queued as FAKE1');
            data = ''; to = [];
          } else data += line + '\n';
          continue;
        }
        const up = line.toUpperCase();
        if (up.startsWith('EHLO')) { sock.write('250-fake.smtp\r\n250-AUTH PLAIN LOGIN\r\n250 8BITMIME\r\n'); }
        else if (up.startsWith('AUTH PLAIN ')) {
          const [, u, p] = Buffer.from(line.slice(11), 'base64').toString('utf8').split('\u0000');
          if (u === 'volt' && p === 'secret') { authed = true; send('235 2.7.0 ok'); } else send('535 5.7.8 bad credentials');
        }
        else if (up.startsWith('MAIL FROM:')) { from = line.slice(10).replace(/[<>]/g, ''); send('250 ok'); }
        else if (up.startsWith('RCPT TO:')) {
          const a = line.slice(8).replace(/[<>]/g, '');
          if (a.startsWith('fail@')) send('450 4.2.1 mailbox busy, try later');
          else if (a.startsWith('permanent@')) send('550 5.1.1 no such user');
          else { to.push(a); send('250 ok'); }
        }
        else if (up === 'DATA') { inData = true; send('354 go ahead'); }
        else if (up === 'QUIT') { send('221 bye'); sock.end(); }
        else send('502 not implemented');
      }
    });
    sock.on('error', () => {});
  });
  return new Promise((resolve) => srv.listen(port, '127.0.0.1', () => resolve(srv)));
}

if (process.argv[1] && process.argv[1].endsWith('fake-smtp.mjs')) {
  const port = Number(process.argv[2] || 2525);
  startFakeSmtp(port, process.argv[3] || '/tmp/fake-smtp.jsonl').then(() => console.log(`fake smtp on ${port}`));
}
