#!/app/.venv/bin/python3
"""
process_scan.py  –  Deskew + optional OCR (Tesseract) + remove blank pages

Pipeline:
  1) ocrmypdf --deskew [--ocr-engine tesseract -l LANGS] → corrects skew and
     optionally adds OCR text layer
  2) Ghostscript renders each page as a PNG at low resolution
  3) Pillow computes mean brightness and stddev; blank pages are removed
  4) pikepdf reassembles surviving pages into the output PDF

Configuration via environment variables:
  OCR_ENABLED (default 1) — set to 0 to disable OCR
  OCR_LANGS   (default deu) — tesseract languages, e.g. deu or deu+eng

Exit codes:
  0 success
  1 usage error
  2 input not found
  3 all pages blank
  4 unexpected error
"""

import os
import sys
import glob
import shutil
import subprocess
import tempfile
import re
import json
import contextlib
from collections import deque

from PIL import Image, ImageDraw, ImageStat
import numpy as np
import pikepdf

# ---------------------------------------------------------------------------
# Debug output (SCAN_DEBUG=1)
# ---------------------------------------------------------------------------
# When enabled, the pipeline writes annotated PNG + content mask of the LAST
# processed single-page scan to SCAN_DEBUG_DIR.  Previous debug files are
# deleted at the start of each new scan so only one set is ever present.
SCAN_DEBUG     = os.getenv("SCAN_DEBUG", "0") not in ("0", "false", "False")
SCAN_DEBUG_DIR = os.getenv("SCAN_DEBUG_DIR", "/input/scan_debug")

# Tunables — all configurable via ENV (set by run_loop.sh from app config API)
BLANK_MEAN_MIN        = int(os.getenv("BLANK_MEAN_MIN",        "240"))
BLANK_STDDEV_MAX      = float(os.getenv("BLANK_STDDEV_MAX",    "12"))
BLANK_MEAN_MIN_SINGLE = int(os.getenv("BLANK_MEAN_MIN_SINGLE", "253"))
BLANK_STDDEV_MAX_SINGLE = float(os.getenv("BLANK_STDDEV_MAX_SINGLE", "4"))
DETECT_DPI            = int(os.getenv("DETECT_DPI",            "75"))

OCRMYPDF = "/app/.venv/bin/ocrmypdf"
QPDF = "/usr/bin/qpdf"
TESSERACT = "/usr/bin/tesseract"
OCR_ENABLED = os.getenv("OCR_ENABLED", "1") not in ("0", "false", "False")
OCR_LANGS = os.getenv("OCR_LANGS", "deu")
OCR_JOBS = int(os.getenv("OCR_JOBS", "1"))

# ---------------------------------------------------------------------------
# Crop tunables (single-page only)
# ---------------------------------------------------------------------------
# Standard paper sizes in PDF points (1 pt = 1/72 inch ≈ 0.353 mm)
_MM = 72.0 / 25.4
A4_W, A4_H = 210 * _MM, 297 * _MM   # ≈ 595 × 842
A5_W, A5_H = 148 * _MM, 210 * _MM   # ≈ 420 × 595
A6_W, A6_H = 105 * _MM, 148 * _MM   # ≈ 298 × 420

# Candidate snap formats ordered from smallest to largest.
# Each entry: (width, height, label)
SNAP_FORMATS = [
    (A6_W, A6_H, "A6-Hochformat"),
    (A6_H, A6_W, "A6-Querformat"),
    (A5_W, A5_H, "A5-Hochformat"),
    (A5_H, A5_W, "A5-Querformat"),
]

