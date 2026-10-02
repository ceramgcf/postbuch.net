#!/bin/sh
INPUT=/input
TMPDIR=/tmp/cleaner_out

mkdir -p "$INPUT" "$TMPDIR"
echo "[cleaner] watching $INPUT ..."
echo "[cleaner] webhook: ${APP_WEBHOOK_URL:-NOT SET}"
echo "[cleaner] scan-registered: ${APP_WEBHOOK_REGISTERED_URL:-NOT SET}"
echo "[cleaner] config source: ${APP_URL:-ENV only}"

# Der Kalibrierungsassistent nutzt denselben Analysecode wie die echte
# Verarbeitung. Der Server ist nur im Docker-Netz erreichbar.
python3 /usr/local/bin/test_scan_server.py &
ANALYSIS_PID=$!
trap 'kill "$ANALYSIS_PID" 2>/dev/null || true' EXIT INT TERM

# Fetches cleaner config from app API and exports as ENV vars.
# Falls back silently to existing ENV values if app is unreachable.
# Liefert auch WEBHOOK_TOKEN — ohne den weist die App /api/webhooks/* mit 401 ab.
# In dem Fall bleibt die Eingangsdatei liegen und der nächste drain() versucht es erneut.
fetch_config() {
  [ -z "${APP_URL:-}" ] && return
  CONFIG=$(curl -s --connect-timeout 5 --max-time 10 \
    "${APP_URL}/api/internal/config" 2>/dev/null) || CONFIG=''
  [ -z "$CONFIG" ] && return

  VARS=$(python3 -c "
import json, sys
try:
    cfg = json.loads(sys.argv[1])
    c = cfg.get('cleaner', {})
    print('WEBHOOK_TOKEN='        + str(cfg.get('webhook_token') or ''))
    print('OCR_ENABLED='          + ('1' if c.get('ocr_enabled', True) else '0'))
    print('OCR_LANGS='            + str(c.get('ocr_langs', 'deu')))
    print('OCR_JOBS='             + str(int(c.get('ocr_jobs', 1))))
    print('BLANK_MEAN_MIN='       + str(int(c.get('blank_mean_min', 240))))
    print('BLANK_STDDEV_MAX='     + str(c.get('blank_stddev_max', 12)))
    print('BLANK_MEAN_MIN_SINGLE=' + str(int(c.get('blank_mean_min_single', 253))))
    print('BLANK_STDDEV_MAX_SINGLE=' + str(c.get('blank_stddev_max_single', 4)))
    print('CROP_ENABLED='         + ('1' if c.get('crop_enabled', True) else '0'))
    print('DETECT_DPI='           + str(int(c.get('detect_dpi', 75))))
    print('CONTENT_THRESHOLD='    + str(int(c.get('content_threshold', 200))))
    print('CONTENT_DENOISE_MIN_PX=' + str(int(c.get('content_denoise_min_px', 10))))
    print('BLANK_CONTENT_THRESHOLD=' + str(int(c.get('blank_content_threshold', 200))))
    print('BLANK_MASK_MAX_CONTENT_PX=' + str(int(c.get('blank_mask_max_content_px', 200))))
except Exception as e:
    import sys; print('# config parse error: ' + str(e), file=sys.stderr)
" "$CONFIG" 2>/dev/null) || return

  while IFS='=' read -r k v; do
    case "$k" in
      '#'*|'') continue ;;
    esac
    export "$k=$v"
  done << EOF
$VARS
EOF
  echo "[cleaner] config loaded from app"
}

