"""Eingebauter Embedding-Dienst von postbuch.net.

OpenAI-kompatibel: POST /v1/embeddings, GET /v1/models, dazu GET /health,
GET /v1/modelle (Zustand je Modell) und POST /v1/modelle/holen (Download
anstoßen). Das Feld `model` der Anfrage wählt das Modell:

- snowflake-arctic-embed-m-v2.0 (768 Dimensionen, int8, ONNX) ist im Image
  enthalten und Vorgabe, wenn `model` fehlt. Tokenizer: SentencePiece-Modell
  von xlm-roberta-base.
- voyage-4-nano (2048 Dimensionen) und embeddinggemma-2 (768 Dimensionen)
  laufen als GGUF über llama.cpp (llama-server als Unterprozess auf
  localhost). Ihre Dateien kommen erst bei Bedarf aus gepinnten Quellen mit
  Prüfsumme in das Volume unter DATEN_DIR. Sie brauchen ein Gerät mit
  mindestens 2 GB Arbeitsspeicher (RAM_MIN_MB, gemessen an MemTotal).

Speicher ist auf einem Raspberry Pi die knappste Ressource:
- Ein Modell wird erst bei der ersten Anfrage geladen und nach IDLE_S Sekunden
  ohne Anfrage wieder entladen. Ein Dienst, den niemand benutzt (anderer
  Embedding-Dienst gewählt, laufender Build), belegt nur den Interpreter.
  Ein GGUF-Modell ersetzt ein anderes, statt daneben zu laufen.
- Die Arctic-Gewichte liegen extern und seitenausgerichtet (repack.py);
  onnxruntime blendet sie per mmap ein, statt sie zu kopieren.
- Ohne CPU-Speicherarena gibt onnxruntime Zwischenpuffer nach jeder Anfrage
  zurück, statt sie für die größte bisher gesehene Eingabe vorzuhalten.
- Arctic-Eingaben werden auf MAX_LEN Token gekürzt. Bei 512 war in den
  Messungen kein Qualitätsverlust gegenüber der vollen Länge messbar. Für
  llama.cpp gilt die Batchgröße; zu lange Texte lehnt es ab, die App kürzt
  dann selbst nach.
"""
import ctypes
import gc
import json
import os
import subprocess
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
import sentencepiece as spm

from holen import hole

MODELL_DIR = os.environ.get("MODELL_DIR", "/modell")
DATEN_DIR = os.environ.get("DATEN_DIR", "/daten")
LLAMA_DIR = os.environ.get("LLAMA_DIR", "/opt/llama")
LLAMA_PORT = int(os.environ.get("LLAMA_PORT", "8081"))
MAX_LEN = int(os.environ.get("MAX_LEN", "512"))
IDLE_S = int(os.environ.get("IDLE_S", "600"))
MAX_BODY = int(os.environ.get("MAX_BODY", str(1 << 20)))
MAX_EINGABEN = int(os.environ.get("MAX_EINGABEN", "64"))
PORT = int(os.environ.get("PORT", "8080"))
# 2-GB-Geräte melden nach Abzug von Firmware und Kernel etwas weniger als 2048 MB.
RAM_MIN_MB = int(os.environ.get("RAM_MIN_MB", "1800"))

ARCTIC = "snowflake-arctic-embed-m-v2.0"
HF = "https://huggingface.co"

# Gepinnte Revisionen; Prüfsumme und Größe schützen gegen ausgetauschte Dateien.
# Lizenzen der Grundmodelle: Apache 2.0 (THIRD-PARTY-NOTICES.md).
MODELLE = {
    ARCTIC: {"dim": 768, "art": "onnx"},
    "voyage-4-nano": {
        "dim": 2048, "art": "gguf",
        "datei": "voyage-4-nano-q8_0.gguf",
        "url": f"{HF}/jsonMartin/voyage-4-nano-gguf/resolve/75e62c7dba5ee8156717a56920976ab128b8c693/voyage-4-nano-q8_0.gguf",
        "sha256": "d0e430fe24faba10f5bc6dd4f896e1efd0e6d65d7f0cf686a500d48cac274a4a",
        "bytes": 371900384,
        # Voyage 4 Nano rechnet bidirektional, das GGUF ist als Qwen3 (kausal)
        # markiert. Die lineare Projektion 1024 → 2048 gehört zum Modell.
        "args": ["--override-kv", "qwen3.attention.causal=bool:false"],
        "projektion": {
            "datei": "voyage-4-nano-linear.bin",
            "url": f"{HF}/jsonMartin/voyage-4-nano-gguf/resolve/75e62c7dba5ee8156717a56920976ab128b8c693/voyage-4-nano-linear.bin",
            "sha256": "6ee040fad75c000b21f8beef7584e8962ec76913639f2f46ae84b9c4c1fd7dbf",
            "bytes": 8388608,
            "form": (2048, 1024),
        },
    },
    "embeddinggemma-2": {
        "dim": 768, "art": "gguf",
        "datei": "embeddinggemma-2-q6_k.gguf",
        "url": f"{HF}/prithivMLmods/EmbeddingGemma-2-GGUF/resolve/ca17235333e975cb5044987c18316b83258b57e4/embeddinggemma-2.Q6_K.gguf",
        "sha256": "b279ed4cae655b06a2e46fb277ef333dc4e6ba4315a47e021b870c1d4b9b2f1a",
        "bytes": 245764384,
        "args": [],
    },
}