CROP_ENABLED      = os.getenv("CROP_ENABLED", "1") not in ("0", "false", "False")
# Only crop if content bounding box covers ≤ this fraction of A4
CROP_MAX_FILL_A4  = 0.50
# Snap to a standard format only if bbox fills > this fraction of that format
SNAP_MIN_FILL     = 0.60
# Tolerance added to each snap format dimension when checking whether the
# content bbox fits.  Scanner shadows and deskew interpolation can inflate
# the detected bbox by several mm beyond the real document edge; this
# tolerance absorbs that inflation without changing the output size (the
# CropBox is still snapped to the exact format dimensions).
# At DETECT_DPI=100, 1 px ≈ 0.72 pt; a diffuse flatbed shadow is typically
# 20–50 px (14–36 pt).  Default 20 pt ≈ 7 mm covers the common case.
SNAP_TOLERANCE_PT = int(os.getenv("SNAP_TOLERANCE_PT", "20"))
# Margin added around bbox when cropping directly (no snap), in pt.
# ~3.5 mm per 10 pt. 20 pt ≈ 7 mm gives comfortable safety margin.
CROP_MARGIN_PT    = 20
# Pixels darker than this threshold are considered content (0–255).
# Thermal-printer text on this pipeline measures mid/dark grey (median ~117),
# so 220 catches it fully while excluding light scanner shadows/paper texture
# (background ≈ 255). Going lower re-clips the faintest strokes (e.g. the pale
# right tail of TSE-signature lines lives at ~210–220); higher lets shadows and
# antialiasing halos inflate the bbox — the single-pixel denoise no longer erodes
# those away. Speck filtering is handled by clean_content_mask, NOT by this value.
CONTENT_THRESHOLD = int(os.getenv("CONTENT_THRESHOLD", "200"))
# A connected blob smaller than this (in pixels, at DETECT_DPI=100 — scaled
# below for other DPIs) is scanner-bed noise (dust, sensor speckle, JPEG
# ringing), not content, and is dropped when denoising is on. Motivating case:
# a mostly blank page carrying one small pasted-on graphic had an isolated
# 2 px speck near a page corner, far from that graphic. The previous denoise
# only dropped *literally isolated* single pixels (needed ≥1 content
# neighbour to survive), so the 2 px speck survived and stretched the content
# bbox out past CROP_MAX_FILL_A4, skipping the crop for the whole page. The
# chosen minimum stays comfortably below any real ink stroke (even a printed
# "." period renders several px across at 100 DPI) and comfortably above the
# 1–2 px specks scanner glass/sensor noise produces.
CONTENT_DENOISE_MIN_PX = int(os.getenv("CONTENT_DENOISE_MIN_PX", "10"))
MIN_COMPONENT_PX = round(CONTENT_DENOISE_MIN_PX * (DETECT_DPI / 100) ** 2)

# Eine per mean/stddev verdächtige Duplex-Rückseite darf nur entfernt werden,
# wenn auch ihre bereinigte Inhaltsmaske praktisch leer ist. Damit bleiben
# lichte, sparsam bedruckte Seiten erhalten. Der Rand wird ausgeblendet, weil
# ADF-Schatten und Einzugsstreifen dort sonst leere Rückseiten konservieren.
BLANK_MASK_EDGE_RATIO = float(os.getenv("BLANK_MASK_EDGE_RATIO", "0.03"))
# Nutzpixel zählen eine Fläche, die mit DPI² wächst (doppelte Auflösung ⇒
# vierfache Pixelzahl für denselben Fleck) – ein fester Schwellwert wäre nur
# für die DPI kalibriert, bei der er ermittelt wurde. Wie MIN_COMPONENT_PX
# oben gilt dieser Wert als Referenz bei DETECT_DPI=100 und wird hier auf die
# tatsächliche Erkennungs-DPI skaliert.
BLANK_MASK_MAX_CONTENT_PX = round(int(os.getenv("BLANK_MASK_MAX_CONTENT_PX", "200")) * (DETECT_DPI / 100) ** 2)
# Für die Leerseitenentscheidung deutlich strenger als die Crop-Maske: Helles
# Durchscheinen der Vorderseite liegt typischerweise zwischen 200 und 220 und
# darf eine ansonsten leere Rückseite nicht konservieren.
BLANK_CONTENT_THRESHOLD = int(os.getenv("BLANK_CONTENT_THRESHOLD", "200"))


