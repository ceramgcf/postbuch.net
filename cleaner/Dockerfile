FROM jbarlow83/ocrmypdf:latest@sha256:ffa440f039b1905f62ce110912f7742e6213b06cf8ea3239721ad3f7453eac58

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
