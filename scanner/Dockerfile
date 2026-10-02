FROM python:3.11-slim@sha256:db3ff2e1800a8581e2c48a27c3995339d47bdf046da21c7627accd3d51053a93

ENV PYTHONUNBUFFERED=1

COPY requirements.txt /tmp/requirements.txt

RUN apt-get update && apt-get install -y \
    sane-utils \
    sane-airscan \
    img2pdf \
    && pip install --no-cache-dir -r /tmp/requirements.txt \
    && rm -f /tmp/requirements.txt \
    && rm -rf /var/lib/apt/lists/*

# Leere Platzhalter — werden zur Laufzeit von scan_service.py überschrieben
RUN printf '[devices]\n' > /etc/sane.d/airscan.conf && \
    printf '' > /etc/sane.d/escl.conf

WORKDIR /app
COPY scan_service.py .

CMD ["python3", "scan_service.py"]
