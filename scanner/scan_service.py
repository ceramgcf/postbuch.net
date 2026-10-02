"""
scan_service.py — Scanner-Webhook-Service

Alle Endpunkte als GET mit Query-Parametern.
Es kann nur eine Flachbett-Session gleichzeitig existieren (kein Session-ID nötig).

Endpunkte:
  GET /scan/adf/simplex                 — ADF Simplex (alle Seiten bis ADF leer, EIN Dokument)
  GET /scan/adf/duplex                  — ADF Duplex  (alle Seiten bis ADF leer, EIN Dokument)
  GET /scan/adf/batch/simplex           — ADF-Stapel: jedes Blatt (1 Seite) ein eigenes Dokument
  GET /scan/adf/batch/duplex            — ADF-Stapel: jedes Blatt (Vorder-/Rückseite) ein eigenes Dokument
  GET /scan/flatbed/single              — Einseitiger Flachbettscan
  GET /scan/flatbed/session/start       — Mehrseitigen Scan starten + erste Seite scannen
  GET /scan/flatbed/session/scan        — Kombiniert: Start wenn keine Session, sonst Seite hinzufügen
  GET /scan/flatbed/session/add         — Weitere Seite zur laufenden Session hinzufügen
  GET /scan/flatbed/session/finish      — Session abschließen → PDF speichern
  GET /scan/flatbed/session/abort       — Session abbrechen (kein PDF)

  GET /scan                             — Legacy-Endpunkt (Rückwärtskompatibilität)

Query-Parameter (alle Scan-Endpunkte):
  dpi   (Standard: 300)
  mode  (Standard: gray)  — gray | color | bw

  `bw` (1-Bit-Schwarzweiß) setzt voraus, dass das Gerät `BlackAndWhite1` meldet.
  Welche Werte ein Gerät wirklich kann, ermittelt die App über
  `POST /api/settings/scanner/capabilities` — hier wird nicht noch einmal geprüft.

Zusätzlich für /scan/flatbed/single:
  size  (Standard: a4)    — a3 | a4 | a5 | a6

Sitzungs-Idle-Timeout: 60 Sekunden nach letzter Aktivität → automatisches Finish.
Das PDF landet erst im Ausgabeordner, wenn die Session abgeschlossen ist.
"""

import datetime
import glob
import http.client
import os
import ssl
import shutil
import subprocess
import tempfile
import threading
import time
import urllib.parse
import urllib.request

from flask import Flask, request, jsonify

app = Flask(__name__)

OUTDIR = "/scans"
TEST_OUTDIR = "/test-scans"
APP_URL = os.environ.get("APP_URL", "")

SESSION_IDLE_SECONDS = 60  # Sekunden Inaktivität bis Auto-Finish

# SANE_DEBUG_AIRSCAN=20 gibt HTTP-Request/Response zum Scanner aus — tief genug,
# um zu unterscheiden ob der Fehler vom Scanner kommt oder von sane-airscan selbst.
# Wert über Umgebungsvariable überschreibbar (0 = deaktiviert).
_SANE_DEBUG_LEVEL = os.environ.get("SANE_DEBUG_LEVEL", "20")

def _scan_env():
    env = os.environ.copy()
    if _SANE_DEBUG_LEVEL:
        env["SANE_DEBUG_AIRSCAN"] = _SANE_DEBUG_LEVEL
    return env

# ---------------------------------------------------------------------------
# Live-Konfiguration (wird via Polling aus der App aktualisiert)
# ---------------------------------------------------------------------------

_cfg_lock = threading.Lock()

# Anzeigename in den SANE-Konfigurationsdateien (rein kosmetisch — scanimage
# wird trotzdem über die voll qualifizierte SANE-Device-ID angesprochen,
# weil die Backend-Aliase nicht zuverlässig funktionieren).
SANE_DEVICE_LABEL = "postbuch-scanner"

