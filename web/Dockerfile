# Build-Stage
# Build-Context = Repo-Root (siehe docker-compose.yml), damit die zentrale
# VERSION-Datei in den Build gelangt.
FROM node:24-alpine@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53 AS build
# Optionaler Node-Heap-Deckel fuer den vite/rollup-Build. Leer = kein Limit
# (Default fuer das Master-/Produktivsystem und Instanzen mit genug RAM).
# Der Installer setzt dies im Safe-Mode auf z.B. --max-old-space-size=768,
# wenn auf dem Zielgeraet weniger als 2 GB RAM erkannt wurden.
ARG WEB_BUILD_NODE_OPTIONS=""
WORKDIR /app
COPY web/package*.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
# PDF.js braucht zur Laufzeit seine WebAssembly-Dekoder (Schwarz-Weiß-Scans,
# JPEG 2000) und Standardschriften als eigene Dateien; ohne sie bleiben solche
# Seiten im Viewer leer. Aus derselben pdfjs-dist-Version wie der Worker.
RUN mkdir -p public/pdfjs \
 && cp -r node_modules/pdfjs-dist/wasm node_modules/pdfjs-dist/standard_fonts public/pdfjs/
# OpenCV (WebAssembly eingebettet) für den Kamerascan: als statische Datei
# mit Versionsnummer im Namen, damit nginx sie dauerhaft cachebar ausliefern
# kann; die .gz daneben verschickt nginx per gzip_static. Der Name muss zu
# __OPENCV_VERSION__ aus vite.config.js passen (beide lesen package.json).
RUN V=$(node -p "require('./node_modules/@techstark/opencv-js/package.json').version") \
 && mkdir -p public/opencv \
 && cp node_modules/@techstark/opencv-js/dist/opencv.js "public/opencv/opencv-$V.js" \
 && gzip -9k "public/opencv/opencv-$V.js"
# Lizenztexte aller ausgelieferten npm-Pakete; das Runtime-Image enthält
# kein node_modules mehr.
RUN node scripts/drittanbieter-lizenzen.mjs public/lizenzen/npm-pakete.txt
RUN node --test test/*.test.js
# Anwenderdokumentation als statisches Asset: vite kopiert public/ unveraendert
# nach dist/, die In-App-Hilfe laedt die Kapitel von dort. Einzige Quelle bleibt
# docs/ im Repo – es gibt bewusst keine zweite, gepflegte Kopie im Frontend.
COPY docs/ ./public/docs/
COPY VERSION /VERSION
RUN NODE_OPTIONS="$WEB_BUILD_NODE_OPTIONS" npm run build

# Runtime-Stage
FROM nginx:alpine@sha256:72aeb3308ef6cb3118242fb16389518923916dfa206e32d1a8377acc328b9870
COPY --from=build /app/dist /usr/share/nginx/html
COPY web/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