def threads():
    wert = os.environ.get("THREADS")
    if wert:
        return max(1, int(wert))
    # Nicht os.cpu_count(): das zählt die Kerne des Hosts, auch wenn der
    # Container auf weniger beschränkt ist. Mehr als vier bringen auf einem
    # Pi nichts.
    return max(1, min(4, len(os.sched_getaffinity(0))))


def ram_mb():
    try:
        with open("/proc/meminfo") as f:
            for zeile in f:
                if zeile.startswith("MemTotal:"):
                    return int(zeile.split()[1]) // 1024
    except OSError:
        pass
    return 0


# ── Dateien der GGUF-Modelle ────────────────────────────────────────────────

_downloads = {}  # Modell → {"zustand": "laedt"|"fehler", "prozent": int, "fehler": str}
_download_sperre = threading.Lock()


def _dateien(name):
    m = MODELLE[name]
    teile = [(m["datei"], m["url"], m["sha256"], m["bytes"])]
    if "projektion" in m:
        p = m["projektion"]
        teile.append((p["datei"], p["url"], p["sha256"], p["bytes"]))
    return teile


def _vorhanden(name):
    # Die Größe genügt hier: hole() benennt erst nach geprüfter Summe um.
    return all(os.path.isfile(os.path.join(DATEN_DIR, d)) and os.path.getsize(os.path.join(DATEN_DIR, d)) == b
               for d, _, _, b in _dateien(name))


def zustand(name):
    m = MODELLE[name]
    info = {"id": name, "dim": m["dim"], "art": m["art"]}
    if m["art"] == "onnx":
        return {**info, "zustand": "bereit"}
    info["groesseMb"] = sum(b for *_, b in _dateien(name)) // 1048576
    info["ramMinMb"] = RAM_MIN_MB
    if ram_mb() < RAM_MIN_MB:
        return {**info, "zustand": "zu_wenig_ram"}
    if _vorhanden(name):
        return {**info, "zustand": "bereit"}
    with _download_sperre:
        d = dict(_downloads.get(name) or {"zustand": "fehlt"})
    return {**info, **d}


