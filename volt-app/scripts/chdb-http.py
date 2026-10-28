#!/usr/bin/env python3
# ============================================================================
#  A STAND-IN CLICKHOUSE SERVER FOR THE CHECKS (build queue 2.11).
#
#  The ClickHouse store (src/services/qoe/clickhouse.ts) talks to ClickHouse's
#  HTTP interface. Where no ClickHouse server can be installed (the build
#  container, a laptop without Docker), this serves the part of that
#  interface the store uses from chDB, which is the ClickHouse engine itself
#  as a Python library (pip install chdb): the same SQL, the same table
#  engines, merges and functions, so the report queries and their timings
#  are ClickHouse's. What it cannot do is replicate: ReplicatedMergeTree
#  needs ClickHouse Keeper and a second server, so the replica drill
#  (scripts/clickhouse-drill.ts) needs a real cluster.
#
#    python3 scripts/chdb-http.py --port 18123 [--path /tmp/ch]
#
#  POST / with the statement in the body (an INSERT's rows after it), the
#  database and settings as query parameters, as ClickHouse takes them.
#  GET /ping answers "Ok." like the real server. One statement at a time
#  (chDB is one session); requests queue.
# ============================================================================
import argparse, threading, re
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

from chdb import session as chs

ap = argparse.ArgumentParser()
ap.add_argument('--port', type=int, default=18123)
ap.add_argument('--path', default='')
args = ap.parse_args()

sess = chs.Session(args.path) if args.path else chs.Session()
lock = threading.Lock()
SETTING = re.compile(r'^[a-z_]+$')
SKIP = {'database', 'query', 'default_format'}


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def reply(self, code, body: bytes, ctype='text/plain; charset=utf-8'):
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        u = urlparse(self.path)
        if u.path in ('/ping', '/'):
            q = parse_qs(u.query)
            if 'query' not in q:
                return self.reply(200, b'Ok.\n')
            return self.run(q, q['query'][0])
        self.reply(404, b'not found')

    def do_POST(self):
        u = urlparse(self.path)
        q = parse_qs(u.query)
        n = int(self.headers.get('Content-Length') or 0)
        body = self.rfile.read(n).decode('utf-8') if n else ''
        sql = (q['query'][0] + '\n' + body) if 'query' in q else body
        self.run(q, sql)

    def run(self, q, sql):
        db = q.get('database', [None])[0]
        sets = [(k, v[0]) for k, v in q.items() if k not in SKIP and SETTING.match(k)]
        try:
            with lock:
                for k, v in sets:
                    val = v if re.match(r'^-?\d+(\.\d+)?$', v) else "'" + v.replace("'", "\\'") + "'"
                    sess.query(f'SET {k} = {val}')
                if db:
                    sess.query(f'USE {db}')
                else:
                    sess.query('USE default')
                stmt = sql.strip()
                m = re.search(r'\bFORMAT\s+(\w+)\s*$', stmt) if not stmt.upper().startswith('INSERT') else None
                if m:
                    fmt = m.group(1)
                    res = sess.query(stmt[:m.start()].rstrip().rstrip(';'), fmt)
                else:
                    res = sess.query(stmt, 'TabSeparated')
                out = res.bytes() if res is not None else b''
            self.reply(200, out or b'')
        except Exception as e:  # ClickHouse answers SQL errors with 500 and the message
            self.reply(500, str(e).encode('utf-8', 'replace'))


ThreadingHTTPServer(('127.0.0.1', args.port), H).serve_forever()
