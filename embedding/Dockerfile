# Eingebauter Embedding-Dienst (Snowflake arctic-embed-m-v2.0, int8).
#
# Das Image ist release-unabhängig wie caddy: docker-compose.yml gibt ihm einen
# festen Namen (postbuch-embedding:localN), der Installer baut es nur, wenn es
# fehlt. Jede Änderung in embedding/ braucht deshalb einen Tag-Bump dort.
#
# python:3.13 statt 3.15 wie beim Scanner: onnxruntime liefert Wheels nur für
# die etablierten Python-Versionen.

FROM python:3.13-slim@sha256:57b29a7c050c4e679e4bea572e14b3965cf4b5839de2da49d55e49ffc4024f39 AS modell

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

FROM python:3.13-slim@sha256:57b29a7c050c4e679e4bea572e14b3965cf4b5839de2da49d55e49ffc4024f39

ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1
RUN pip install --no-cache-dir onnxruntime==1.31.0 numpy==2.5.4 sentencepiece==0.2.2 \
 && useradd --system --no-create-home --shell /usr/sbin/nologin embedding
COPY --from=modell /modell /modell
COPY server.py /app/server.py

# Prüflauf: das umgepackte Modell muss laden und einen normierten Vektor der
# erwarteten Länge liefern. Ein kaputter Repack bricht so den Build ab und
# fällt nicht erst bei der ersten Anfrage einer Instanz auf.
RUN cd /app && python -c "import server; v, _ = server.bette_ein(['Prüflauf']); \
assert len(v[0]) == server.DIM, len(v[0]); \
assert abs(sum(x * x for x in v[0]) - 1) < 1e-3; print('Prüflauf bestanden')"

USER embedding
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/health', timeout=4)"
CMD ["python", "/app/server.py"]
