FROM docker.io/library/alpine@sha256:6f5908cdf811d574b30ec394e405ef74ee293bed5af1620a5187d604604a90a8 AS capset-probe-builder

COPY probe-world.lock probe-packages.lock /tmp/
RUN xargs apk add --no-cache < /tmp/probe-world.lock && \
    apk info -v | sort | cmp - /tmp/probe-packages.lock
COPY ghostty-terminal-benchmark.c virtio-gpu-capset-probe.c \
    virtio-gpu-triangle.c virtio-gpu-triangle-spv.h /tmp/
RUN cc -D_GNU_SOURCE -std=c11 -Wall -Wextra -Werror -I/usr/include/libdrm \
    /tmp/virtio-gpu-capset-probe.c -o /virtio-gpu-capset-probe && \
    cc -D_GNU_SOURCE -std=c11 -Wall -Wextra -Werror -I/usr/include/libdrm \
    /tmp/virtio-gpu-triangle.c -ldrm -lEGL -lGLESv2 -lgbm -o /virtio-gpu-triangle && \
    cc -std=c11 -Wall -Wextra -Werror \
    /tmp/ghostty-terminal-benchmark.c -o /ghostty-terminal-benchmark

FROM docker.io/library/alpine@sha256:6f5908cdf811d574b30ec394e405ef74ee293bed5af1620a5187d604604a90a8 AS mesa-builder

ARG MESA_COMMIT=ffa422e53d59a4938b38abd5c3fc319555da31dd
RUN apk add --no-cache \
    bison \
    build-base \
    flex \
    elfutils-dev \
    expat-dev \
    git \
    libdrm-dev \
    libxrandr-dev \
    mesa-dev \
    meson \
    py3-mako \
    py3-packaging \
    py3-yaml \
    zlib-dev \
    zstd-dev
COPY mesa-webgpuvirt.patch /tmp/mesa-webgpuvirt.patch
RUN git clone --depth 1 --branch mesa-26.1.6 \
        https://gitlab.freedesktop.org/mesa/mesa.git /src/mesa && \
    test "$(git -C /src/mesa rev-parse HEAD)" = "$MESA_COMMIT" && \
    git -C /src/mesa apply --check /tmp/mesa-webgpuvirt.patch && \
    git -C /src/mesa apply /tmp/mesa-webgpuvirt.patch && \
    meson setup /src/mesa/build-webgpuvirt /src/mesa \
        -Dplatforms=x11 \
        -Dgallium-drivers=virgl \
        -Dvulkan-drivers=[] \
        -Dglx=dri \
        -Degl=enabled \
        -Dgles1=disabled \
        -Dgles2=enabled \
        -Dllvm=disabled \
        -Dshared-glapi=enabled \
        -Dbuild-tests=false \
        -Dvideo-codecs=[] && \
    meson compile -C /src/mesa/build-webgpuvirt && \
    DESTDIR=/opt/webgpuvirt meson install -C /src/mesa/build-webgpuvirt

COPY mesa-artifacts.lock /tmp/
RUN set -eux; \
    expected_commit=$MESA_COMMIT; \
    . /tmp/mesa-artifacts.lock; \
    test "$expected_commit" = "$MESA_COMMIT"; \
    test "$(git -C /src/mesa rev-parse HEAD)" = "$MESA_COMMIT"; \
    printf '%s  %s\n' "$MESA_GALLIUM_SHA256" \
        /opt/webgpuvirt/usr/local/lib/libgallium-26.1.6.so | sha256sum -c -; \
    printf '%s  %s\n' "$MESA_DRI_SHA256" \
        /opt/webgpuvirt/usr/local/lib/dri/virtio_gpu_dri.so | sha256sum -c -

FROM scratch AS mesa-artifacts
COPY --from=mesa-builder /opt/webgpuvirt/usr/local/lib/libgallium-26.1.6.so /lib/
COPY --from=mesa-builder /opt/webgpuvirt/usr/local/lib/dri /lib/dri

FROM docker.io/library/alpine@sha256:6f5908cdf811d574b30ec394e405ef74ee293bed5af1620a5187d604604a90a8

ENV KERNEL=lts