_cfg = {
    "device_url":   os.environ.get("SCANNER_DEVICE_URL", ""),
    "default_dpi":  os.environ.get("SCANNER_DEFAULT_DPI", "300"),
    "default_mode": os.environ.get("SCANNER_DEFAULT_MODE", "gray"),
    # Voll qualifizierte SANE-Device-ID, die scanimage --device akzeptiert.
    # Wird in _apply_scanner_config() aus device_url abgeleitet.
    "sane_device":  None,
}


def _sane_device_from_url(device_url):
    """Erzeugt aus einer eSCL-URL die SANE-Device-ID, wie sie `scanimage -L`
    auflistet (z. B. `escl:http://192.168.0.5:80`). Aliasnamen aus
    airscan.conf / escl.conf werden vom SANE-Backend nicht zuverlässig
    aufgelöst, daher sprechen wir das Gerät direkt über seine URL an."""
    parsed = urllib.parse.urlparse(device_url)
    host   = parsed.hostname or "0.0.0.0"
    scheme = parsed.scheme if parsed.scheme in ("http", "https") else "http"
    port   = parsed.port or (443 if scheme == "https" else 80)
    return f"escl:{scheme}://{host}:{port}"


def _get_cfg(key):
    with _cfg_lock:
        return _cfg[key]


def _apply_scanner_config(scanner):
    """Schreibt airscan.conf + escl.conf neu und aktualisiert _cfg."""
    device_url = scanner.get("device_url", _cfg["device_url"])

    try:
        parsed = urllib.parse.urlparse(device_url)
        host   = parsed.hostname or "0.0.0.0"
        scheme = parsed.scheme if parsed.scheme in ("http", "https") else "http"
        port   = parsed.port or (443 if scheme == "https" else 80)
        base   = f"{scheme}://{host}:{port}"

        with open("/etc/sane.d/airscan.conf", "w") as f:
            f.write(f"[devices]\n{SANE_DEVICE_LABEL} = {device_url}, eSCL\n")
        with open("/etc/sane.d/escl.conf", "w") as f:
            f.write(f"device {base} {SANE_DEVICE_LABEL}\n")
    except Exception as exc:
        print(f"[config] airscan.conf schreiben fehlgeschlagen: {exc}")
        return

    sane_device = _sane_device_from_url(device_url)
    with _cfg_lock:
        _cfg["device_url"]   = device_url
        _cfg["sane_device"]  = sane_device
        _cfg["default_dpi"]  = str(scanner.get("default_dpi",  _cfg["default_dpi"]))
        _cfg["default_mode"] = str(scanner.get("default_mode", _cfg["default_mode"]))
    print(f"[config] device={sane_device} (label={SANE_DEVICE_LABEL}) url={device_url}")


def _fetch_config():
    if not APP_URL:
        return
    try:
        with urllib.request.urlopen(f"{APP_URL}/api/internal/config", timeout=5) as r:
            import json
            data = json.loads(r.read())
        _apply_scanner_config(data.get("scanner", {}))
        return True
    except Exception as exc:
        print(f"[config] fetch fehlgeschlagen: {exc}")
        return False


def _config_poll_loop():
    while True:
        time.sleep(30)
        _fetch_config()


def _initial_fetch_with_retry():
    """Beim Start: bis zu 5 Versuche mit 5s Abstand, dann aufgeben."""
    for attempt in range(5):
        if _fetch_config():
            return
        if attempt < 4:
            time.sleep(5)
    print("[config] App nach 5 Versuchen nicht erreichbar — nutze Fallback-Werte")


# Initiale sane_device-ID aus dem Default-URL ableiten, damit das Gerät auch
# dann ansprechbar ist, wenn die App-Konfiguration noch nicht abgerufen wurde.
with _cfg_lock:
    if not _cfg["sane_device"]:
        _cfg["sane_device"] = _sane_device_from_url(_cfg["device_url"])

threading.Thread(target=_initial_fetch_with_retry, daemon=True).start()
threading.Thread(target=_config_poll_loop, daemon=True).start()

PAPER_SIZES = {
    "a3": ("297", "420"),
    "a4": ("210", "297"),
    "a5": ("148", "210"),
    "a6": ("105", "148"),
}

# Singleton Flachbett-Session (nur eine gleichzeitig)
_session: dict = {}       # leer = keine aktive Session
_session_lock = threading.Lock()