def _download(name):
    teile = _dateien(name)
    gesamt = sum(b for *_, b in teile)
    try:
        os.makedirs(DATEN_DIR, exist_ok=True)
        fertig = 0
        for datei, url, sha, groesse in teile:
            ziel = os.path.join(DATEN_DIR, datei)
            if not (os.path.isfile(ziel) and os.path.getsize(ziel) == groesse):
                def melde(geholt, _g, basis=fertig):
                    with _download_sperre:
                        _downloads[name]["prozent"] = min(99, (basis + geholt) * 100 // gesamt)
                hole(url, ziel, sha, melde)
            fertig += groesse
        with _download_sperre:
            _downloads.pop(name, None)
        print(f"Modell {name} heruntergeladen", flush=True)
    except Exception as err:  # noqa: BLE001 – Zustand geht an die App
        print(f"Download von {name} fehlgeschlagen: {err}", flush=True)
        with _download_sperre:
            _downloads[name] = {"zustand": "fehler", "prozent": 0, "fehler": str(err).splitlines()[0][:300]}


def starte_download(name):
    """Stößt den Download an, falls nötig; gibt den Zustand zurück."""
    z = zustand(name)
    if z["zustand"] not in ("fehlt", "fehler"):
        return z
    with _download_sperre:
        if (_downloads.get(name) or {}).get("zustand") == "laedt":
            return zustand(name)
        _downloads[name] = {"zustand": "laedt", "prozent": 0}
    threading.Thread(target=_download, args=(name,), daemon=True).start()
    return zustand(name)


# ── Arctic (ONNX) ───────────────────────────────────────────────────────────

# SentencePiece mit fairseq-Versatz wie XLMRobertaTokenizer:
# <s>=0 <pad>=1 </s>=2 <unk>=3, alle übrigen IDs um eins verschoben.
_sp = spm.SentencePieceProcessor(model_file=os.path.join(MODELL_DIR, "sentencepiece.bpe.model"))


def tokenisiere(text):
    ids = [(i + 1) if i != 0 else 3 for i in _sp.encode(text)][:MAX_LEN - 2]
    return [0] + ids + [2]


_sperre = threading.Lock()
_sitzung = None      # Arctic: (InferenceSession, Ausgabename, Eingabenamen)
_llama = None        # GGUF: {"name", "prozess", "projektion"}
_letzte_nutzung = 0.0


def _lade_arctic():
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
    print(f"Modell {ARCTIC} geladen ({threads()} Threads)", flush=True)
    return sitzung, ausgabe, eingaben


def _arctic(texte):
    global _sitzung
    if _sitzung is None:
        _sitzung = _lade_arctic()
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
    return vektoren, token


# ── GGUF über llama.cpp ─────────────────────────────────────────────────────

class LlamaFehler(Exception):
    def __init__(self, status, text):
        super().__init__(text)
        self.status = status


def _llama_url(pfad):
    return f"http://127.0.0.1:{LLAMA_PORT}{pfad}"


def _stoppe_llama():
    global _llama
    if _llama is None:
        return
    prozess = _llama["prozess"]
    prozess.terminate()
    try:
        prozess.wait(timeout=15)
    except subprocess.TimeoutExpired:
        prozess.kill()
        prozess.wait()
    print(f"Modell {_llama['name']} entladen", flush=True)
    _llama = None


def _starte_llama(name):
    global _llama
    m = MODELLE[name]
    with open(os.path.join(LLAMA_DIR, "lib", "LADER")) as f:
        lader = os.path.join(LLAMA_DIR, "lib", f.read().strip())
    # llama.cpp ist gegen eine neuere glibc gebaut als dieses Image; es läuft
    # deshalb mit der mitgebrachten (Dockerfile, Stufe llama).
    befehl = [lader, "--library-path", f"{LLAMA_DIR}/lib:{LLAMA_DIR}", os.path.join(LLAMA_DIR, "llama-server"),
              "-m", os.path.join(DATEN_DIR, m["datei"]), "--alias", name,
              "-t", str(threads()), "-c", "2048", "-b", "2048", "-ub", "2048",
              "--embedding", "--pooling", "mean", *m["args"],
              "--host", "127.0.0.1", "--port", str(LLAMA_PORT), "--log-disable"]
    prozess = subprocess.Popen(befehl, cwd=LLAMA_DIR, stdin=subprocess.DEVNULL)
    frist = time.monotonic() + 180
    while time.monotonic() < frist:
        if prozess.poll() is not None:
            raise RuntimeError(f"llama-server für {name} beendet (Code {prozess.returncode})")
        try:
            with urllib.request.urlopen(_llama_url("/health"), timeout=2) as r:
                if r.status == 200:
                    break
        except (OSError, urllib.error.HTTPError):
            pass
        time.sleep(0.5)
    else:
        prozess.kill()
        raise RuntimeError(f"llama-server für {name} startet nicht")
    projektion = None
    if "projektion" in m:
        p = m["projektion"]
        projektion = np.fromfile(os.path.join(DATEN_DIR, p["datei"]), dtype="<f4").reshape(p["form"])
    _llama = {"name": name, "prozess": prozess, "projektion": projektion}
    print(f"Modell {name} geladen ({threads()} Threads)", flush=True)


def _gguf(name, texte):
    global _sitzung
    if _llama is None or _llama["name"] != name or _llama["prozess"].poll() is not None:
        _stoppe_llama()
        if _sitzung is not None:
            _sitzung = None
            gc.collect()
        _starte_llama(name)
    anfrage = urllib.request.Request(
        _llama_url("/v1/embeddings"), data=json.dumps({"input": texte}).encode(),
        headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(anfrage, timeout=600) as r:
            daten = json.loads(r.read())
    except urllib.error.HTTPError as err:
        # Meldung durchreichen: „input is too large …“ lässt die App kürzen.
        try:
            text = json.loads(err.read()).get("error", {}).get("message") or str(err)
        except ValueError:
            text = str(err)
        raise LlamaFehler(err.code if err.code < 500 else 500, text) from err
    vektoren = []
    for d in sorted(daten["data"], key=lambda d: d["index"]):
        v = np.asarray(d["embedding"], dtype=np.float32)
        if _llama["projektion"] is not None:
            v = _llama["projektion"] @ v
        vektoren.append((v / np.linalg.norm(v)).astype(float).tolist())
    token = int((daten.get("usage") or {}).get("prompt_tokens") or 0)
    return vektoren, token


def _entlade():
    global _sitzung
    _sitzung = None
    _stoppe_llama()
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
            if (_sitzung is not None or _llama is not None) and time.monotonic() - _letzte_nutzung > IDLE_S:
                _entlade()


def bette_ein(texte, name=ARCTIC):
    global _letzte_nutzung
    with _sperre:
        if MODELLE[name]["art"] == "onnx":
            erg = _arctic(texte)
        else:
            erg = _gguf(name, texte)
        _letzte_nutzung = time.monotonic()
        return erg


def geladen():
    if _sitzung is not None:
        return ARCTIC
    return _llama["name"] if _llama is not None else None


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

    def fehler(self, status, text, typ="invalid_request_error", **extra):
        self.antwort(status, {"error": {"message": text, "type": typ, **extra}})

    def body(self):
        try:
            laenge = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            laenge = -1
        if laenge <= 0 or laenge > MAX_BODY:
            self.fehler(413, f"Anfrage leer oder größer als {MAX_BODY} Bytes.")
            return None
        try:
            body = json.loads(self.rfile.read(laenge))
        except (ValueError, UnicodeDecodeError):
            body = None
        if not isinstance(body, dict):
            self.fehler(400, "Kein gültiges JSON-Objekt.")
            return None
        return body

    def modell_aus(self, body):
        modell = body.get("model") or ARCTIC
        if modell not in MODELLE:
            self.fehler(404, f"Modell {modell!r} ist nicht vorhanden; verfügbar sind {', '.join(MODELLE)}.")
            return None
        return modell

    def do_GET(self):
        if self.path == "/health":
            return self.antwort(200, {"status": "ok", "modell": ARCTIC, "geladen": geladen()})
        if self.path in ("/v1/models", "/models"):
            return self.antwort(200, {"object": "list", "data": [
                {"id": n, "object": "model", "owned_by": "postbuch"} for n in MODELLE]})
        if self.path == "/v1/modelle":
            return self.antwort(200, {"ramMb": ram_mb(), "geladen": geladen(),
                                      "modelle": [zustand(n) for n in MODELLE]})
        self.fehler(404, "Unbekannter Pfad.")

    def do_POST(self):
        if self.path == "/v1/modelle/holen":
            body = self.body()
            modell = body is not None and self.modell_aus(body)
            if not modell:
                return None
            return self.antwort(200, starte_download(modell))
        if self.path not in ("/v1/embeddings", "/embeddings"):
            return self.fehler(404, "Unbekannter Pfad.")
        body = self.body()
        modell = body is not None and self.modell_aus(body)
        if not modell:
            return None
        z = zustand(modell)
        if z["zustand"] == "zu_wenig_ram":
            return self.fehler(400, f"Modell {modell} braucht ein Gerät mit mindestens 2 GB Arbeitsspeicher.",
                               code="zu_wenig_ram")
        if z["zustand"] != "bereit":
            z = starte_download(modell)
            if z["zustand"] == "fehler":
                return self.fehler(502, f"Modell {modell} ließ sich nicht herunterladen: {z.get('fehler')}",
                                   typ="server_error", code="download_fehler")
            return self.fehler(503, f"Modell {modell} wird heruntergeladen ({z.get('prozent', 0)} %).",
                               typ="server_error", code="modell_laedt")
        eingabe = body.get("input")
        texte = eingabe if isinstance(eingabe, list) else [eingabe]
        if not texte or len(texte) > MAX_EINGABEN or not all(isinstance(t, str) and t for t in texte):
            return self.fehler(400, f"input muss ein Text oder eine Liste von 1 bis {MAX_EINGABEN} Texten sein.")
        try:
            vektoren, token = bette_ein(texte, modell)
        except LlamaFehler as err:
            print("Fehler beim Einbetten:", err, flush=True)
            return self.fehler(err.status, str(err), typ="server_error" if err.status >= 500 else "invalid_request_error")
        except Exception as err:  # noqa: BLE001 – Fehler gehen als JSON an die App
            print("Fehler beim Einbetten:", err, flush=True)
            return self.fehler(500, "Einbetten fehlgeschlagen.", typ="server_error")
        self.antwort(200, {
            "object": "list", "model": modell,
            "data": [{"object": "embedding", "index": i, "embedding": v} for i, v in enumerate(vektoren)],
            "usage": {"prompt_tokens": token, "total_tokens": token},
        })


if __name__ == "__main__":
    threading.Thread(target=_waechter, daemon=True).start()
    print(f"Embedding-Dienst bereit auf Port {PORT} ({', '.join(MODELLE)}; "
          f"{ram_mb()} MB Arbeitsspeicher, Modelle laden bei der ersten Anfrage)", flush=True)
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
