FROM python:3.15-slim@sha256:65a65fc7b30b06cb6df4930fd4650697cb23f4c2698ab81fc87e4b031bc36928

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
