"""Eingebauter Embedding-Dienst von postbuch.net.

OpenAI-kompatibel: POST /v1/embeddings, GET /v1/models, dazu GET /health.
Modell: Snowflake arctic-embed-m-v2.0 (768 Dimensionen, int8), Tokenizer:
SentencePiece-Modell von xlm-roberta-base. Beides kommt beim Image-Build aus
gepinnten Quellen (siehe Dockerfile).

Speicher ist auf einem Raspberry Pi mit 1 GB die knappste Ressource:
- Das Modell wird erst bei der ersten Anfrage geladen und nach IDLE_S Sekunden
  ohne Anfrage wieder entladen. Ein Dienst, den niemand benutzt (anderer
  Embedding-Dienst gewählt, laufender Build), belegt nur den Interpreter.
- Die Gewichte liegen extern und seitenausgerichtet (repack.py); onnxruntime
  blendet sie per mmap ein, statt sie in den Prozessspeicher zu kopieren.
- Ohne CPU-Speicherarena gibt onnxruntime Zwischenpuffer nach jeder Anfrage
  zurück, statt sie für die größte bisher gesehene Eingabe vorzuhalten.
- Eingaben werden auf MAX_LEN Token gekürzt. Bei 512 war in den Messungen
  kein Qualitätsverlust gegenüber der vollen Länge messbar, die Spitzenlast
  sinkt deutlich.
"""
import ctypes
import gc
import json
import os
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
import sentencepiece as spm

MODELL_DIR = os.environ.get("MODELL_DIR", "/modell")
NAME = "snowflake-arctic-embed-m-v2.0"
DIM = 768
MAX_LEN = int(os.environ.get("MAX_LEN", "512"))
IDLE_S = int(os.environ.get("IDLE_S", "600"))
MAX_BODY = int(os.environ.get("MAX_BODY", str(1 << 20)))
MAX_EINGABEN = int(os.environ.get("MAX_EINGABEN", "64"))
PORT = int(os.environ.get("PORT", "8080"))


def threads():
    wert = os.environ.get("THREADS")
    if wert:
        return max(1, int(wert))
    # Nicht os.cpu_count(): das zählt die Kerne des Hosts, auch wenn der
    # Container auf weniger beschränkt ist. Mehr als vier bringen auf einem
    # Pi nichts.
    return max(1, min(4, len(os.sched_getaffinity(0))))


# SentencePiece mit fairseq-Versatz wie XLMRobertaTokenizer:
# <s>=0 <pad>=1 </s>=2 <unk>=3, alle übrigen IDs um eins verschoben.
_sp = spm.SentencePieceProcessor(model_file=os.path.join(MODELL_DIR, "sentencepiece.bpe.model"))


def tokenisiere(text):
    ids = [(i + 1) if i != 0 else 3 for i in _sp.encode(text)][:MAX_LEN - 2]
    return [0] + ids + [2]


_sperre = threading.Lock()
_sitzung = None
_letzte_nutzung = 0.0


def _lade():
    import onnxruntime as ort
    opts = ort.SessionOptions()
    opts.intra_op_num_threads = threads()
    opts.inter_op_num_threads = 1
    opts.enable_cpu_mem_arena = False
    sitzung = ort.InferenceSession(os.path.join(MODELL_DIR, "model.onnx"), opts,
                                   providers=["CPUExecutionProvider"])
    namen = [o.name for o in sitzung.get_outputs()]
    ausgabe = "sentence_embedding" if "sentence_embedding" in namen else namen[0]
    eingaben = {i.name for i in sitzung.get_inputs()}
    print(f"Modell geladen ({threads()} Threads)", flush=True)
    return sitzung, ausgabe, eingaben


def _entlade():
    global _sitzung
    _sitzung = None
    gc.collect()
    try:
        # glibc gibt freigegebenen Heap sonst nicht an das System zurück.
        ctypes.CDLL("libc.so.6").malloc_trim(0)
    except OSError:
        pass
    print("Modell nach Leerlauf entladen", flush=True)