# ---------------------------------------------------------------------------
# Hilfsfunktionen
# ---------------------------------------------------------------------------

def _sane_mode(mode: str) -> str:
    m = mode.lower()
    if m == "color":
        return "Color"
    # 1-Bit-Schwarzweiß. Wird nur angeboten, wenn das Gerät `BlackAndWhite1`
    # meldet — die Fähigkeitsermittlung in der App filtert das vorher.
    if m == "bw":
        return "Lineart"
    return "Gray"


def _seiten_format(mode: str) -> tuple:
    """Bildformat und Dateiendung für einen Farbmodus.

    JPEG kann keine 1 Bit tiefen Bilder — scanimage bricht bei Lineart mit
    --format=jpeg ab. Für Schwarzweiß deshalb PNM, das img2pdf als Bilevel
    (CCITT-G4) ins PDF übernimmt.
    """
    return ("pnm", "pnm") if mode.lower() == "bw" else ("jpeg", "jpg")


def _seiten_pfad(tmpdir: str, basisname: str, mode: str) -> str:
    """Pfad einer Einzelseite mit der zum Farbmodus passenden Endung."""
    _, ext = _seiten_format(mode)
    return os.path.join(tmpdir, f"{basisname}.{ext}")


def _new_outfile(prefix: str) -> str:
    ts = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
    return os.path.join(OUTDIR, f"{prefix}_{ts}.pdf")


def _new_batch_outfile(prefix: str, ts: str, seq: int) -> str:
    """Wie _new_outfile, aber mit einem für den ganzen Batch-Lauf fixen
    Zeitstempel plus laufender Nummer — verhindert Kollisionen, wenn mehrere
    Blätter innerhalb derselben Sekunde fertig werden."""
    return os.path.join(OUTDIR, f"{prefix}_{ts}_{seq:03d}.pdf")


def _build_pdf(pages: list, outfile: str, dpi: str = ""):
    # PNM trägt keine Auflösungsangabe. Ohne Vorgabe rechnet img2pdf mit 96 dpi
    # und die Seite bekommt eine falsche Größe. `--imgsize <n>dpi` ist die
    # Schreibweise von img2pdf 0.6 — ein `--dpi` gibt es dort nicht.
    # JPEG trägt die Dichte selbst; dort würde eine Vorgabe die Angabe des
    # Geräts überschreiben, deshalb nur für PNM.
    extra = ["--imgsize", f"{dpi}dpi"] if dpi and pages and pages[0].endswith(".pnm") else []
    subprocess.run(["img2pdf"] + extra + pages + ["-o", outfile], check=True)


def _cleanup(path: str):
    if os.path.isdir(path):
        shutil.rmtree(path, ignore_errors=True)


def _check_adf() -> tuple:
    """Gibt (ok: bool, fehlermeldung: str) zurück. Bei Fehler optimistisch True."""
    try:
        parsed = urllib.parse.urlparse(_get_cfg("device_url"))
        host   = parsed.hostname or "192.168.1.100"
        scheme = parsed.scheme if parsed.scheme in ("http", "https") else "http"
        port   = parsed.port or (443 if scheme == "https" else 80)
        if scheme == "https":
            # Netzwerk-Scanner besitzen praktisch nie eine öffentlich
            # vertrauenswürdige PKI-Kette. TLS verschlüsselt den Transport;
            # self-signed, abgelaufene und namensfalsche Zertifikate blockieren
            # die Scanner-Verbindung deshalb bewusst nicht.
            context = ssl.create_default_context()
            context.check_hostname = False
            context.verify_mode = ssl.CERT_NONE
            conn = http.client.HTTPSConnection(
                host, port, timeout=5, context=context
            )
        else:
            conn = http.client.HTTPConnection(host, port, timeout=5)
        conn.request("GET", "/eSCL/ScannerStatus")
        resp = conn.getresponse()
        body = resp.read().decode("utf-8", errors="ignore")
        conn.close()
        if "ScannerAdfLoaded" not in body:
            return False, "ADF leer laut Gerät (ScannerStatus)"
        return True, ""
    except Exception as exc:
        print(f"[WARN] ADF-Statusabfrage fehlgeschlagen: {exc}")
        return True, ""  # optimistisch weitermachen


