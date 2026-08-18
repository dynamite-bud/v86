ARG BASE_IMAGE=v86-virtio-gpu-alpine-codex:multi-core-base
FROM ${BASE_IMAGE}

COPY multicore-probe /usr/local/sbin/v86-multicore-probe
COPY profile /home/codex/.profile

RUN chmod 0755 /usr/local/sbin/v86-multicore-probe && \
    chown codex:codex /home/codex/.profile && \
    test -x /usr/local/sbin/v86-appliance-session && \
    test -f /usr/share/v86-appliance/mesa-artifacts.lock
