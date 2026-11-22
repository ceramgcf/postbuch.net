FROM caddy:2-builder@sha256:aef223d1f943bc12a29a9e0a0a73983aa19a36672daede7507da4201a6b1016a AS builder
RUN xcaddy build \
    --output /usr/bin/caddy \
    --with github.com/caddy-dns/cloudflare@v0.2.4 \
    --with github.com/caddy-dns/duckdns@v0.5.0

FROM caddy:2@sha256:4851e54a46b206517c574821bb5cc67f170d2156041e9fbc4c9193b45e84a75b
COPY --from=builder /usr/bin/caddy /usr/bin/caddy
