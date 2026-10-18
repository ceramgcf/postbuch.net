FROM python:3.15-slim@sha256:f48fda6d59b2b3437781d1c3ccf4aa0e26ae871de3cdd758b49ab45ee7291619

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
