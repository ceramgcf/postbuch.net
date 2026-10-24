"""Lagert die großen Gewichte eines ONNX-Modells in eine externe Datei aus.

onnxruntime blendet externe Gewichte per mmap ein. Sie zählen dann als
dateigestützter Speicher, den der Kernel bei Bedarf verwerfen kann, statt als
anonymer Speicher des Prozesses. Jeder Block beginnt an einer 64-KiB-Grenze,
damit das Einblenden ohne Kopie gelingt.

Das onnx-Paket würde das ganze Modell (über 300 MB) als Python-Objekte in den
Speicher laden. Das passt auf einem Raspberry Pi mit 1 GB nicht neben einen
laufenden Stack. Deshalb liest dieses Skript das Protobuf-Wire-Format selbst:
die Eingabe wird per mmap gelesen, die Gewichte gehen direkt in die
Ausgabedatei, nur der kleine Graph ohne Gewichte entsteht im Speicher.

Gelesen werden nur die Felder, die das Auslagern braucht (ModelProto.graph,
GraphProto.initializer, TensorProto.raw_data); alles andere wird Byte für
Byte übernommen. Gewichte in Untergraphen (If/Loop) bleiben eingebettet. Das
Dockerfile lädt das Ergebnis im Prüflauf, ein Formatbruch fällt beim Build
auf. Rückbaupfad, falls eine spätere Modellrevision das Format sprengt: das Modell
auf einem Rechner mit genug Speicher mit dem onnx-Paket auslagern
(internaldocs/testablaeufe/modellvergleich/embedding-2026-10/optimierung/extern.py)
und das Ergebnis statt dieses Schritts verwenden.

Aufruf: repack.py <eingabe.onnx> <ausgabe.onnx> [Schwelle in Bytes]
Die externe Datei heißt wie die Ausgabe, nur mit Endung .data.
"""
import mmap
import os
import sys

ALIGN = 65536
# Feldnummern laut onnx.proto
MODEL_GRAPH = 7
GRAPH_INITIALIZER = 5
TENSOR_RAW_DATA = 9
TENSOR_EXTERNAL_DATA = 13
TENSOR_DATA_LOCATION = 14
EXTERNAL = 1


def varint(buf, pos):
    wert = shift = 0
    while True:
        b = buf[pos]
        pos += 1
        wert |= (b & 0x7F) << shift
        if b < 0x80:
            return wert, pos
        shift += 7


def kodiere_varint(wert):
    aus = bytearray()
    while True:
        b = wert & 0x7F
        wert >>= 7
        if wert:
            aus.append(b | 0x80)
        else:
            aus.append(b)
            return bytes(aus)


def felder(buf, start, ende):
    """Liefert (feldnummer, wiretyp, feldanfang, nutzanfang, feldende)."""
    pos = start
    while pos < ende:
        anfang = pos
        schluessel, pos = varint(buf, pos)
        nummer, typ = schluessel >> 3, schluessel & 7
        if typ == 0:
            _, pos = varint(buf, pos)
            yield nummer, typ, anfang, anfang, pos
            continue
        if typ == 1:
            pos += 8
            yield nummer, typ, anfang, anfang, pos
            continue
        if typ == 5:
            pos += 4
            yield nummer, typ, anfang, anfang, pos
            continue
        if typ != 2:
            raise ValueError(f"Wiretyp {typ} wird nicht unterstützt")
        laenge, pos = varint(buf, pos)
        yield nummer, typ, anfang, pos, pos + laenge
        pos += laenge


def laengenfeld(nummer, nutz):
    return kodiere_varint((nummer << 3) | 2) + kodiere_varint(len(nutz)) + nutz


def eintrag(schluessel, wert):
    nutz = laengenfeld(1, schluessel.encode()) + laengenfeld(2, wert.encode())
    return laengenfeld(TENSOR_EXTERNAL_DATA, nutz)


def main():
    quelle, ziel = sys.argv[1], sys.argv[2]
    schwelle = int(sys.argv[3]) if len(sys.argv) > 3 else ALIGN
    datei = os.path.basename(ziel).rsplit(".", 1)[0] + ".data"
    with open(quelle, "rb") as f:
        buf = mmap.mmap(f.fileno(), 0, access=mmap.ACCESS_READ)
    pos_daten = 0
    ausgelagert = 0
    modell = bytearray()
    with open(os.path.join(os.path.dirname(ziel) or ".", datei), "wb") as daten:
        for nr, _typ, anfang, nutz, ende in felder(buf, 0, len(buf)):
            if nr != MODEL_GRAPH:
                modell += buf[anfang:ende]
                continue
            graph = bytearray()
            for gnr, _gtyp, ganfang, gnutz, gende in felder(buf, nutz, ende):
                if gnr != GRAPH_INITIALIZER:
                    graph += buf[ganfang:gende]
                    continue
                roh = None
                rest = bytearray()
                for tnr, _ttyp, tanfang, tnutz, tende in felder(buf, gnutz, gende):
                    if tnr == TENSOR_RAW_DATA:
                        roh = (tnutz, tende)
                    else:
                        rest += buf[tanfang:tende]
                if roh is None or roh[1] - roh[0] < schwelle:
                    graph += buf[ganfang:gende]
                    continue
                luecke = (-pos_daten) % ALIGN
                daten.write(b"\0" * luecke)
                pos_daten += luecke
                laenge = roh[1] - roh[0]
                daten.write(memoryview(buf)[roh[0]:roh[1]])
                rest += eintrag("location", datei)
                rest += eintrag("offset", str(pos_daten))
                rest += eintrag("length", str(laenge))
                rest += kodiere_varint(TENSOR_DATA_LOCATION << 3) + kodiere_varint(EXTERNAL)
                graph += laengenfeld(GRAPH_INITIALIZER, bytes(rest))
                pos_daten += laenge
                ausgelagert += 1
            modell += laengenfeld(MODEL_GRAPH, bytes(graph))
    with open(ziel, "wb") as f:
        f.write(modell)
    print(f"{ausgelagert} Gewichte ausgelagert, {pos_daten // 1048576} MB extern, "
          f"Graph {len(modell) // 1024} KB")


if __name__ == "__main__":
    main()