# Process a single PDF file by path.
# Guards against duplicates: skips if file is already gone.
process_file() {
  FILE=$(basename "$1")
  case "$FILE" in
    *.pdf|*.PDF) ;;
    *) echo "[cleaner] skip non-PDF: $FILE"; return ;;
  esac

  INPATH="$INPUT/$FILE"
  OUTPATH="$TMPDIR/$FILE"
  [ -f "$INPATH" ] || return   # already processed by a previous drain iteration

  echo "[cleaner] processing: $FILE"

  # Config frisch holen (Latenz vernachlässigbar vs. OCR-Zeit ~60-90s)
  fetch_config

  # Scan sofort im Monitoring registrieren, BEVOR die OCR startet (~60-90s).
  JOB_ID=""
  if [ -n "${APP_WEBHOOK_REGISTERED_URL:-}" ]; then
    JOB_RESPONSE=$(curl -s -X POST "${APP_WEBHOOK_REGISTERED_URL}" \
      -H "X-Filename: $FILE" \
      -H "X-Webhook-Token: ${WEBHOOK_TOKEN:-}" \
      --connect-timeout 5 --max-time 10 2>/dev/null || true)
    JOB_ID=$(printf '%s' "$JOB_RESPONSE" | python3 -c \
      "import sys,json; d=json.load(sys.stdin); print(d.get('jobId',''))" 2>/dev/null || true)
    [ -n "$JOB_ID" ] && echo "[cleaner] job registered: $JOB_ID for $FILE" \
                     || echo "[cleaner] scan-registered failed for $FILE"
  fi

  /app/.venv/bin/python3 /usr/local/bin/process_scan.py "$INPATH" "$OUTPATH"
  RC=$?

  case $RC in
    0)
       # POST cleaned PDF to app webhook (mit optionalem X-Job-Id)
       HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
         -X POST "${APP_WEBHOOK_URL}" \
         -H "Content-Type: application/pdf" \
         -H "X-Filename: $FILE" \
         -H "X-Job-Id: ${JOB_ID:-}" \
         -H "X-Webhook-Token: ${WEBHOOK_TOKEN:-}" \
         --data-binary "@$OUTPATH" \
         --fail --max-time 30)
       if [ "$HTTP_CODE" -ge 200 ] && [ "$HTTP_CODE" -lt 300 ]; then
         rm -f "$INPATH" "$OUTPATH"
         echo "[cleaner] done: $FILE -> webhook (HTTP $HTTP_CODE)"
       else
         echo "[cleaner] webhook failed (HTTP $HTTP_CODE) for $FILE, keeping input"
         rm -f "$OUTPATH"
       fi
       ;;
    3) echo "[cleaner] all pages blank in $FILE, removing"
       rm -f "$INPATH"
       # Job als fehlgeschlagen markieren, damit er nicht hängenbleibt
       if [ -n "$JOB_ID" ] && [ -n "${APP_WEBHOOK_REGISTERED_URL:-}" ]; then
         ABORT_URL="${APP_WEBHOOK_REGISTERED_URL%/scan-registered}/scan-aborted"
         curl -s -X POST "$ABORT_URL" \
           -H "X-Job-Id: $JOB_ID" \
           -H "X-Reason: Alle Seiten leer (Blank-Scan)" \
           -H "X-Webhook-Token: ${WEBHOOK_TOKEN:-}" \
           --connect-timeout 5 --max-time 10 >/dev/null 2>&1 || true
         echo "[cleaner] job $JOB_ID aborted (blank)"
       fi
       ;;
    *) echo "[cleaner] error (rc=$RC) for $FILE, leaving in input" ;;
  esac
}

# Drain: process every PDF currently sitting in INPUT.
# Called on startup and after each inotify-triggered processing, so files
# that arrived while OCR was running are never left behind.
drain() {
  for f in "$INPUT"/*.pdf "$INPUT"/*.PDF; do
    [ -f "$f" ] && process_file "$f"
  done
}

# Initial config fetch on startup
fetch_config

# Handle files that were already present before this container started.
drain

while true; do
  # Wait for a filesystem event but wake up periodically (-t) so we
  # also call drain() for files that might have been missed by inotify.
  FILE=$(inotifywait -q -t 10 -e close_write -e moved_to -e create --format '%f' "$INPUT") || FILE=""
  [ -n "$FILE" ] && process_file "$FILE"
  # Drain any further files that landed while we were processing the one above
  # or files that arrived while inotify was not triggered.
  drain
done
