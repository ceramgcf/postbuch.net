"""Lädt eine Datei streamend herunter und prüft ihre SHA-256.

Aufruf: holen.py <url> <ziel> <sha256>
Als Modul: hole(url, ziel, sha256, fortschritt=None) – fortschritt(geholt, gesamt)
wird je MB aufgerufen (der Server meldet so den Download-Stand).
Drei Versuche, weil Hugging Face auf Heimservern gelegentlich kurz hängt.
Eine abweichende Prüfsumme bricht sofort ab, ohne Wiederholung.
"""
import hashlib
import os
import sys
import time
import urllib.request


class PruefsummenFehler(Exception):
    pass


def hole(url, ziel, soll, fortschritt=None):
    soll = soll.lower()
    for versuch in range(1, 4):
        try:
            h = hashlib.sha256()
            geholt = 0
            with urllib.request.urlopen(url, timeout=60) as antwort, open(ziel + ".teil", "wb") as f:
                gesamt = int(antwort.headers.get("Content-Length") or 0)
                while block := antwort.read(1 << 20):
                    h.update(block)
                    f.write(block)
                    geholt += len(block)
                    if fortschritt:
                        fortschritt(geholt, gesamt)
            break
        except OSError as err:
            if versuch == 3:
                raise OSError(f"Download fehlgeschlagen: {url}: {err}") from err
            print(f"Download unterbrochen ({err}), neuer Versuch in {versuch * 10} s", flush=True)
            time.sleep(versuch * 10)
    if h.hexdigest() != soll:
        os.remove(ziel + ".teil")
        raise PruefsummenFehler(f"Prüfsumme stimmt nicht: {url}\n  erwartet {soll}\n  erhalten {h.hexdigest()}")
    os.replace(ziel + ".teil", ziel)
    print(f"{os.path.basename(ziel)}: {os.path.getsize(ziel) // 1048576} MB, Prüfsumme in Ordnung", flush=True)


if __name__ == "__main__":
    try:
        hole(sys.argv[1], sys.argv[2], sys.argv[3])
    except (OSError, PruefsummenFehler) as err:
        sys.exit(str(err))