def _write_debug_artifacts(png_path: str, crop_box, page_w: float, page_h: float):
    """
    Save debug visualisations for the last processed single-page scan to
    SCAN_DEBUG_DIR.  Clears the directory first so only the latest scan is kept.

    Files written:
      annotated_bbox.png  — rendered page with content bbox (red) overlaid
      content_mask.png    — binary content mask after morphological opening
      debug_info.txt      — human-readable summary of all crop parameters
    """
    try:
        import shutil as _shutil
        if os.path.isdir(SCAN_DEBUG_DIR):
            _shutil.rmtree(SCAN_DEBUG_DIR)
        os.makedirs(SCAN_DEBUG_DIR, exist_ok=True)

        with Image.open(png_path) as img:
            W_px, H_px = img.size
            grey = img.convert("L")
            stat = ImageStat.Stat(grey)

            # Inhaltsmaske über denselben Helper wie in der Crop-Pipeline berechnen
            mask = clean_content_mask(grey)
            Image.fromarray((mask * 255).astype(np.uint8), mode="L").save(
                os.path.join(SCAN_DEBUG_DIR, "content_mask.png")
            )

            ys, xs = np.where(mask)
            if xs.size:
                bbox_px = (int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1)
            else:
                bbox_px = None

            # Annotated image: bbox in red, crop region (if any) in green
            vis = img.convert("RGB")
            draw = ImageDraw.Draw(vis)
            if bbox_px:
                draw.rectangle(
                    [bbox_px[0], bbox_px[1], bbox_px[2] - 1, bbox_px[3] - 1],
                    outline=(255, 0, 0), width=2
                )
            if crop_box is not None:
                cl, cb, cr, ct = crop_box
                sx = W_px / page_w
                sy = H_px / page_h
                # CropBox is in PDF coords (origin bottom-left); convert to image coords
                crop_l = int(cl * sx)
                crop_t = int((page_h - ct) * sy)
                crop_r = int(cr * sx)
                crop_b = int((page_h - cb) * sy)
                draw.rectangle(
                    [crop_l, crop_t, crop_r - 1, crop_b - 1],
                    outline=(0, 200, 0), width=2
                )
            vis.save(os.path.join(SCAN_DEBUG_DIR, "annotated_bbox.png"))

            # Text summary
            lines = [
                f"DETECT_DPI={DETECT_DPI}",
                f"CONTENT_THRESHOLD={CONTENT_THRESHOLD}",
                f"CONTENT_DENOISE_MIN_PX={CONTENT_DENOISE_MIN_PX} (effektiv {MIN_COMPONENT_PX}px bei {DETECT_DPI} DPI)",
                f"SNAP_TOLERANCE_PT={SNAP_TOLERANCE_PT}",
                f"SNAP_MIN_FILL={SNAP_MIN_FILL}",
                f"CROP_MAX_FILL_A4={CROP_MAX_FILL_A4}",
                f"",
                f"png_size={W_px}x{H_px}px  ({W_px/DETECT_DPI*25.4:.0f}x{H_px/DETECT_DPI*25.4:.0f}mm)",
                f"page_size={page_w:.2f}x{page_h:.2f}pt",
                f"mean={stat.mean[0]:.1f}  stddev={stat.stddev[0]:.2f}",
            ]
            if bbox_px:
                bw = bbox_px[2] - bbox_px[0]
                bh = bbox_px[3] - bbox_px[1]
                sx2 = page_w / W_px
                sy2 = page_h / H_px
                b_w_pt = bw * sx2
                b_h_pt = bh * sy2
                lines += [
                    f"content_bbox_px=L{bbox_px[0]} T{bbox_px[1]} R{bbox_px[2]} B{bbox_px[3]}",
                    f"content_bbox_mm={bw/DETECT_DPI*25.4:.1f}x{bh/DETECT_DPI*25.4:.1f}mm",
                    f"content_bbox_pt={b_w_pt:.2f}x{b_h_pt:.2f}pt",
                    f"fill_a4={b_w_pt*b_h_pt/(A4_W*A4_H)*100:.1f}%",
                ]
            else:
                lines.append("content_bbox=None (no content detected)")
            if crop_box is not None:
                cl, cb, cr, ct = crop_box
                lines.append(f"crop_box_pt=L{cl:.1f} B{cb:.1f} R{cr:.1f} T{ct:.1f}  ({cr-cl:.1f}x{ct-cb:.1f}pt)")
            else:
                lines.append("crop_box=None (no crop applied)")

        with open(os.path.join(SCAN_DEBUG_DIR, "debug_info.txt"), "w") as f:
            f.write("\n".join(lines) + "\n")

        print(f"[DEBUG] Artifacts written to {SCAN_DEBUG_DIR}")
    except Exception as exc:
        print(f"[WARN] SCAN_DEBUG artifact write failed: {exc}", file=sys.stderr)


def run_ocr_deskew(src: str, dst: str, auto_rotate: bool = True) -> bool:
    cmd = [OCRMYPDF, "--deskew"]
    if auto_rotate:
        cmd += ["--rotate-pages", "--rotate-pages-threshold", "3.0"]
    cmd += ["--output-type", "pdf", "--quiet", "--jobs", str(OCR_JOBS)]
    if OCR_ENABLED:
        cmd += ["--ocr-engine", "tesseract", "-l", OCR_LANGS]
    else:
        cmd += ["--ocr-engine", "none"]
    cmd += [src, dst]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        print(f"[WARN] ocrmypdf failed (rc={r.returncode}):", file=sys.stderr)
        print(r.stderr, file=sys.stderr)
        return False
    return True


def render_pages_to_png(pdf_path: str, out_dir: str) -> list:
    cmd = [
        "gs",
        "-q",
        "-dNOPAUSE",
        "-dBATCH",
        "-dSAFER",
        "-sDEVICE=pnggray",
        f"-r{DETECT_DPI}",
        f"-sOutputFile={out_dir}/page_%04d.png",
        pdf_path,
    ]
    subprocess.run(cmd, check=True, capture_output=True)
    return sorted(glob.glob(f"{out_dir}/page_*.png"))


def page_stats(png_path: str):
    with Image.open(png_path) as img:
        grey = img.convert("L")
        stat = ImageStat.Stat(grey)
        return stat.mean[0], stat.stddev[0]


