#!/usr/bin/env python3
"""Tukar frontend/index.html kepada src/frontendHtml.ts.

Pelayan tidak mempunyai direktori statik, jadi HTML mesti dibawa di dalam
bundle. Fail ini dijana — jangan edit `src/frontendHtml.ts` secara manual,
edit `frontend/index.html` dan jalankan semula skrip ini.

`json.dumps` dipakai (bukan raw string atau template literal) supaya petikan,
baris baharu dan aksara `<`/`>` tidak boleh memecahkan kod di sekelilingnya.
"""
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "frontend", "index.html")
OUT = os.path.join(ROOT, "src", "frontendHtml.ts")

html = open(SRC, encoding="utf-8").read()

# Sanity: pastikan ia memang HTML.
if "<!doctype html" not in html.lower():
    sys.exit(f"{SRC} tidak kelihatan seperti HTML")

with open(OUT, "w", encoding="utf-8") as f:
    f.write("// Dijana oleh scripts/build_frontend_ts.py — jangan edit manual.\n")
    f.write("// Sumber: frontend/index.html\n")
    f.write("export const FRONTEND_HTML: string =\n")
    f.write("  " + json.dumps(html, ensure_ascii=False) + ";\n")

print(f"frontendHtml.ts: {len(html)} aksara HTML -> {os.path.getsize(OUT)} bait")
