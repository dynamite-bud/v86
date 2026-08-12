FROM docker.io/library/alpine@sha256:6f5908cdf811d574b30ec394e405ef74ee293bed5af1620a5187d604604a90a8 AS color-builder

RUN apk add --no-cache build-base=0.5-r4 libdrm-dev=2.4.134-r0
COPY --from=color v86-gpu-color.c scenes.generated.h /tmp/
RUN cc -std=c11 -D_GNU_SOURCE -O2 -Wall -Wextra -Werror \
    $(pkg-config --cflags libdrm) /tmp/v86-gpu-color.c -o /tmp/v86-gpu-color \
    $(pkg-config --libs libdrm)

FROM docker.io/library/alpine@sha256:6f5908cdf811d574b30ec394e405ef74ee293bed5af1620a5187d604604a90a8

ENV KERNEL=lts

COPY world.lock packages.lock /tmp/
RUN xargs apk add --no-cache < /tmp/world.lock && \
    apk info -v | sort | cmp - /tmp/packages.lock

COPY --from=color-builder /tmp/v86-gpu-color /usr/local/bin/v86-gpu-color
COPY --from=color fixtures /usr/local/share/v86-gpu-color
COPY desktop-session /usr/local/sbin/v86-desktop-session
COPY profile /root/.profile
COPY xinitrc /root/.xinitrc
COPY 20-virtio-gpu.conf /etc/X11/xorg.conf.d/20-virtio-gpu.conf
COPY xfce4-power-manager.xml /root/.config/xfce4/xfconf/xfce-perchannel-xml/xfce4-power-manager.xml

RUN chmod +x /usr/local/bin/v86-gpu-color /usr/local/sbin/v86-desktop-session /root/.xinitrc && \
    sed -i 's/getty 38400 tty1/agetty --autologin root tty1 linux/' /etc/inittab && \
    echo 'ttyS0::respawn:/sbin/agetty --autologin root -s ttyS0 115200 vt100' >> /etc/inittab && \
    echo 'virtio_gpu' > /etc/modules-load.d/virtio-gpu.conf && \
    printf '%s\n' 'allowed_users=anybody' 'needs_root_rights=yes' > /etc/X11/Xwrapper.config && \
    echo 'root:' | chpasswd && \
    setup-hostname localhost && \
    for service in devfs dmesg udev udev-trigger hwdrivers; do rc-update add "$service" sysinit; done && \
    for service in hwclock modules sysctl hostname syslog bootmisc; do rc-update add "$service" boot; done && \
    rc-update add udev-postmount default && \
    rc-update add dbus default && \
    rc-update add seatd default && \
    rc-update add killprocs shutdown && \
    mkinitfs -F 'base virtio 9p' $(cat /usr/share/kernel/$KERNEL/kernel.release)