COPY world.lock packages.lock artifacts.lock /tmp/
RUN mkdir -p /boot && xargs apk add --no-cache < /tmp/world.lock && \
    apk info -v | sort | cmp - /tmp/packages.lock

COPY --from=capset-probe-builder /virtio-gpu-capset-probe /usr/local/bin/virtio-gpu-capset-probe
COPY --from=capset-probe-builder /virtio-gpu-triangle /usr/local/bin/virtio-gpu-triangle
COPY --from=capset-probe-builder /ghostty-terminal-benchmark /usr/local/bin/v86-ghostty-benchmark
COPY --from=mesa-builder /opt/webgpuvirt/usr/local/lib/libgallium-26.1.6.so /usr/local/lib/
COPY --from=mesa-builder /opt/webgpuvirt/usr/local/lib/dri /usr/local/lib/dri

RUN set -eux; \
    . /tmp/artifacts.lock; \
    wget -q -O /tmp/ghostty.tar.gz "$GHOSTTY_URL"; \
    printf '%s  %s\n' "$GHOSTTY_SHA256" /tmp/ghostty.tar.gz | sha256sum -c -; \
    tar -xzf /tmp/ghostty.tar.gz -C /usr ./bin ./lib ./share; \
    wget -q -O /tmp/codex.tar.gz "$CODEX_URL"; \
    printf '%s  %s\n' "$CODEX_SHA256" /tmp/codex.tar.gz | sha256sum -c -; \
    tar -xzf /tmp/codex.tar.gz -C /tmp; \
    install -m 0755 /tmp/codex-linux-i386-musl/codex /usr/local/bin/codex; \
    install -D -m 0644 /tmp/codex-linux-i386-musl/I386-BUILD.txt /usr/share/doc/codex/I386-BUILD.txt; \
    install -D -m 0644 /tmp/artifacts.lock /usr/share/v86-appliance/artifacts.lock; \
    install -D -m 0644 /tmp/packages.lock /usr/share/v86-appliance/packages.lock; \
    ghostty --version; \
    codex --version; \
    rm -rf /root/.codex /tmp/ghostty.tar.gz /tmp/codex.tar.gz /tmp/codex-linux-i386-musl

RUN adduser -D -u 1000 -s /bin/sh codex && \
    addgroup codex video && \
    addgroup codex input && \
    addgroup codex seat && \
    install -d -m 0700 -o codex -g codex /home/codex/.config/ghostty && \
    install -d -m 0755 -o codex -g codex /home/codex/workspace

COPY appliance-session /usr/local/sbin/v86-appliance-session
COPY codex-session /usr/local/bin/v86-codex-session
COPY v86-networking /etc/init.d/v86-networking
COPY profile /home/codex/.profile
COPY xinitrc /home/codex/.xinitrc
COPY ghostty-config /home/codex/.config/ghostty/config.ghostty
COPY 20-virtio-gpu.conf /etc/X11/xorg.conf.d/20-virtio-gpu.conf

RUN chmod 0755 /usr/local/sbin/v86-appliance-session \
        /usr/local/bin/v86-codex-session /etc/init.d/v86-networking /home/codex/.xinitrc && \
    chown -R codex:codex /home/codex && \
    sed -i -e 's/getty 38400 tty1/agetty --autologin codex tty1 linux/' \
        -e 's/^tty1::respawn:/tty1::once:/' /etc/inittab && \
    echo 'ttyS0::respawn:/sbin/agetty --autologin codex -s ttyS0 115200 vt100' >> /etc/inittab && \
    printf '%s\n' virtio_gpu virtio_net > /etc/modules-load.d/v86-appliance.conf && \
    printf '%s\n' 'allowed_users=anybody' 'needs_root_rights=yes' > /etc/X11/Xwrapper.config && \
    passwd -l root && \
    setup-hostname localhost && \
    for service in devfs dmesg udev udev-trigger hwdrivers; do rc-update add "$service" sysinit; done && \
    for service in hwclock modules sysctl hostname syslog bootmisc; do rc-update add "$service" boot; done && \
    rc-update add udev-postmount default && \
    rc-update add v86-networking default && \
    rc-update add dbus default && \
    rc-update add seatd default && \
    rc-update add killprocs shutdown && \
    mkinitfs -F 'base virtio 9p' $(cat /usr/share/kernel/$KERNEL/kernel.release)