def _drop_small_components(mask, min_px):
    """
    Drop 8-connected blobs smaller than min_px pixels from a boolean mask.

    Plain flood-fill (BFS) over foreground pixels — no scipy in this image
    (jbarlow83/ocrmypdf base), and for the sizes involved here (a handful of
    components per page: one big content blob plus a few scanner-bed specks)
    a pure-Python BFS is fast enough; the OCR step that runs before this
    already takes far longer per scan.
    """
    H, W = mask.shape
    visited = np.zeros((H, W), dtype=bool)
    out = np.zeros((H, W), dtype=bool)
    ys, xs = np.where(mask)
    for y0, x0 in zip(ys.tolist(), xs.tolist()):
        if visited[y0, x0]:
            continue
        component = [(y0, x0)]
        visited[y0, x0] = True
        q = deque(component)
        while q:
            y, x = q.popleft()
            for dy in (-1, 0, 1):
                for dx in (-1, 0, 1):
                    if dy == 0 and dx == 0:
                        continue
                    ny, nx = y + dy, x + dx
                    if 0 <= ny < H and 0 <= nx < W and mask[ny, nx] and not visited[ny, nx]:
                        visited[ny, nx] = True
                        q.append((ny, nx))
                        component.append((ny, nx))
        if len(component) >= min_px:
            for (cy, cx) in component:
                out[cy, cx] = True
    return out


def clean_content_mask(grey, threshold=CONTENT_THRESHOLD):
    """
    Boolean content mask (numpy) for a greyscale PIL image.

    Content = pixels darker than CONTENT_THRESHOLD.  When MIN_COMPONENT_PX > 1,
    connected blobs smaller than MIN_COMPONENT_PX pixels are dropped as scanner-bed
    noise (see CONTENT_DENOISE_MIN_PX docstring for the case that motivated this,
    and for why MIN_COMPONENT_PX itself is derived from DETECT_DPI).

    Why not a morphological opening?  At DETECT_DPI=100 thermal-printer strokes are only
    1–2 px wide; an opening's erosion step deletes them entirely (a receipt collapses to
    just its QR block), which shrinks the bbox and makes the crop cut through still-visible
    text.  This denoise erodes nothing — surviving blobs keep every one of their pixels;
    only blobs whose *total* pixel count falls under the threshold disappear. A single
    stroke or header block, however thin, accumulates far more than MIN_COMPONENT_PX
    pixels along its length and survives intact.
    """
    a = np.asarray(grey)
    mask = a < threshold
    if MIN_COMPONENT_PX > 1 and mask.any():
        mask = _drop_small_components(mask, MIN_COMPONENT_PX)
    return mask


def content_mask_from_png(png_path: str):
    """Liefert die bereinigte boolesche Inhaltsmaske einer gerenderten Seite."""
    with Image.open(png_path) as img:
        return clean_content_mask(img.convert("L"))


def inner_content_pixel_count(png_path: str) -> int:
    """Zählt dunkle Nutzpixel außerhalb des typischen Scanner-Randbereichs."""
    with Image.open(png_path) as img:
        mask = clean_content_mask(
            img.convert("L"), threshold=BLANK_CONTENT_THRESHOLD
        )
    height, width = mask.shape
    margin_y = max(1, int(height * BLANK_MASK_EDGE_RATIO))
    margin_x = max(1, int(width * BLANK_MASK_EDGE_RATIO))
    if margin_y * 2 >= height or margin_x * 2 >= width:
        inner = mask
    else:
        inner = mask[margin_y:height - margin_y, margin_x:width - margin_x]
    return int(np.count_nonzero(inner))


def classify_auto_blank_page(png_path: str, mean: float, stddev: float) -> tuple:
    """Entscheidet fail-safe über eine automatisch erzeugte Duplex-Seite."""
    blank_by_statistics = (mean >= BLANK_MEAN_MIN) and (stddev <= BLANK_STDDEV_MAX)
    if not blank_by_statistics:
        return False, None
    content_pixels = inner_content_pixel_count(png_path)
    return content_pixels <= BLANK_MASK_MAX_CONTENT_PX, content_pixels


def combine_content_masks(png_paths: list):
    """Legt gleich ausgerichtete Duplex-Masken per OR übereinander.

    Im Duplex-Stapel werden beide Seiten vor OCR gemeinsam gedreht. Abweichende
    Maskengrößen sind danach ein Fehlerzustand, bei dem nicht gecroppt wird.
    """
    combined = None
    for png_path in png_paths:
        mask = content_mask_from_png(png_path)
        if combined is None:
            combined = mask.copy()
        elif mask.shape != combined.shape:
            raise ValueError(
                f"Seitenmasken haben unterschiedliche Größen: "
                f"{combined.shape} != {mask.shape}"
            )
        else:
            combined |= mask
    return combined


def parse_osd_rotation(output: str):
    """Liest Tesseracts benötigte Uhrzeigersinn-Drehung aus der OSD-Ausgabe."""
    match = re.search(r"^Rotate:\s*(0|90|180|270)\s*$", output, re.MULTILINE)
    return int(match.group(1)) if match else None


