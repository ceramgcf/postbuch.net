# Eingebauter Embedding-Dienst: Snowflake arctic-embed-m-v2.0 (int8, ONNX,
# im Image), dazu Voyage 4 Nano und EmbeddingGemma 2 als GGUF über llama.cpp
# (Dateien lädt der Dienst erst bei Bedarf, siehe server.py).
#
# Das Image ist release-unabhängig wie caddy: docker-compose.yml gibt ihm einen
# festen Namen (postbuch-embedding:localN), der Installer baut es nur, wenn es
# fehlt. Jede Änderung in embedding/ braucht deshalb einen Tag-Bump dort.
#
# python:3.13 statt 3.15 wie beim Scanner: onnxruntime liefert Wheels nur für
# die etablierten Python-Versionen.

# llama.cpp ist gegen eine neuere glibc gebaut als python:3.13-slim. Der
# Server kommt deshalb mit allen Bibliotheken seines Images samt eigenem
# Lader; server.py startet ihn über diesen Lader (Datei LADER).
FROM ghcr.io/ggml-org/llama.cpp:server@sha256:5b43086e3ba7ea5794d72904654f6cd41224a9b1c6ac0398f4940ee380d30f23 AS llama
RUN mkdir -p /bundle/lib /bundle/lizenzen/ubuntu && cp -a /app/llama-server /app/*.so* /bundle/ \
 && ldd /app/llama-server /app/*.so* 2>/dev/null | awk '/=> \// {print $3} /^\t\/.*ld-linux/ {print $1}' | sort -u \
    | while read -r f; do \
        cp -L "$f" /bundle/lib/ || exit 1; \
        treffer=$(dpkg-query -S "$(realpath "$f")") || exit 1; \
        printf '%s\n' "$treffer" | sed -n 's/: .*//p'; \
      done > /bundle/lizenzen/ubuntu/pakete \
 && sort -u /bundle/lizenzen/ubuntu/pakete | while read -r paket; do \
        cp -L "/usr/share/doc/${paket%%:*}/copyright" "/bundle/lizenzen/ubuntu/${paket%%:*}.copyright" || exit 1; \
        dpkg-query -W -f='${binary:Package} ${Version} https://launchpad.net/ubuntu/+source/${source:Package}/${source:Version}\n' "$paket" || exit 1; \
      done > /bundle/lizenzen/ubuntu/quellen.txt \
 && test -s /bundle/lizenzen/ubuntu/quellen.txt \
 && rm /bundle/lizenzen/ubuntu/pakete \
 && cp -a /usr/share/common-licenses /bundle/lizenzen/ubuntu/ \
 && basename "$(ls /bundle/lib/ld-linux-* | head -1)" > /bundle/lib/LADER

FROM python:3.13-slim@sha256:e48f59cdba69a3cbd9ed2cf0f348d90d45a8d350d98134cf1070bc106ee9ed90 AS modell

# Gepinnte Revisionen; die Prüfsummen schützen gegen ausgetauschte Dateien.
# Arctic: Apache 2.0, Tokenizer aus xlm-roberta-base: MIT (THIRD-PARTY-NOTICES.md).
ARG ARCTIC_REV=95c2741480856aa9666782eb4afe11959938017f
ARG ARCTIC_SHA256=03d923bb1850ebdccb068e2f3abd8aa43fe81c50d07d037ef103fe3d0fb78e3b
ARG SPM_REV=e73636d4f797dec63c3081bb6ed5c7b0bb3f2089
ARG SPM_SHA256=cfc8146abe2a0488e9e2a0c56de7952f7c11ab059eca145a0a727afce0db2865

COPY repack.py holen.py /werkzeug/
RUN mkdir -p /roh /modell \
 && python /werkzeug/holen.py \
      "https://huggingface.co/Snowflake/snowflake-arctic-embed-m-v2.0/resolve/${ARCTIC_REV}/onnx/model_int8.onnx" \
      /roh/model_int8.onnx "${ARCTIC_SHA256}" \
 && python /werkzeug/holen.py \
      "https://huggingface.co/FacebookAI/xlm-roberta-base/resolve/${SPM_REV}/sentencepiece.bpe.model" \
      /modell/sentencepiece.bpe.model "${SPM_SHA256}" \
 && python /werkzeug/repack.py /roh/model_int8.onnx /modell/model.onnx \
 && rm -rf /roh

# Das SentencePiece-Wheel enthält die Lizenztexte seiner C++-Abhängigkeiten
# nicht. Übernehme die Originale aus der für das Wheel verwendeten Version.
RUN mkdir -p /sentencepiece-lizenzen \
 && quelle=https://raw.githubusercontent.com/google/sentencepiece/v0.2.2/third_party \
 && python /werkzeug/holen.py "$quelle/darts_clone/LICENSE" \
      /sentencepiece-lizenzen/darts_clone.txt 155f59997298ee336602c49f9c1110f268ac394ca2197eb02647a3555935ad52 \
 && python /werkzeug/holen.py "$quelle/esaxx/LICENSE" \
      /sentencepiece-lizenzen/esaxx.txt 7c28553d1d3312d65fe309f76a22ebaf33a3d76c8c1e3b98a88ee4654ecb53db \
 && python /werkzeug/holen.py "$quelle/protobuf-lite/LICENSE" \
      /sentencepiece-lizenzen/protobuf-lite.txt 6e5e117324afd944dcf67f36cf329843bc1a92229a8cd9bb573d7a83130fea7d

FROM python:3.13-slim@sha256:e48f59cdba69a3cbd9ed2cf0f348d90d45a8d350d98134cf1070bc106ee9ed90

ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1
RUN pip install --no-cache-dir onnxruntime==1.31.0 numpy==2.5.4 sentencepiece==0.2.2 \
 && useradd --system --no-create-home --shell /usr/sbin/nologin embedding
COPY --from=modell /modell /modell
COPY --from=llama /bundle/llama-server /bundle/*.so* /opt/llama/
COPY --from=llama /bundle/lib /opt/llama/lib
COPY --from=llama /bundle/lizenzen /usr/share/doc/postbuch.net/
COPY --from=modell /sentencepiece-lizenzen /usr/share/doc/postbuch.net/sentencepiece/
COPY lizenzen/ /usr/share/doc/postbuch.net/
COPY server.py holen.py /app/
# /daten nimmt die GGUF-Modelle auf (benanntes Volume, übernimmt den Besitzer).
RUN mkdir -p /daten && chown embedding /daten \
 && /opt/llama/lib/$(cat /opt/llama/lib/LADER) --library-path /opt/llama/lib:/opt/llama /opt/llama/llama-server --version

# Prüflauf: das umgepackte Modell muss laden und einen normierten Vektor der
# erwarteten Länge liefern. Ein kaputter Repack bricht so den Build ab und
# fällt nicht erst bei der ersten Anfrage einer Instanz auf.
RUN cd /app && python -c "import server; v, _ = server.bette_ein(['Prüflauf']); \
assert len(v[0]) == server.MODELLE[server.ARCTIC]['dim'], len(v[0]); \
assert abs(sum(x * x for x in v[0]) - 1) < 1e-3; print('Prüflauf bestanden')"

USER embedding
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/health', timeout=4)"
CMD ["python", "/app/server.py"]