def _run_adf(tmpdir: str, dpi: str, mode: str, duplex: bool, keep_partial: bool = False) -> tuple:
    """ADF-Batch-Scan. Gibt (seiten: list, stderr: str) zurück.

    `keep_partial=True` liefert auch bei einem Scanner-Fehler (z. B. Papierstau)
    die bis dahin bereits auf Platte geschriebenen Seiten zurück, statt sie zu
    verwerfen. Nur der neue ADF-Batch-Modus nutzt das (dort sollen bereits
    gescannte Blätter trotzdem als Dokumente übernommen werden); die
    bestehenden Endpunkte /scan/adf/simplex und /scan/adf/duplex verhalten
    sich unverändert (alles oder nichts).
    """
    adf_source = "ADF Duplex" if duplex else "ADF"
    fmt, ext = _seiten_format(mode)
    cmd = [
        "scanimage",
        f"--device={_get_cfg('sane_device')}",
        f"--format={fmt}",
        f"--resolution={dpi}",
        f"--mode={_sane_mode(mode)}",
        f"--source={adf_source}",
        "-x", "210",
        "-y", "297",
        f"--batch={tmpdir}/page%04d.{ext}",
        "--batch-count=-1",
    ]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=300, env=_scan_env())
    # Returncode 7 = ADF leer → normales Ende
    if result.returncode not in (0, 7):
        print(f"[SCAN FAIL] ADF cmd: {' '.join(cmd)}")
        print(f"[SCAN FAIL] stderr:\n{result.stderr}")
        if keep_partial:
            pages = sorted(glob.glob(f"{tmpdir}/page*.{ext}"))
            return pages, result.stderr
        return [], result.stderr
    pages = sorted(glob.glob(f"{tmpdir}/page*.{ext}"))
    return pages, ""


def _split_in_blaetter(pages: list, seiten_pro_blatt: int) -> list:
    """Teilt eine geordnete Seitenliste in aufeinanderfolgende Blatt-Gruppen.

    seiten_pro_blatt=1 (Simplex): jede Seite ihr eigenes Blatt.
    seiten_pro_blatt=2 (Duplex): Seite 1+2 = Blatt 1, Seite 3+4 = Blatt 2, usw.
    Bricht der ADF mitten in einem Duplex-Blatt ab, hat die letzte Gruppe nur
    eine Seite (Vorderseite ohne Rückseite) — wird trotzdem als Dokument gebaut.
    """
    return [pages[i:i + seiten_pro_blatt] for i in range(0, len(pages), seiten_pro_blatt)]


def _scan_flatbed_page(outjpg: str, dpi: str, mode: str, width_mm: str, height_mm: str) -> tuple:
    """Einzelner Flachbettscan. Gibt (ok: bool, stderr: str) zurück."""
    fmt, _ = _seiten_format(mode)
    cmd = [
        "scanimage",
        f"--device={_get_cfg('sane_device')}",
        f"--format={fmt}",
        f"--resolution={dpi}",
        f"--mode={_sane_mode(mode)}",
        "--source=Flatbed",
        "-x", width_mm,
        "-y", height_mm,
        f"--output-file={outjpg}",
    ]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=90, env=_scan_env())
    if result.returncode != 0:
        print(f"[SCAN FAIL] flatbed cmd: {' '.join(cmd)}")
        print(f"[SCAN FAIL] stderr:\n{result.stderr}")
    return result.returncode == 0, result.stderr


# ---------------------------------------------------------------------------
# Session-Idle-Timeout
# ---------------------------------------------------------------------------

def _arm_timer() -> threading.Timer:
    def _on_timeout():
        with _session_lock:
            if not _session:
                return
            _finalize_session(reason="idle-timeout")

    t = threading.Timer(SESSION_IDLE_SECONDS, _on_timeout)
    t.daemon = True
    t.start()
    return t


def _cancel_timer():
    t = _session.get("timer")
    if t:
        t.cancel()


