#!/bin/sh
set -e
INPUT_DIR=/input
OUTPUT_DIR=/output
TMPDIR=$(mktemp -d /tmp/scanproc.XXXX)
FILE="$1"
if [ -z "$FILE" ]; then
  echo "no file"
  exit 1
fi
infile="$INPUT_DIR/$FILE"
outfile="$OUTPUT_DIR/$FILE"

if [ ! -f "$infile" ]; then
  echo "input not found: $infile"
  exit 2
fi

# 1) deskew & basic cleaning, but NO OCR
# Note: --remove-background not supported in this ocrmypdf build, omit it
ocrmypdf --deskew --ocr-engine none "$infile" "$TMPDIR/processed.pdf"

# 2) rasterize to PGM pages at low-res for blank detection
gs -q -dNOPAUSE -dBATCH -sDEVICE=pgmraw -r100 -sOutputFile="$TMPDIR/page%03d.pgm" "$TMPDIR/processed.pdf"

# 3) detect mostly-white pages
KEEP_FILES=""
for pgm in $TMPDIR/page*.pgm; do
  python3 - <<PY "$pgm"
import sys
fn = sys.argv[1]
with open(fn,'rb') as f:
    # read magic
    magic = f.readline()
    # skip comments
    line = f.readline()
    while line.startswith(b'#'):
        line = f.readline()
    w,h = map(int, line.split())
    maxv = int(f.readline().strip())
    data = f.read()
    if len(data)==0:
        print(255)
    else:
        mean = sum(data)/len(data)
        print(int(mean))
PY
  mean=$?
  # The python prints the mean and returns exit code 0; capture printed value
  mean_val=$(python3 -c "import sys; print(open(sys.argv[1],'rb').read().splitlines()[-1])" "$pgm" 2>/dev/null || true)
  # fallback: compute mean again in shell if above failed
  if [ -z "$mean_val" ]; then
    mean_val=$(python3 - <<PY "$pgm"
import sys
fn=sys.argv[1]
with open(fn,'rb') as f:
    magic=f.readline()
    line=f.readline()
    while line.startswith(b'#'):
        line=f.readline()
    w,h=map(int,line.split())
    maxv=int(f.readline().strip())
    data=f.read()
    print(int(sum(data)/len(data)) if len(data)>0 else 255)
PY
)
  fi
  # consider page blank if mean_val > 250
  if [ "$mean_val" -lt 250 ]; then
    KEEP_FILES="$KEEP_FILES $pgm"
  fi
done

if [ -z "$KEEP_FILES" ]; then
  echo "no non-blank pages, moving input to failed output"
  mv "$infile" "$OUTPUT_DIR/FAILED_$FILE" || true
else
  # assemble kept pages into final PDF using img2pdf
  img2pdf $KEEP_FILES -o "$outfile"
  rm -f "$infile"
fi

rm -rf "$TMPDIR"
exit 0
