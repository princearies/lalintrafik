#!/usr/bin/env python3
"""Deploy worker melalui REST API Cloudflare.

Dipakai kerana `wrangler deploy` gagal pada panggilan /memberships
(token tiada `User -> User Details -> Read`), manakala REST API
berfungsi dengan baik — token ini punya kebenaran Workers penuh.

Bundle dijana dahulu dengan:
    npx wrangler deploy --dry-run --outdir=dist-bundle
"""
import json
import os
import sys
import urllib.request
import uuid

ACC = "2c48feaf73f0023e94ead812fcb5f01e"
NAME = "lalintrafik"
DBID = "ffbfab4a-b643-4b04-9274-b06e0402b7fc"
BUNDLE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "dist-bundle", "index.js")

metadata = {
    "main_module": "index.js",
    "compatibility_date": "2026-01-01",
    "compatibility_flags": ["nodejs_compat"],
    "bindings": [
        {"type": "d1", "name": "DB", "id": DBID},
        {"type": "durable_object_namespace", "name": "GRID", "class_name": "GridDO"},
        {
            "type": "plain_text",
            "name": "OSRM_BASE_URL",
            "text": "https://router.project-osrm.org/route/v1/driving",
        },
        {"type": "plain_text", "name": "MAX_RADIUS_M", "text": "5000"},
        {"type": "plain_text", "name": "MAX_LIMIT", "text": "200"},
        {"type": "plain_text", "name": "DEFAULT_LIMIT", "text": "50"},
        {"type": "plain_text", "name": "DEFAULT_TTL_MS", "text": "3600000"},
        {"type": "plain_text", "name": "MAX_PEERS_PER_CELL", "text": "500"},
    ],
    "migrations": {"tag": "v1", "new_sqlite_classes": ["GridDO"]},
    "triggers": {"crons": ["*/5 * * * *"]},
    "observability": {"enabled": True},
}

src = open(BUNDLE, "rb").read()
print(f"bundle: {len(src)} bait")

boundary = "----hermes" + uuid.uuid4().hex
body = b""
head = (
    f"--{boundary}\r\n"
    'Content-Disposition: form-data; name="metadata"\r\n'
    "Content-Type: application/json\r\n\r\n"
).encode()
body += head + json.dumps(metadata).encode() + b"\r\n"
mod = (
    f"--{boundary}\r\n"
    'Content-Disposition: form-data; name="index.js"; filename="index.js"\r\n'
    "Content-Type: application/javascript+module\r\n\r\n"
).encode()
body += mod + src + b"\r\n"
body += f"--{boundary}--\r\n".encode()

url = f"https://api.cloudflare.com/client/v4/accounts/{ACC}/workers/scripts/{NAME}"
req = urllib.request.Request(
    url,
    data=body,
    headers={
        "Authorization": f"Bearer {os.environ['CLOUDFLARE_API_TOKEN'].strip()}",
        "Content-Type": f"multipart/form-data; boundary={boundary}",
    },
    method="PUT",
)

try:
    with urllib.request.urlopen(req, timeout=300) as r:
        out = json.load(r)
except urllib.error.HTTPError as e:
    print("HTTP", e.code)
    print(e.read().decode()[:2000])
    sys.exit(1)

print("success:", out.get("success"))
if out.get("errors"):
    print("errors:", json.dumps(out["errors"], indent=2)[:2000])
    sys.exit(1)
res = out.get("result") or {}
print("id:", res.get("id"))
print("modified_on:", res.get("modified_on"))
print("usage_model:", res.get("usage_model"))
