#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/ioctl.h>
#include <unistd.h>

#include <drm.h>
#include <virtgpu_drm.h>

#define V86_WEBGPU_CAPSET_ID 7U
#define V86_WEBGPU_CAPSET_VERSION 1U
#define V86_WEBGPU_CAPSET_SIZE 912U
#define V86_WEBGPU_CAPSET_MAGIC 0x57363856U

static int open_virtio_gpu(void)
{
    const char *paths[] = { "/dev/dri/renderD128", "/dev/dri/card0" };

    for(size_t index = 0; index < sizeof(paths) / sizeof(paths[0]); index++)
    {
        int fd = open(paths[index], O_RDWR | O_CLOEXEC);
        if(fd >= 0)
        {
            return fd;
        }
    }

    return -1;
}

int main(void)
{
    uint8_t capset[V86_WEBGPU_CAPSET_SIZE] = { 0 };
    struct drm_virtgpu_get_caps get_caps = {
        .cap_set_id = V86_WEBGPU_CAPSET_ID,
        .cap_set_ver = V86_WEBGPU_CAPSET_VERSION,
        .addr = (uintptr_t)capset,
        .size = sizeof(capset),
    };
    struct drm_virtgpu_context_set_param context_param = {
        .param = VIRTGPU_CONTEXT_PARAM_CAPSET_ID,
        .value = V86_WEBGPU_CAPSET_ID,
    };
    struct drm_virtgpu_context_init context_init = {
        .num_params = 1,
        .ctx_set_params = (uintptr_t)&context_param,
    };
    uint32_t magic;
    uint32_t capset_size;
    uint32_t feature_bits;
    uint16_t submit_abi_major;
    int fd = open_virtio_gpu();

    printf("V86_GPU_CAPSET7_PROBE_BEGIN\n");
    if(fd < 0)
    {
        printf("V86_GPU_CAPSET7_OPEN=FAIL errno=%d (%s)\n",
            errno, strerror(errno));
        return 1;
    }

    if(ioctl(fd, DRM_IOCTL_VIRTGPU_GET_CAPS, &get_caps) < 0)
    {
        printf("V86_GPU_CAPSET7_GET_CAPS=FAIL errno=%d (%s)\n",
            errno, strerror(errno));
        close(fd);
        return 1;
    }

    memcpy(&magic, capset, sizeof(magic));
    memcpy(&submit_abi_major, capset + 4, sizeof(submit_abi_major));
    memcpy(&capset_size, capset + 8, sizeof(capset_size));
    memcpy(&feature_bits, capset + 12, sizeof(feature_bits));
    if(magic != V86_WEBGPU_CAPSET_MAGIC ||
        submit_abi_major != V86_WEBGPU_CAPSET_VERSION ||
        capset_size != V86_WEBGPU_CAPSET_SIZE ||
        feature_bits != 0)
    {
        printf("V86_GPU_CAPSET7_GET_CAPS=FAIL magic=0x%08x"
            " abi=%u size=%u features=0x%08x\n",
            magic, submit_abi_major, capset_size, feature_bits);
        close(fd);
        return 1;
    }
    printf("V86_GPU_CAPSET7_GET_CAPS=PASS magic=0x%08x size=%u\n",
        magic, capset_size);

    if(ioctl(fd, DRM_IOCTL_VIRTGPU_CONTEXT_INIT, &context_init) < 0)
    {
        printf("V86_GPU_CAPSET7_CONTEXT_INIT=FAIL errno=%d (%s)\n",
            errno, strerror(errno));
        close(fd);
        return 1;
    }

    printf("V86_GPU_CAPSET7_CONTEXT_INIT=PASS capset=%u\n",
        V86_WEBGPU_CAPSET_ID);
    printf("V86_GPU_CAPSET7_PROBE_END\n");
    close(fd);
    return 0;
}