def _finalize_session(reason: str = "manual"):
    """PDF zusammenbauen und Session leeren. Muss mit _session_lock aufgerufen werden."""
    pages  = _session.get("pages", [])
    tmpdir = _session.get("tmpdir", "")
    dpi    = _session.get("dpi", "300")
    try:
        if pages:
            outfile = _new_outfile("flatbed_multi")
            _build_pdf(pages, outfile, dpi)
            print(f"[SESSION] {reason} → {outfile} ({len(pages)} Seiten)")
        else:
            print(f"[SESSION] {reason} — keine Seiten, kein PDF")
    except Exception as exc:
        print(f"[SESSION] PDF-Fehler: {exc}")
    finally:
        _cleanup(tmpdir)
        _session.clear()


# ---------------------------------------------------------------------------
# ADF-Endpunkte
# ---------------------------------------------------------------------------

@app.route("/scan/adf/simplex")
def scan_adf_simplex():
    dpi  = request.args.get("dpi",  _get_cfg("default_dpi"))
    mode = request.args.get("mode", _get_cfg("default_mode"))

    ok, msg = _check_adf()
    if not ok:
        return jsonify({"status": "error", "msg": msg}), 400

    tmpdir = tempfile.mkdtemp(prefix="scan_adf_")
    try:
        pages, err = _run_adf(tmpdir, dpi, mode, duplex=False)
        if not pages:
            return jsonify({"status": "error", "msg": "Keine Seiten gescannt", "stderr": err}), 500
        outfile = _new_outfile("adf_simplex")
        _build_pdf(pages, outfile, dpi)
        return jsonify({"status": "ok", "file": os.path.basename(outfile), "pages": len(pages)})
    finally:
        _cleanup(tmpdir)


@app.route("/scan/adf/duplex")
def scan_adf_duplex():
    dpi  = request.args.get("dpi",  _get_cfg("default_dpi"))
    mode = request.args.get("mode", _get_cfg("default_mode"))

    ok, msg = _check_adf()
    if not ok:
        return jsonify({"status": "error", "msg": msg}), 400

    tmpdir = tempfile.mkdtemp(prefix="scan_adf_")
    try:
        pages, err = _run_adf(tmpdir, dpi, mode, duplex=True)
        if not pages:
            return jsonify({"status": "error", "msg": "Keine Seiten gescannt", "stderr": err}), 500
        outfile = _new_outfile("adf_duplex")
        _build_pdf(pages, outfile, dpi)
        return jsonify({"status": "ok", "file": os.path.basename(outfile), "pages": len(pages)})
    finally:
        _cleanup(tmpdir)


def _scan_adf_batch(duplex: bool):
    """ADF-Stapel-Scan: mehrere Blätter auf einmal einlegen, jedes Blatt (bei
    Duplex: Vorder- + Rückseite) wird zu einer eigenen PDF-Datei. Die
    Leerseiten-Erkennung des Cleaners übernimmt das automatische Entfernen
    einer leeren Duplex-Rückseite — dafür tragen die Duplex-Dateien bewusst
    das Präfix `adf_duplex_`, exakt wie die bestehenden Duplex-Scans."""
    dpi  = request.args.get("dpi",  _get_cfg("default_dpi"))
    mode = request.args.get("mode", _get_cfg("default_mode"))

    ok, msg = _check_adf()
    if not ok:
        return jsonify({"status": "error", "msg": msg}), 400

    tmpdir = tempfile.mkdtemp(prefix="scan_adf_batch_")
    try:
        pages, err = _run_adf(tmpdir, dpi, mode, duplex=duplex, keep_partial=True)
        if not pages:
            return jsonify({"status": "error", "msg": "Keine Seiten gescannt", "stderr": err}), 500

        seiten_pro_blatt = 2 if duplex else 1
        blaetter = _split_in_blaetter(pages, seiten_pro_blatt)
        prefix = "adf_duplex_batch" if duplex else "adf_simplex_batch"
        ts = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")

        files = []
        for seq, blatt in enumerate(blaetter, start=1):
            outfile = _new_batch_outfile(prefix, ts, seq)
            _build_pdf(blatt, outfile, dpi)
            files.append(os.path.basename(outfile))

        resp = {"status": "ok", "files": files, "sheets": len(files), "pages": len(pages)}
        if err:
            resp["status"] = "partial"
            resp["msg"] = (
                f"ADF-Fehler nach {len(pages)} Seite(n) — "
                f"{len(files)} Dokument(e) trotzdem übernommen."
            )
            resp["stderr"] = err
        return jsonify(resp)
    finally:
        _cleanup(tmpdir)


