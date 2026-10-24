"""Lädt eine Datei streamend herunter und prüft ihre SHA-256.

Aufruf: holen.py <url> <ziel> <sha256>
Drei Versuche, weil Hugging Face auf Heimservern gelegentlich kurz hängt.
Eine abweichende Prüfsumme bricht sofort ab, ohne Wiederholung.
"""
import hashlib
import os
import sys
import time
import urllib.request

url, ziel, soll = sys.argv[1], sys.argv[2], sys.argv[3].lower()
for versuch in range(1, 4):
    try:
        h = hashlib.sha256()
        with urllib.request.urlopen(url, timeout=60) as antwort, open(ziel + ".teil", "wb") as f:
            while block := antwort.read(1 << 20):
                h.update(block)
                f.write(block)
        break
    except OSError as err:
        if versuch == 3:
            sys.exit(f"Download fehlgeschlagen: {url}: {err}")
        print(f"Download unterbrochen ({err}), neuer Versuch in {versuch * 10} s", flush=True)
        time.sleep(versuch * 10)
if h.hexdigest() != soll:
    os.remove(ziel + ".teil")
    sys.exit(f"Prüfsumme stimmt nicht: {url}\n  erwartet {soll}\n  erhalten {h.hexdigest()}")
os.replace(ziel + ".teil", ziel)
print(f"{os.path.basename(ziel)}: {os.path.getsize(ziel) // 1048576} MB, Prüfsumme in Ordnung", flush=True)