def _waechter():
    while True:
        time.sleep(30)
        with _sperre:
            if _sitzung is not None and time.monotonic() - _letzte_nutzung > IDLE_S:
                _entlade()


def bette_ein(texte):
    global _sitzung, _letzte_nutzung
    with _sperre:
        if _sitzung is None:
            _sitzung = _lade()
        sitzung, ausgabe, eingaben = _sitzung
        vektoren, token = [], 0
        for text in texte:
            tids = tokenisiere(text)
            token += len(tids)
            ids = np.array([tids], dtype=np.int64)
            feed = {"input_ids": ids}
            if "attention_mask" in eingaben:
                feed["attention_mask"] = np.ones_like(ids)
            if "token_type_ids" in eingaben:
                feed["token_type_ids"] = np.zeros_like(ids)
            out = sitzung.run([ausgabe], feed)[0]
            v = out[0] if out.ndim == 2 else out[0, 0]
            vektoren.append((v / np.linalg.norm(v)).astype(float).tolist())
        _letzte_nutzung = time.monotonic()
        return vektoren, token


class Handler(BaseHTTPRequestHandler):
    server_version = "postbuch-embedding"
    sys_version = ""

    def log_message(self, *args):
        pass

    def antwort(self, status, obj):
        roh = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(roh)))
        self.end_headers()
        self.wfile.write(roh)

    def fehler(self, status, text):
        self.antwort(status, {"error": {"message": text, "type": "invalid_request_error"}})

    def do_GET(self):
        if self.path == "/health":
            return self.antwort(200, {"status": "ok", "modell": NAME, "geladen": _sitzung is not None})
        if self.path in ("/v1/models", "/models"):
            return self.antwort(200, {"object": "list", "data": [{"id": NAME, "object": "model", "owned_by": "postbuch"}]})
        self.fehler(404, "Unbekannter Pfad.")

    def do_POST(self):
        if self.path not in ("/v1/embeddings", "/embeddings"):
            return self.fehler(404, "Unbekannter Pfad.")
        try:
            laenge = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            return self.fehler(400, "Ungültige Länge.")
        if laenge <= 0 or laenge > MAX_BODY:
            return self.fehler(413, f"Anfrage leer oder größer als {MAX_BODY} Bytes.")
        try:
            body = json.loads(self.rfile.read(laenge))
        except (ValueError, UnicodeDecodeError):
            return self.fehler(400, "Kein gültiges JSON.")
        if not isinstance(body, dict):
            return self.fehler(400, "Kein gültiges JSON-Objekt.")
        modell = body.get("model")
        if modell not in (None, NAME):
            return self.fehler(404, f"Modell {modell!r} ist nicht vorhanden; verfügbar ist {NAME}.")
        eingabe = body.get("input")
        texte = eingabe if isinstance(eingabe, list) else [eingabe]
        if not texte or len(texte) > MAX_EINGABEN or not all(isinstance(t, str) and t for t in texte):
            return self.fehler(400, f"input muss ein Text oder eine Liste von 1 bis {MAX_EINGABEN} Texten sein.")
        try:
            vektoren, token = bette_ein(texte)
        except Exception as err:  # noqa: BLE001 – Fehler gehen als JSON an die App
            print("Fehler beim Einbetten:", err, flush=True)
            return self.antwort(500, {"error": {"message": "Einbetten fehlgeschlagen.", "type": "server_error"}})
        self.antwort(200, {
            "object": "list", "model": NAME,
            "data": [{"object": "embedding", "index": i, "embedding": v} for i, v in enumerate(vektoren)],
            "usage": {"prompt_tokens": token, "total_tokens": token},
        })


if __name__ == "__main__":
    threading.Thread(target=_waechter, daemon=True).start()
    print(f"Embedding-Dienst bereit auf Port {PORT} ({NAME}, {DIM} Dimensionen, "
          f"Modell lädt bei der ersten Anfrage)", flush=True)
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
