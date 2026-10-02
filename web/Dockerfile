# Build-Stage
# Build-Context = Repo-Root (siehe docker-compose.yml), damit die zentrale
# VERSION-Datei in den Build gelangt.
FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32 AS build
# Optionaler Node-Heap-Deckel fuer den vite/rollup-Build. Leer = kein Limit
# (Default fuer das Master-/Produktivsystem und Instanzen mit genug RAM).
# Der Installer setzt dies im Safe-Mode auf z.B. --max-old-space-size=768,
# wenn auf dem Zielgeraet weniger als 2 GB RAM erkannt wurden.
ARG WEB_BUILD_NODE_OPTIONS=""
WORKDIR /app
COPY web/package*.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
RUN node --test test/*.test.js
# Anwenderdokumentation als statisches Asset: vite kopiert public/ unveraendert
# nach dist/, die In-App-Hilfe laedt die Kapitel von dort. Einzige Quelle bleibt
# docs/ im Repo – es gibt bewusst keine zweite, gepflegte Kopie im Frontend.
COPY docs/ ./public/docs/
COPY VERSION /VERSION
RUN NODE_OPTIONS="$WEB_BUILD_NODE_OPTIONS" npm run build

# Runtime-Stage
FROM nginx:alpine@sha256:4a73073bd557c65b759505da037898b61f1be6cbcc3c2c3aeac22d2a470c1752
COPY --from=build /app/dist /usr/share/nginx/html
COPY web/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