def detect_sheet_rotation(png_paths: list, composite_path: str) -> int:
    """Ermittelt eine gemeinsame Drehung aus addiertem Vorder-/Rückseiteninhalt."""
    combined = None
    for png_path in png_paths:
        with Image.open(png_path) as img:
            grey = np.asarray(img.convert("L"), dtype=np.uint8)
        if combined is None:
            combined = grey.copy()
        elif grey.shape != combined.shape:
            print(
                f"[ROTATE] Gemeinsame OSD übersprungen: {combined.shape} != {grey.shape}",
                file=sys.stderr,
            )
            return 0
        else:
            combined = np.minimum(combined, grey)

    if combined is None:
        return 0
    Image.fromarray(combined, mode="L").save(composite_path)
    result = subprocess.run(
        [TESSERACT, composite_path, "stdout", "--psm", "0", "-l", "osd"],
        capture_output=True, text=True,
    )
    rotation = parse_osd_rotation(f"{result.stdout}\n{result.stderr}")
    if rotation is None:
        print("[ROTATE] Gemeinsame OSD ohne sichere Drehung – Blatt bleibt unverändert")
        return 0
    print(f"[ROTATE] Gemeinsame Duplex-Drehung erkannt: {rotation}°")
    return rotation


def find_content_bbox_in_mask(mask):
    """Return (left, top, right, bottom) of content, or None for an empty mask."""
    if mask is None:
        return None
    ys, xs = np.where(mask)
    if xs.size == 0:
        return None
    # right/bottom are exclusive, matching PIL's Image.getbbox() convention
    return (int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1)


def compute_crop_box_from_mask(mask, page_w: float, page_h: float):
    """
    Compute a crop box from one page mask or an OR-combined duplex mask.

    Returns (left, bottom, right, top) in PDF points relative to the page
    origin, or None when no crop should be applied.

    Logic:
      - Skip if content bbox > CROP_MAX_FILL_A4 of A4 area.
      - Try snap formats (A6/A5, portrait/landscape, smallest first).
        Snap if bbox fits inside the format AND fills > SNAP_MIN_FILL of it.
      - Fallback: crop to bbox + CROP_MARGIN_PT on each side.
    """
    bbox_px = find_content_bbox_in_mask(mask)
    if bbox_px is None:
        print("[CROP] Kein Inhalt erkannt (alle Pixel über Threshold) — kein Crop")
        return None

    left_px, top_px, right_px, bottom_px = bbox_px

    H_px, W_px = mask.shape

    # Scale: pixel → PDF points
    sx = page_w / W_px
    sy = page_h / H_px

    # Convert to PDF coordinates (origin: bottom-left)
    b_left   = left_px   * sx
    b_right  = right_px  * sx
    b_top    = page_h - top_px    * sy
    b_bottom = page_h - bottom_px * sy
    if b_bottom > b_top:
        b_bottom, b_top = b_top, b_bottom

    b_w    = b_right - b_left
    b_h    = b_top   - b_bottom
    b_area = b_w * b_h
    a4_area = A4_W * A4_H
    fill_a4 = b_area / a4_area

    if fill_a4 > CROP_MAX_FILL_A4:
        print(f"[CROP] Übersprungen: Inhalt belegt {fill_a4*100:.1f}% von A4 (Grenze {CROP_MAX_FILL_A4*100:.0f}%)")
        return None

    print(f"[CROP] Inhalt-BBox: {b_w:.0f}×{b_h:.0f} pt ({fill_a4*100:.1f}% von A4)")

    # Try snap formats from smallest to largest.
    # SNAP_TOLERANCE_PT allows the bbox to slightly exceed the format boundary
    # (scanner shadows / deskew artefacts can inflate the detected bbox by
    # several mm without changing the real document size).
    for fmt_w, fmt_h, fmt_name in SNAP_FORMATS:
        if b_w <= fmt_w + SNAP_TOLERANCE_PT and b_h <= fmt_h + SNAP_TOLERANCE_PT:
            fill_fmt = b_area / (fmt_w * fmt_h)
            if fill_fmt > SNAP_MIN_FILL:
                print(f"[CROP] Einrasten auf {fmt_name} ({fmt_w:.0f}×{fmt_h:.0f} pt, Belegung {fill_fmt*100:.1f}%, Toleranz {SNAP_TOLERANCE_PT} pt)")
                # Center the snap rectangle on the content bbox center
                cx = (b_left + b_right)  / 2
                cy = (b_bottom + b_top)  / 2
                cl = cx - fmt_w / 2;  cr = cx + fmt_w / 2
                cb = cy - fmt_h / 2;  ct = cy + fmt_h / 2
                # Clamp to page boundaries
                if cl < 0:        cr -= cl;           cl = 0.0
                if cr > page_w:   cl -= cr - page_w;  cr = page_w;  cl = max(0.0, cl)
                if cb < 0:        ct -= cb;           cb = 0.0
                if ct > page_h:   cb -= ct - page_h;  ct = page_h;  cb = max(0.0, cb)
                return (cl, cb, cr, ct)

    # No snap format: crop directly to bbox with a small margin
    cl = max(0.0,    b_left   - CROP_MARGIN_PT)
    cr = min(page_w, b_right  + CROP_MARGIN_PT)
    cb = max(0.0,    b_bottom - CROP_MARGIN_PT)
    ct = min(page_h, b_top    + CROP_MARGIN_PT)
    print(f"[CROP] Direkt auf BBox ({cr-cl:.0f}×{ct-cb:.0f} pt, kein Snap-Format passend)")
    return (cl, cb, cr, ct)