@app.route("/scan/adf/batch/simplex")
def scan_adf_batch_simplex():
    return _scan_adf_batch(duplex=False)


@app.route("/scan/adf/batch/duplex")
def scan_adf_batch_duplex():
    return _scan_adf_batch(duplex=True)


# ---------------------------------------------------------------------------
# Flachbett: Einzelscan
# ---------------------------------------------------------------------------

@app.route("/scan/flatbed/single")
def scan_flatbed_single():
    dpi  = request.args.get("dpi",  _get_cfg("default_dpi"))
    mode = request.args.get("mode", _get_cfg("default_mode"))
    size = request.args.get("size", "a4").lower()

    if size not in PAPER_SIZES:
        return jsonify({"status": "error", "msg": f"Unbekannte Größe '{size}'. Erlaubt: a3, a4, a5, a6"}), 400

    w, h = PAPER_SIZES[size]
    tmpdir = tempfile.mkdtemp(prefix="scan_fb_")
    try:
        seite = _seiten_pfad(tmpdir, "page", mode)
        ok, err = _scan_flatbed_page(seite, dpi, mode, w, h)
        if not ok:
            return jsonify({"status": "error", "stderr": err}), 500
        outfile = _new_outfile(f"flatbed_{size}")
        _build_pdf([seite], outfile, dpi)
        return jsonify({"status": "ok", "file": os.path.basename(outfile)})
    finally:
        _cleanup(tmpdir)


@app.route("/scan/test/single")
def scan_test_single():
    """Einseitiger Kalibrierungsscan ohne Übergabe an Cleaner oder Pipeline."""
    dpi = request.args.get("dpi", _get_cfg("default_dpi"))
    mode = request.args.get("mode", _get_cfg("default_mode"))
    size = request.args.get("size", "a4").lower()
    try:
        slot = int(request.args.get("slot", "0"))
    except ValueError:
        slot = 0
    if slot not in (1, 2, 3):
        return jsonify({"status": "error", "msg": "slot muss 1, 2 oder 3 sein"}), 400
    if size not in PAPER_SIZES:
        return jsonify({"status": "error", "msg": f"Unbekannte Größe '{size}'. Erlaubt: a3, a4, a5, a6"}), 400

    w, h = PAPER_SIZES[size]
    tmpdir = tempfile.mkdtemp(prefix="scan_test_")
    os.makedirs(TEST_OUTDIR, exist_ok=True)
    try:
        seite = _seiten_pfad(tmpdir, "page", mode)
        ok, err = _scan_flatbed_page(seite, dpi, mode, w, h)
        if not ok:
            return jsonify({"status": "error", "msg": "Test-Scan fehlgeschlagen", "stderr": err}), 500
        tmp_pdf = os.path.join(TEST_OUTDIR, f".slot-{slot}.{os.getpid()}.tmp.pdf")
        ziel = os.path.join(TEST_OUTDIR, f"slot-{slot}.pdf")
        _build_pdf([seite], tmp_pdf, dpi)
        os.replace(tmp_pdf, ziel)
        return jsonify({"status": "ok", "slot": slot})
    finally:
        _cleanup(tmpdir)


# ---------------------------------------------------------------------------
# Flachbett: Mehrseitige Session (Singleton)
# ---------------------------------------------------------------------------

