"""A stand-in for CloudFront in front of a private bucket (origin access control):
GET /<key> is a signed GetObject, returned with the object's Content-Type and
Cache-Control. For dev/fast-prod-e2e.sh only."""
import os, sys
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
import boto3
s3 = boto3.client("s3", endpoint_url=os.environ["AWS_ENDPOINT_URL"])
BUCKET = os.environ["S3_BUCKET"]

class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        key = self.path.split("?")[0].lstrip("/")
        try:
            o = s3.get_object(Bucket=BUCKET, Key=key)
        except Exception:
            self.send_response(404); self.send_header("Access-Control-Allow-Origin", "*"); self.end_headers(); return
        body = o["Body"].read()
        self.send_response(200)
        self.send_header("Content-Type", o.get("ContentType", "application/octet-stream"))
        if o.get("CacheControl"): self.send_header("Cache-Control", o["CacheControl"])
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers(); self.wfile.write(body)

ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1])), H).serve_forever()
