FROM docker.io/library/alpine@sha256:6f5908cdf811d574b30ec394e405ef74ee293bed5af1620a5187d604604a90a8

ENV KERNEL=lts

COPY world.lock packages.lock artifacts.lock /tmp/
RUN mkdir -p /boot && xargs apk add --no-cache < /tmp/world.lock && \
    apk info -v | sort | cmp - /tmp/packages.lock

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
