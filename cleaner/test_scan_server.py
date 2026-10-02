#!/usr/bin/env python3
"""Interner Analyse-Endpunkt für den Scanner-Kalibrierungsassistenten."""

import json
import os
import subprocess
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


ROOT = Path(os.getenv("TEST_SCAN_DIR", "/test-scans"))
PROCESS_SCAN = "/usr/local/bin/process_scan.py"
PORT = int(os.getenv("TEST_SCAN_ANALYSIS_PORT", "8090"))

PARAMETERS = {
    "blankMeanMin": ("BLANK_MEAN_MIN", int, 0, 255),
    "blankStddevMax": ("BLANK_STDDEV_MAX", float, 0, 255),
    "blankContentThreshold": ("BLANK_CONTENT_THRESHOLD", int, 0, 255),
    "blankMaskMaxContentPx": ("BLANK_MASK_MAX_CONTENT_PX", int, 0, 1000000),
    "contentThreshold": ("CONTENT_THRESHOLD", int, 0, 255),
    "contentDenoiseMinPx": ("CONTENT_DENOISE_MIN_PX", int, 0, 20),
    "detectDpi": ("DETECT_DPI", int, 50, 300),
}


def parameter_env(values):
    env = os.environ.copy()
    env["CROP_ENABLED"] = "1"
    for key, (env_key, cast, minimum, maximum) in PARAMETERS.items():
        if key not in values:
            raise ValueError(f"Parameter fehlt: {key}")
        try:
            value = cast(values[key])
        except (TypeError, ValueError):
            raise ValueError(f"Ungültiger Wert für {key}") from None
        if value < minimum or value > maximum:
            raise ValueError(f"{key} muss zwischen {minimum} und {maximum} liegen")
        env[env_key] = str(value)
    return env


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        print(f"[test-scan-analysis] {fmt % args}")

    def send_json(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            return self.send_json(200, {"ok": True})
        return self.send_json(404, {"error": "Nicht gefunden"})

    def do_POST(self):
        if self.path not in ("/analyze", "/render"):
            return self.send_json(404, {"error": "Nicht gefunden"})
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0 or length > 65536:
                raise ValueError("Ungültiger Request")
            payload = json.loads(self.rfile.read(length))
            slots = payload.get("slots", [])
            if not isinstance(slots, list) or any(slot not in (1, 2, 3) for slot in slots):
                raise ValueError("Slots müssen eine Liste aus 1, 2 und 3 sein")
            ROOT.mkdir(parents=True, exist_ok=True)
            preview_dir = ROOT / "previews"
            preview_dir.mkdir(parents=True, exist_ok=True)
            results = []
            if self.path == "/render":
                for slot in sorted(set(slots)):
                    pdf = ROOT / f"slot-{slot}.pdf"
                    if not pdf.is_file():
                        continue
                    preview = preview_dir / f"raw-slot-{slot}.png"
                    process = subprocess.run(
                        [PROCESS_SCAN, "--preview", str(pdf), str(preview)],
                        capture_output=True, text=True, timeout=60,
                    )
                    if process.returncode != 0:
                        raise RuntimeError(process.stderr.strip() or f"Vorschau von Testseite {slot} fehlgeschlagen")
                    result = json.loads(process.stdout)
                    result["slot"] = slot
                    result["previewVersion"] = int(preview.stat().st_mtime_ns)
                    results.append(result)
                return self.send_json(200, {"results": results})

            env = parameter_env(payload.get("parameters") or {})
            for slot in sorted(set(slots)):
                pdf = ROOT / f"slot-{slot}.pdf"
                if not pdf.is_file():
                    continue
                preview = preview_dir / f"slot-{slot}.png"
                process = subprocess.run(
                    [PROCESS_SCAN, "--analyze", str(pdf), str(preview)],
                    capture_output=True, text=True, timeout=60, env=env,
                )
                if process.returncode != 0:
                    raise RuntimeError(process.stderr.strip() or f"Analyse von Testseite {slot} fehlgeschlagen")
                result = json.loads(process.stdout)
                result["slot"] = slot
                result["previewVersion"] = int(preview.stat().st_mtime_ns)
                results.append(result)
            return self.send_json(200, {"results": results})
        except ValueError as exc:
            return self.send_json(400, {"error": str(exc)})
        except Exception as exc:
            print(f"[test-scan-analysis] Fehler: {exc}")
            return self.send_json(500, {"error": "Testseiten konnten nicht analysiert werden"})


if __name__ == "__main__":
    ROOT.mkdir(parents=True, exist_ok=True)
    print(f"[test-scan-analysis] listening on :{PORT}, root={ROOT}")
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
