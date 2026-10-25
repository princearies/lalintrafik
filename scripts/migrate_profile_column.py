#!/usr/bin/env python3
"""Tambah lajur `gender` pada jadual `users` di D1 sebenar.

Skrip ini DIPERTIMBANGKAN dan TIDAK MEMADAMKAN apa-apa:

  * `PRAGMA table_info(users)` dahulu — jika lajur sudah wujud, tiada
    apa-apa dilakukan. Jalan dua kali adalah selamat.
  * `ALTER TABLE ... ADD COLUMN` hanya menambah lajur baharu. Ia TIDAK
    menyentuh baris sedia ada; setiap baris mendapat `NULL` untuk lajur
    itu, yang bermaksud "tidak dinyatakan".
  * Tiada DROP, tiada UPDATE, tiada penulisan semula jadual.

Jalankan:
    CLOUDFLARE_API_TOKEN=... python scripts/migrate_profile_column.py

Token mesti diambil dari VPS `~/workspace/web3-agent/.env`.
"""
import json
import os
import sys
import urllib.request
from os import path

ACC = "2c48feaf73f0023e94ead812fcb5f01e"
DBID = "ab655b48-8b45-4fb3-a55c-70210837344d"
TOKEN = os.environ["CLOUDFLARE_API_TOKEN"].strip()

# CHECK yang sama seperti db/schema.sql — supaya D1 sebenar dan
# pangkalan ujian setempat tidak pernah terbeza.
ADD_GENDER = (
    "ALTER TABLE users ADD COLUMN gender TEXT "
    "CHECK (gender IN ('MALE','FEMALE','UNSPECIFIED'))"
)


def query(sql: str) -> dict:
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


# ---------- 1. semak keadaan semasa ----------
cols = query("PRAGMA table_info(users)")
if not cols.get("success"):
    print("GAGAL membaca skema:", json.dumps(cols.get("errors"), indent=2))
    sys.exit(1)

rows = (cols.get("result") or [{}])[0].get("results") or []
names = [c.get("name") for c in rows]
print("kolom users sedia ada:", ", ".join(names))

if "gender" in names:
    print("LALUAN: lajur `gender` sudah wujud — tiada tindakan.")
    sys.exit(0)

# ---------- 2. tambah lajur ----------
print("menambah lajur `gender`…")
out = query(ADD_GENDER)
if not out.get("success"):
    print("GAGAL:", json.dumps(out.get("errors"), indent=2))
    sys.exit(1)
print("meta:", json.dumps((out.get("result") or [{}])[0].get("meta", {})))

# ---------- 3. sahkan ----------
after = query("PRAGMA table_info(users)")
arows = (after.get("result") or [{}])[0].get("results") or []
anames = [c.get("name") for c in arows]
print("kolom users selepas:", ", ".join(anames))
if "gender" not in anames:
    print("GAGAL: lajur `gender` tidak wujud selepas ALTER.")
    sys.exit(1)

# buktikan CHECK benar-benar aktif — cuba masukkan nilai haram
chk = query(
    "INSERT INTO users (id, device_id, gender, created_at, last_seen_at) "
    "VALUES ('__probe__', '__probe_device__', 'ALIEN', 1, 1)"
)
if chk.get("success"):
    print("AMARAN: nilai gender haram DITERIMA — CHECK tidak aktif?")
    # bersihkan baris probe
    query("DELETE FROM users WHERE device_id = '__probe_device__'")
    sys.exit(1)

print("CHECK disahkan: gender haram ditolak oleh D1 sebenar.")
print("SELESAI.")