@app.route("/scan/flatbed/session/start")
def session_start():
    """Startet eine neue Session und scannt die erste Seite.
    Eine laufende Session wird dabei automatisch abgebrochen."""
    dpi  = request.args.get("dpi",  _get_cfg("default_dpi"))
    mode = request.args.get("mode", _get_cfg("default_mode"))
    size = request.args.get("size", "a4").lower()
    if size not in PAPER_SIZES:
        return jsonify({"status": "error", "msg": f"Unbekannte Größe '{size}'. Erlaubt: a3, a4, a5, a6"}), 400
    w, h = PAPER_SIZES[size]

    tmpdir = tempfile.mkdtemp(prefix="scan_sess_")
    seite = _seiten_pfad(tmpdir, "page_0001", mode)
    ok, err = _scan_flatbed_page(seite, dpi, mode, w, h)
    if not ok:
        _cleanup(tmpdir)
        return jsonify({"status": "error", "msg": "Scan der ersten Seite fehlgeschlagen", "stderr": err}), 500

    with _session_lock:
        # Alte Session sauber beenden (kein PDF, nur aufräumen)
        if _session:
            _cancel_timer()
            _cleanup(_session.get("tmpdir", ""))
            _session.clear()
        _session["tmpdir"] = tmpdir
        _session["pages"]  = [seite]
        _session["dpi"]    = dpi
        _session["mode"]   = mode
        _session["size"]   = size
        _session["timer"]  = _arm_timer()

    return jsonify({"status": "ok", "pages": 1})


@app.route("/scan/flatbed/session/add")
def session_add():
    """Scannt eine weitere Seite und fügt sie zur laufenden Session hinzu."""
    with _session_lock:
        if not _session:
            return jsonify({"status": "error", "msg": "Keine aktive Session"}), 404
        _cancel_timer()
        _session["timer"] = None
        dpi      = _session["dpi"]
        mode     = _session["mode"]
        size     = _session.get("size", "a4")
        tmpdir   = _session["tmpdir"]
        page_num = len(_session["pages"]) + 1

    w, h = PAPER_SIZES[size]
    seite = _seiten_pfad(tmpdir, f"page_{page_num:04d}", mode)
    ok, err = _scan_flatbed_page(seite, dpi, mode, w, h)

    with _session_lock:
        if not _session:
            return jsonify({"status": "error", "msg": "Session wurde während des Scans geschlossen"}), 409
        if ok:
            _session["pages"].append(seite)
        _session["timer"] = _arm_timer()

    if not ok:
        return jsonify({"status": "error", "msg": "Scan fehlgeschlagen", "stderr": err}), 500

    return jsonify({"status": "ok", "pages": page_num})


@app.route("/scan/flatbed/session/finish")
def session_finish():
    """Schließt die Session ab und speichert das PDF."""
    with _session_lock:
        if not _session:
            return jsonify({"status": "error", "msg": "Keine aktive Session"}), 404
        _cancel_timer()
        pages  = list(_session["pages"])
        tmpdir = _session["tmpdir"]
        dpi    = _session.get("dpi", "300")
        _session.clear()

    if not pages:
        _cleanup(tmpdir)
        return jsonify({"status": "error", "msg": "Session enthält keine Seiten"}), 400

    outfile = _new_outfile("flatbed_multi")
    try:
        _build_pdf(pages, outfile, dpi)
    except Exception as exc:
        _cleanup(tmpdir)
        return jsonify({"status": "error", "msg": str(exc)}), 500

    _cleanup(tmpdir)
    return jsonify({"status": "ok", "file": os.path.basename(outfile), "pages": len(pages)})


@app.route("/scan/flatbed/session/abort")
def session_abort():
    """Bricht die Session ab. Kein PDF wird gespeichert."""
    with _session_lock:
        if not _session:
            return jsonify({"status": "error", "msg": "Keine aktive Session"}), 404
        _cancel_timer()
        tmpdir = _session["tmpdir"]
        _session.clear()

    _cleanup(tmpdir)
    return jsonify({"status": "ok", "msg": "Session abgebrochen, keine Datei gespeichert"})


# ---------------------------------------------------------------------------
# Flachbett: Kombinierter Scan-Endpunkt (Start ODER Seite hinzufügen)
# ---------------------------------------------------------------------------

