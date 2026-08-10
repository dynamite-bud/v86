FROM docker.io/i386/alpine@sha256:fcc4c908760c4f561a5199f2e53576063b1b8eeaa0c41e6432d705aab4389753

ENV KERNEL=lts

COPY world.lock packages.lock /tmp/
RUN apk add --no-cache $(cat /tmp/world.lock) && \
    apk info -v | sort | cmp - /tmp/packages.lock

COPY virtio-gpu-probe /usr/local/sbin/virtio-gpu-probe
COPY virtio-gpu-probe.initd /etc/init.d/virtio-gpu-probe
COPY 20-virtio-gpu.conf /etc/X11/xorg.conf.d/20-virtio-gpu.conf
COPY xinitrc /root/.xinitrc

RUN chmod +x /usr/local/sbin/virtio-gpu-probe /etc/init.d/virtio-gpu-probe /root/.xinitrc && \
    sed -i 's/getty 38400 tty1/agetty --autologin root tty1 linux/' /etc/inittab && \
    echo 'ttyS0::respawn:/sbin/agetty --autologin root -s ttyS0 115200 vt100' >> /etc/inittab && \
    echo 'virtio_gpu' > /etc/modules-load.d/virtio-gpu.conf && \
    echo 'root:' | chpasswd && \
    setup-hostname localhost && \
    for service in devfs dmesg mdev hwdrivers; do rc-update add "$service" sysinit; done && \
    for service in hwclock modules sysctl hostname syslog bootmisc; do rc-update add "$service" boot; done && \
    rc-update add dbus default && \
    rc-update add virtio-gpu-probe default && \
    rc-update add killprocs shutdown && \
    mkinitfs -F 'base virtio 9p' $(cat /usr/share/kernel/$KERNEL/kernel.release)