def compute_crop_box(png_path: str, page_w: float, page_h: float):
    """Kompatibler Einseiten-Einstieg für die Crop-Berechnung."""
    return compute_crop_box_from_mask(content_mask_from_png(png_path), page_w, page_h)


def apply_crop_to_pdf(src_pdf: str, crop_box: tuple, out_pdf: str):
    """Setzt denselben CropBox auf alle Seiten von src_pdf."""
    cl, cb, cr, ct = crop_box
    with pikepdf.open(src_pdf) as pdf:
        for page in pdf.pages:
            mb = page.mediabox
            ox = float(mb[0])
            oy = float(mb[1])
            pw = float(mb[2]) - ox
            ph = float(mb[3]) - oy
            if cr > pw + 0.5 or ct > ph + 0.5:
                raise ValueError(
                    f"Gemeinsamer CropBox {cr:.1f}×{ct:.1f} pt passt nicht "
                    f"auf Seite {pw:.1f}×{ph:.1f} pt"
                )
            page["/CropBox"] = pikepdf.Array([ox + cl, oy + cb, ox + cr, oy + ct])
        pdf.save(out_pdf)


def apply_uniform_rotation_to_pdf(src_pdf: str, rotation: int, out_pdf: str):
    """Dreht alle Seiten eines physischen Blatts gleich und backt /Rotate ein."""
    rotated_pdf = out_pdf + ".rotate.tmp.pdf"
    try:
        with pikepdf.open(src_pdf) as pdf:
            for page in pdf.pages:
                current = int(page.obj.get("/Rotate", 0)) % 360
                page.obj["/Rotate"] = (current + rotation) % 360
            pdf.save(rotated_pdf)
        subprocess.run(
            [QPDF, "--flatten-rotation", rotated_pdf, out_pdf],
            check=True, capture_output=True,
        )
    finally:
        if os.path.exists(rotated_pdf):
            os.unlink(rotated_pdf)


def remove_blank_pages(src_pdf: str, blank_indices: set, out_pdf: str):
    with pikepdf.open(src_pdf) as src:
        new = pikepdf.new()
        for i, page in enumerate(src.pages):
            if i not in blank_indices:
                new.pages.append(page)
        new.save(out_pdf)


# Quellen, bei denen automatisch erzeugte Leerseiten zu erwarten sind (Duplex-
# Rückseite eines einseitig bedruckten Originals). Der Dateiname trägt das
# Präfix aus scanner/scan_service.py (_new_outfile). Bei allen anderen
# Mehrseiten-Quellen hat der Nutzer jede Seite bewusst selbst gescannt (ADF
# simplex, Flachbett-Session) — dort darf eine Seite nie automatisch
# verschwinden, auch wenn sie inhaltlich sehr hell ist.
AUTO_BLANK_REMOVAL_PREFIXES = ("adf_duplex_",)
AUTO_CROP_DUPLEX_BATCH_PREFIXES = ("adf_duplex_batch_",)


