#!/usr/bin/env python3
"""Hantar db/schema.sql ke D1 melalui REST API Cloudflare.

Dipakai kerana `wrangler d1 execute` memerlukan kebenaran
`User -> User Details -> Read` (panggilan /memberships) yang tiada pada
token ini, manakala REST API bekerja dengan baik.
"""
import json
import os
import sys
import urllib.request
from os import path

ACC = "2c48feaf73f0023e94ead812fcb5f01e"
DBID = "ab655b48-8b45-4fb3-a55c-70210837344d"
TOKEN = os.environ["CLOUDFLARE_API_TOKEN"].strip()
SCHEMA = path.join(path.dirname(path.dirname(os.path.abspath(__file__))), "db", "schema.sql")

sql = open(SCHEMA, encoding="utf-8").read()
print(f"schema: {len(sql)} aksara, {sql.count(';')} titik koma")

body = json.dumps({"sql": sql}).encode()
req = urllib.request.Request(
    f"https://api.cloudflare.com/client/v4/accounts/{ACC}/d1/database/{DBID}/query",
    data=body,
    headers={
        "Authorization": f"Bearer {TOKEN}",
        "Content-Type": "application/json",
    },
    method="POST",
)
with urllib.request.urlopen(req, timeout=120) as r:
    out = json.load(r)

print("success:", out.get("success"))
if out.get("errors"):
    print("errors:", json.dumps(out["errors"], indent=2))
    sys.exit(1)

res = (out.get("result") or [{}])[0]
print("meta:", json.dumps(res.get("meta", {})))
