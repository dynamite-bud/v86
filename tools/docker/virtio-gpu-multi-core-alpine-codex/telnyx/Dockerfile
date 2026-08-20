ARG BASE_IMAGE
FROM ${BASE_IMAGE}

COPY telnyx/artifacts.lock /tmp/artifacts.lock
COPY --from=codex_dist /codex-rust-v0.148.0-i386-alpine-3.24.tar.gz /tmp/codex.tar.gz
RUN set -eux; \
    . /tmp/artifacts.lock; \
    test "$CODEX_URL" = "file:///tmp/codex.tar.gz"; \
    printf '%s  %s\n' "$CODEX_SHA256" /tmp/codex.tar.gz | sha256sum -c -; \
    tar -xzf /tmp/codex.tar.gz -C /tmp; \
    grep -Fxq 'upstream_tag=rust-v0.148.0' /tmp/codex-linux-i386-musl/I386-BUILD.txt; \
    install -D -m 0755 /tmp/codex-linux-i386-musl/codex /usr/local/libexec/codex; \
    install -D -m 0644 /tmp/codex-linux-i386-musl/I386-BUILD.txt /usr/share/doc/codex/I386-BUILD.txt; \
    install -D -m 0644 /tmp/artifacts.lock /usr/share/v86-appliance/artifacts.lock; \
    test "$(/usr/local/libexec/codex --version)" = "codex-cli 0.148.0"; \
    rm -rf /tmp/codex.tar.gz /tmp/codex-linux-i386-musl /root/.codex

COPY --chown=1000:1000 telnyx/config.toml /home/codex/.codex/config.toml
COPY --chown=1000:1000 telnyx/model-catalogs/ /home/codex/.codex/model-catalogs/
RUN sed -i 's/^font-size = 16$/font-size = 20/' /home/codex/.config/ghostty/config.ghostty && \
    grep -Fxq 'font-size = 20' /home/codex/.config/ghostty/config.ghostty
RUN chown 1000:1000 /home/codex/.codex /home/codex/.codex/config.toml /home/codex/.codex/model-catalogs /home/codex/.codex/model-catalogs/* && \
    chmod 0755 /home/codex/.codex /home/codex/.codex/model-catalogs && \
    chmod 0600 /home/codex/.codex/config.toml && \
    chmod 0644 /home/codex/.codex/model-catalogs/*