def process(input_path: str, output_path: str) -> int:
    quelle_dateiname = os.path.basename(input_path)
    auto_blank_removal = quelle_dateiname.startswith(AUTO_BLANK_REMOVAL_PREFIXES)
    auto_crop_duplex_batch = quelle_dateiname.startswith(AUTO_CROP_DUPLEX_BATCH_PREFIXES)

    with tempfile.TemporaryDirectory(prefix="scanproc_") as tmpdir:
        deskewed = os.path.join(tmpdir, "deskewed.pdf")
        ocr_input = input_path

        # Duplex-Stapel sind ein physisches Blatt. Deshalb wird die Drehung vor
        # OCR genau einmal aus dem addierten Inhalt beider Rohseiten bestimmt
        # und identisch auf Vorder- und Rückseite angewendet. OCRmyPDF darf die
        # Seiten danach nicht mehr unabhängig gegeneinander drehen.
        if auto_crop_duplex_batch:
            raw_render_dir = os.path.join(tmpdir, "raw-renders")
            os.makedirs(raw_render_dir, exist_ok=True)
            raw_pngs = render_pages_to_png(input_path, raw_render_dir)
            rotation = detect_sheet_rotation(
                raw_pngs, os.path.join(tmpdir, "duplex-composite.png")
            )
            if rotation:
                oriented = os.path.join(tmpdir, "sheet-oriented.pdf")
                apply_uniform_rotation_to_pdf(input_path, rotation, oriented)
                ocr_input = oriented

        if not run_ocr_deskew(ocr_input, deskewed, auto_rotate=not auto_crop_duplex_batch):
            print("[INFO] Deskew/OCR failed — will continue with the oriented input", file=sys.stderr)
            work_pdf = ocr_input
        else:
            work_pdf = deskewed
            print("[INFO] Deskew/OCR completed")

        render_dir = os.path.join(tmpdir, "renders")
        os.makedirs(render_dir, exist_ok=True)
        pngs = render_pages_to_png(work_pdf, render_dir)
        total = len(pngs)
        if total == 0:
            print("[ERROR] No pages rendered", file=sys.stderr)
            return 4

        blank_indices = set()
        for i, png in enumerate(pngs):
            mean, stddev = page_stats(png)
            content_pixels = None
            if total == 1:
                # Single-page scan: apply stricter thresholds so small receipts
                # are not falsely discarded (only truly featureless pages pass).
                is_blank = (mean >= BLANK_MEAN_MIN_SINGLE) and (stddev <= BLANK_STDDEV_MAX_SINGLE)
            elif auto_blank_removal:
                is_blank, content_pixels = classify_auto_blank_page(png, mean, stddev)
            else:
                # Jede Seite kam aus einem bewussten Nutzer-Scan (ADF simplex,
                # Flachbett-Session) — hier gibt es keine automatisch erzeugte
                # Rückseite, die verschwinden dürfte.
                is_blank = False
            tag = "BLANK" if is_blank else "content"
            mask_info = f" mask_px={content_pixels}" if content_pixels is not None else ""
            print(f"  Page {i+1}/{total}: mean={mean:.1f} stddev={stddev:.2f}{mask_info} [{tag}]")
            if is_blank:
                blank_indices.add(i)

        kept = total - len(blank_indices)
        print(f"[INFO] Keeping {kept} of {total} pages (removed {len(blank_indices)})")

        if kept == 0:
            return 3

        if not blank_indices:
            shutil.copy(work_pdf, output_path)
        else:
            remove_blank_pages(work_pdf, blank_indices, output_path)

        # ── Crop: Einzelseiten und ADF-Duplex-Stapel ─────────────────
        # Bei Einzelseiten wird wie bisher die einzige verbliebene Seite
        # beurteilt. Beim Duplex-Stapel entsteht aus Vorder- und Rückseite eine
        # gemeinsame Inhaltsmaske; ihr Ausschnitt gilt für beide PDF-Seiten.
        crop_box = None
        _pw, _ph = A4_W, A4_H  # fallback dimensions for debug
        kept_indices = sorted(set(range(total)) - blank_indices)
        kept_index = kept_indices[0]
        aligned_content_mask = None
        if auto_crop_duplex_batch:
            try:
                aligned_content_mask = combine_content_masks([pngs[i] for i in kept_indices])
                print(f"[CROP] {len(kept_indices)} Duplex-Maske(n) additiv überlagert")
            except ValueError as exc:
                aligned_content_mask = None
                print(f"[CROP] Übersprungen: {exc}", file=sys.stderr)

        if CROP_ENABLED and (kept == 1 or auto_crop_duplex_batch):
            with pikepdf.open(output_path) as _pdf:
                _mb = _pdf.pages[0].mediabox
                _pw = float(_mb[2]) - float(_mb[0])
                _ph = float(_mb[3]) - float(_mb[1])
            if auto_crop_duplex_batch:
                crop_box = compute_crop_box_from_mask(
                    aligned_content_mask, _pw, _ph
                ) if aligned_content_mask is not None else None
            else:
                crop_box = compute_crop_box(pngs[kept_index], _pw, _ph)
            if crop_box is not None:
                _tmp = output_path + ".crop.tmp"
                apply_crop_to_pdf(output_path, crop_box, _tmp)
                os.replace(_tmp, output_path)
                cl, cb, cr, ct = crop_box
                print(f"[CROP] CropBox gesetzt: {cr-cl:.0f}×{ct-cb:.0f} pt")

        # ── Debug artifacts (SCAN_DEBUG=1, single-page only) ─────────────
        if SCAN_DEBUG and kept == 1:
            _write_debug_artifacts(pngs[kept_index], crop_box, _pw, _ph)

        return 0


