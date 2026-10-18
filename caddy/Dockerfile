FROM caddy:2-builder@sha256:d842facfd63b960922e57444ff76fd8f0793a66dfdcf481af8026e1f4e6a39b4 AS builder
RUN xcaddy build \
    --output /usr/bin/caddy \
    --with github.com/caddy-dns/cloudflare@v0.2.4 \
    --with github.com/caddy-dns/duckdns@v0.5.0

FROM caddy:2@sha256:685ae3d7c34d9b5f8caeddc5d14051db7bbd88ff1f5a2fa0c16bd8ca328fb7af
COPY --from=builder /usr/bin/caddy /usr/bin/caddy
