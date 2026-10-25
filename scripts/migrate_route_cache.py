#!/usr/bin/env python3
"""Wujudkan semula jadual `route_cache` dengan skema koordinat baharu.

Skema lama (key TEXT PRIMARY KEY, payload, expires_at) tidak lagi
serasi dengan kod. Jadual ini adalah CACHE — keseluruhannya boleh
dijana semula dengan memanggil OSRM sekali lagi — jadi menggantikannya
tidak kehilangan data yang tidak boleh dipulihkan.

JAANGAN jalankan ini pada jadual yang menyimpan data pengguna.
"""
import json
import os
import sys
import urllib.request

ACC = "2c48feaf73f0023e94ead812fcb5f01e"
DBID = "ab655b48-8b45-4fb3-a55c-70210837344d"
TOKEN = os.environ["CLOUDFLARE_API_TOKEN"].strip()

DDL = """
DROP TABLE IF EXISTS route_cache;

CREATE TABLE route_cache (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  origin_lat  REAL NOT NULL,
  origin_lng  REAL NOT NULL,
  dest_lat    REAL NOT NULL,
  dest_lng    REAL NOT NULL,
  route_data  TEXT NOT NULL,
  distance    REAL,
  duration    REAL,
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_route_coords
  ON route_cache (origin_lat, origin_lng, dest_lat, dest_lng);

CREATE INDEX IF NOT EXISTS idx_route_cache_created
  ON route_cache (created_at);
"""


def q(sql):
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
        return json.load(r)


before = q("SELECT COUNT(*) AS n FROM route_cache")["result"][0]["results"][0]["n"]
print(f"baris route_cache sedia ada: {before} (akan dijana semula dari OSRM)")

out = q(DDL)
print("success:", out.get("success"))
if out.get("errors"):
    print("errors:", json.dumps(out["errors"], indent=2))
    sys.exit(1)

info = q("SELECT name FROM sqlite_master WHERE type='table' AND name='route_cache'")
print("jadual route_cache wujud:", bool(info["result"][0]["results"]))

cols = [c["name"] for c in q("PRAGMA table_info(route_cache)")["result"][0]["results"]]
print("kolom:", ", ".join(cols))
for want in ["id", "origin_lat", "origin_lng", "dest_lat", "dest_lng",
             "route_data", "distance", "duration", "created_at"]:
    if want not in cols:
        print("KURANG kolom:", want)
        sys.exit(1)

idx = [c["name"] for c in q(
    "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='route_cache'",
)["result"][0]["results"]]
print("indeks:", ", ".join(idx))