def analyze_test_scan(input_path: str, preview_path: str) -> dict:
    """Analysiert die erste Seite mit exakt denselben Masken wie die Pipeline.

    Der Kalibrierungsassistent startet diese Funktion in einem eigenen Prozess
    mit den gerade eingestellten Werten als ENV. Dadurch bleiben die globalen
    Pipeline-Konstanten unverändert und parallele Vorschauen beeinflussen sich
    nicht gegenseitig.
    """
    with tempfile.TemporaryDirectory(prefix="scan_analysis_") as tmpdir:
        pngs = render_pages_to_png(input_path, tmpdir)
        if not pngs:
            raise ValueError("Test-PDF enthält keine Seite")
        png_path = pngs[0]
        mean, stddev = page_stats(png_path)
        content_pixels = inner_content_pixel_count(png_path)
        blank_by_statistics = (mean >= BLANK_MEAN_MIN) and (stddev <= BLANK_STDDEV_MAX)
        is_blank = blank_by_statistics and content_pixels <= BLANK_MASK_MAX_CONTENT_PX

        with pikepdf.open(input_path) as pdf:
            mb = pdf.pages[0].mediabox
            page_w = float(mb[2]) - float(mb[0])
            page_h = float(mb[3]) - float(mb[1])

        mask = content_mask_from_png(png_path)
        crop_box = compute_crop_box_from_mask(mask, page_w, page_h) if CROP_ENABLED else None

        with Image.open(png_path) as source:
            preview = source.convert("RGB")
        if crop_box is not None:
            cl, cb, cr, ct = crop_box
            width, height = preview.size
            rectangle = (
                round(cl / page_w * width),
                round((page_h - ct) / page_h * height),
                round(cr / page_w * width),
                round((page_h - cb) / page_h * height),
            )
            draw = ImageDraw.Draw(preview)
            line_width = max(3, round(min(width, height) / 180))
            draw.rectangle(rectangle, outline=(220, 38, 38), width=line_width)
        preview.save(preview_path, "PNG")

        return {
            "blank": bool(is_blank),
            "blankByStatistics": bool(blank_by_statistics),
            "mean": round(mean, 2),
            "stddev": round(stddev, 2),
            "contentPixels": content_pixels,
            "cropBox": [round(v, 2) for v in crop_box] if crop_box else None,
            "pageSize": [round(page_w, 2), round(page_h, 2)],
        }


def render_test_scan_preview(input_path: str, preview_path: str) -> dict:
    """Rendert die rohe erste PDF-Seite ohne Maske oder Crop-Markierung."""
    with tempfile.TemporaryDirectory(prefix="scan_raw_preview_") as tmpdir:
        pngs = render_pages_to_png(input_path, tmpdir)
        if not pngs:
            raise ValueError("Test-PDF enthält keine Seite")
        shutil.copyfile(pngs[0], preview_path)
        with Image.open(preview_path) as image:
            width, height = image.size
        return {"width": width, "height": height}


def main():
    if len(sys.argv) == 4 and sys.argv[1] == "--preview":
        inp, preview = sys.argv[2], sys.argv[3]
        if not os.path.isfile(inp):
            print(f"[ERROR] Input not found: {inp}", file=sys.stderr)
            sys.exit(2)
        try:
            with contextlib.redirect_stdout(sys.stderr):
                result = render_test_scan_preview(inp, preview)
            print(json.dumps(result, ensure_ascii=False))
        except Exception as exc:
            import traceback
            print(f"[ERROR] Vorschau fehlgeschlagen: {exc}", file=sys.stderr)
            traceback.print_exc(file=sys.stderr)
            sys.exit(4)
        sys.exit(0)
    if len(sys.argv) == 4 and sys.argv[1] == "--analyze":
        inp, preview = sys.argv[2], sys.argv[3]
        if not os.path.isfile(inp):
            print(f"[ERROR] Input not found: {inp}", file=sys.stderr)
            sys.exit(2)
        try:
            # Crop-Hinweise gehören ins Serverlog, stdout bleibt maschinenlesbar.
            with contextlib.redirect_stdout(sys.stderr):
                result = analyze_test_scan(inp, preview)
            print(json.dumps(result, ensure_ascii=False))
        except Exception as exc:
            import traceback
            print(f"[ERROR] Analyse fehlgeschlagen: {exc}", file=sys.stderr)
            traceback.print_exc(file=sys.stderr)
            sys.exit(4)
        sys.exit(0)
    if len(sys.argv) != 3:
        print(f"Usage: {sys.argv[0]} <input.pdf> <output.pdf>", file=sys.stderr)
        sys.exit(1)
    inp, out = sys.argv[1], sys.argv[2]
    if not os.path.isfile(inp):
        print(f"[ERROR] Input not found: {inp}", file=sys.stderr)
        sys.exit(2)
    try:
        rc = process(inp, out)
    except Exception as e:
        import traceback
        print(f"[ERROR] Unexpected: {e}", file=sys.stderr)
        traceback.print_exc(file=sys.stderr)
        sys.exit(4)
    sys.exit(rc)


if __name__ == "__main__":
    main()
