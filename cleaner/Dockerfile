FROM jbarlow83/ocrmypdf:latest@sha256:73c1628f4a93ec177189cb53df636b44e7788dfef97d9187f334ee30bd916daa

# Das Base-Image läuft inzwischen standardmäßig als non-root User;
# für apt-get brauchen wir root.
USER root

RUN apt-get update \
 && apt-get install -y inotify-tools curl qpdf \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /

COPY process_scan.py /usr/local/bin/process_scan.py
COPY test_scan_server.py /usr/local/bin/test_scan_server.py
COPY run_loop.sh /usr/local/bin/run_loop.sh
RUN chmod +x /usr/local/bin/process_scan.py /usr/local/bin/test_scan_server.py /usr/local/bin/run_loop.sh

ENTRYPOINT ["/usr/local/bin/run_loop.sh"]