@app.route("/scan/flatbed/session/scan")
def session_scan():
    """Kombinierter Endpunkt:
    - Keine aktive Session → neue Session starten + erste Seite scannen.
    - Aktive Session  → weitere Seite hinzufügen.
    dpi/mode werden nur beim ersten Aufruf übernommen; danach gelten die Session-Parameter.
    Abschließen weiterhin mit /finish (manuell) oder automatisch nach Idle-Timeout."""
    dpi  = request.args.get("dpi",  _get_cfg("default_dpi"))
    mode = request.args.get("mode", _get_cfg("default_mode"))
    size = request.args.get("size", "a4").lower()

    with _session_lock:
        is_new = not bool(_session)
        if is_new:
            if size not in PAPER_SIZES:
                return jsonify({"status": "error", "msg": f"Unbekannte Größe '{size}'. Erlaubt: a3, a4, a5, a6"}), 400
            # Keine laufende Session – tmpdir schon jetzt reservieren
            tmpdir   = tempfile.mkdtemp(prefix="scan_sess_")
            page_num = 1
        else:
            # Laufende Session – Timer stoppen, Scanner-Parameter übernehmen
            _cancel_timer()
            _session["timer"] = None
            dpi      = _session["dpi"]
            mode     = _session["mode"]
            size     = _session.get("size", "a4")
            tmpdir   = _session["tmpdir"]
            page_num = len(_session["pages"]) + 1

    # Scan läuft außerhalb des Locks (kann bis zu 90 s dauern)
    w, h = PAPER_SIZES[size]
    seite = _seiten_pfad(tmpdir, f"page_{page_num:04d}", mode)
    ok, err = _scan_flatbed_page(seite, dpi, mode, w, h)

    if is_new:
        if not ok:
            _cleanup(tmpdir)
            return jsonify({"status": "error", "msg": "Scan der ersten Seite fehlgeschlagen", "stderr": err}), 500

        with _session_lock:
            # Falls zwischen den beiden Lock-Abschnitten eine andere Session gestartet wurde,
            # diese sauber beenden und unsere neue Session durchsetzen.
            if _session:
                _cancel_timer()
                _cleanup(_session.get("tmpdir", ""))
                _session.clear()
            _session["tmpdir"] = tmpdir
            _session["pages"]  = [seite]
            _session["dpi"]    = dpi
            _session["mode"]   = mode
            _session["size"]   = size
            _session["timer"]  = _arm_timer()

        return jsonify({"status": "ok", "action": "started", "pages": 1})

    else:
        # Add-Pfad: Session könnte in der Zwischenzeit durch Timeout geschlossen worden sein
        with _session_lock:
            if not _session:
                return jsonify({"status": "error", "msg": "Session wurde während des Scans geschlossen"}), 409
            if ok:
                _session["pages"].append(seite)
            _session["timer"] = _arm_timer()

        if not ok:
            return jsonify({"status": "error", "msg": "Scan fehlgeschlagen", "stderr": err}), 500

        return jsonify({"status": "ok", "action": "added", "pages": page_num})


# ---------------------------------------------------------------------------
# Legacy-Endpunkt (Rückwärtskompatibilität)
# ---------------------------------------------------------------------------

@app.route("/scan")
def scan_legacy():
    mode   = request.args.get("mode", "gray")
    source = request.args.get("source", "flatbed")
    duplex = request.args.get("duplex", "false")

    outfile = _new_outfile("scan")
    tmpdir  = tempfile.mkdtemp(prefix="scan_legacy_")
    try:
        if source == "flatbed":
            seite = _seiten_pfad(tmpdir, "page", mode)
            ok, err = _scan_flatbed_page(seite, "300", mode, "210", "297")
            if not ok:
                return jsonify({"status": "error", "stderr": err}), 500
            _build_pdf([seite], outfile, "300")
        else:
            _check_adf()
            pages, err = _run_adf(tmpdir, "300", mode, duplex=(duplex == "true"))
            if not pages:
                return jsonify({"status": "error", "msg": "Keine Seiten gescannt", "stderr": err}), 500
            _build_pdf(pages, outfile, "300")
    finally:
        _cleanup(tmpdir)

    return jsonify({"status": "ok", "file": os.path.basename(outfile)})


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8080)
