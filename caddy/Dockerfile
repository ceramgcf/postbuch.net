FROM caddy:2-builder@sha256:198d47eaee306d4d0c38a9960c89ff2c959aa29ad51d3e2dafa3e93ac961782a AS builder
RUN xcaddy build \
    --output /usr/bin/caddy \
    --with github.com/caddy-dns/cloudflare@v0.2.4 \
    --with github.com/caddy-dns/duckdns@v0.5.0

FROM caddy:2@sha256:844f60b64e4724a5aa8245e019dace0d3f199f7433ce6c57676cb30a920dbad9
COPY --from=builder /usr/bin/caddy /usr/bin/caddy
