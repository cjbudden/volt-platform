#!/usr/bin/env python3
"""A stand-in hosted guide API for test/xmltv-import-api.check.sh.

  GET /day/<YYYY-MM-DD>.xml    one day of XMLTV for channel alpha.api (4 programmes, every 6 h, UTC)
  GET /window.xml?from=&to=    10 days from `from`, whatever `to` says (a provider that over-publishes),
                               with an ETag and If-None-Match -> 304

Behaviour comes from <dir>/state.json, re-read on every request:
  key        the x-api-key the API wants (401 with a JSON reason otherwise)
  fail       days (offset from today UTC) that answer 500
  missing    days that answer 404 (not published yet)
  drop       a title to leave out (to test removal)
Every request is appended to <dir>/log.txt as "<path> key=<x-api-key> inm=<if-none-match>".
"""
import datetime, hashlib, json, os, sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

DIR, PORT = sys.argv[1], int(sys.argv[2])

def state():
    try:
        with open(os.path.join(DIR, 'state.json')) as f: return json.load(f)
    except Exception: return {}

def day_xml(d, drop):
    out = []
    for h in (0, 6, 12, 18):
        s = datetime.datetime(d.year, d.month, d.day, h)
        e = s + datetime.timedelta(hours=6)
        off = (d - datetime.datetime.now(datetime.timezone.utc).date()).days
        title = f'Show D{off} H{h:02d}'
        if title == drop: continue
        out.append(f'<programme channel="alpha.api" start="{s:%Y%m%d%H%M%S} +0000" stop="{e:%Y%m%d%H%M%S} +0000"><title>{title}</title></programme>')
    return ''.join(out)

def doc(body):
    return ('<?xml version="1.0" encoding="UTF-8"?><tv><channel id="alpha.api"><display-name>Alpha API</display-name></channel>' + body + '</tv>').encode()

class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def send(self, code, body=b'', ctype='application/xml', extra=None):
        self.send_response(code)
        self.send_header('content-type', ctype)
        for k, v in (extra or {}).items(): self.send_header(k, v)
        self.send_header('content-length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    def do_GET(self):
        st = state()
        u = urlparse(self.path)
        with open(os.path.join(DIR, 'log.txt'), 'a') as f:
            f.write(f"{u.path}?{u.query} key={self.headers.get('x-api-key')} inm={self.headers.get('if-none-match')}\n")
        if self.headers.get('x-api-key') != st.get('key', 'k1'):
            return self.send(401, b'{"message":"invalid api key"}', 'application/json')
        today = datetime.datetime.now(datetime.timezone.utc).date()
        if u.path.startswith('/day/'):
            d = datetime.date.fromisoformat(u.path[5:15])
            off = (d - today).days
            if off in st.get('fail', []): return self.send(500, b'{"message":"upstream exploded"}', 'application/json')
            if off in st.get('missing', []): return self.send(404, b'{"message":"day not published yet"}', 'application/json')
            return self.send(200, doc(day_xml(d, st.get('drop'))))
        if u.path == '/window.xml':
            start = datetime.date.fromisoformat(parse_qs(u.query)['from'][0])
            body = doc(''.join(day_xml(start + datetime.timedelta(days=i), st.get('drop')) for i in range(10)))
            tag = '"' + hashlib.sha1(body).hexdigest()[:16] + '"'
            if self.headers.get('if-none-match') == tag: return self.send(304, b'', extra={'etag': tag})
            return self.send(200, body, extra={'etag': tag})
        self.send(404, b'{"message":"no such route"}', 'application/json')

ThreadingHTTPServer(('127.0.0.1', PORT), H).serve_forever()
