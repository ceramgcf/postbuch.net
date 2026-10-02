FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32

# qpdf: PDF-Rotation und -Merge (spätere Sessions)
# postgresql16-client: pg_dump für Backups (spätere Sessions)
# tzdata: Alpine hat die Zoneinfo-Dateien nicht an Bord. Ohne sie kennt die libc
# "Europe/Berlin" nicht und faellt trotz gesetztem TZ lautlos auf UTC zurueck
# (betrifft u.a. Datumsangaben in ausgefuehrten Kindprozessen wie pg_dump/psql).
# Alpine-Paketquellen koennen auf ARM-Heimservern kurz per DNS nicht erreichbar
# sein. Drei Versuche vermeiden dann einen unnötigen manuellen Eingriff.
RUN for versuch in 1 2 3; do \
      apk add --no-cache qpdf postgresql16-client ghostscript tzdata && exit 0; \
      if [ "$versuch" -lt 3 ]; then \
        echo "apk fehlgeschlagen – neuer Versuch in $((versuch * 5)) Sekunden" >&2; \
        sleep "$((versuch * 5))"; \
      fi; \
    done; \
    exit 1
RUN ln -sf /usr/share/zoneinfo/Europe/Berlin /etc/localtime && \
    echo "Europe/Berlin" > /etc/timezone

WORKDIR /app
COPY app/package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY app/base_schema.sql ./base_schema.sql
# Eingefrorene Legacy-Schemaskripte + Bootstrap der Verwaltungstabelle.
# Werden je Datenbank hoechstens einmal ausgefuehrt, bleiben aber dauerhaft
# ausgeliefert (kein Support-Fenster fuer alte Upgrade-Staende).
COPY app/schema/ ./schema/
COPY app/sql/ ./sql/
COPY app/src/ ./src/
# Dieselbe kanonische Anwenderdokumentation, die der Web-Build unter /hilfe
# ausliefert. Das Backend zerlegt sie lokal für den semantischen Hilfekorpus;
# es gibt keine zweite gepflegte Kopie.
COPY docs/ ./docs/
# Die Laufzeitversion wird ins Image gebacken. Ein Host-Bind-Mount konnte nach
# einem gestagten Fremdinstanz-Update fehlen oder unlesbar sein.
COPY VERSION ./VERSION
COPY app/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh
EXPOSE 3421
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "src/index.js"]
