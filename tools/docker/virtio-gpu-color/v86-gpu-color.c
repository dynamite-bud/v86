#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <limits.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <unistd.h>

#include <xf86drm.h>
#include <xf86drmMode.h>
#include <drm_fourcc.h>

#define FRAME_WIDTH 1024U
#define FRAME_HEIGHT 768U
#define BYTES_PER_PIXEL 4U
#define ASSET_ROOT "/usr/local/share/v86-gpu-color"
#define DECODED_MEMORY_CEILING (4U * 1024U * 1024U)

#define ARRAY_LENGTH(array) (sizeof(array) / sizeof((array)[0]))

enum scale_mode
{
    SCALE_NEAREST,
    SCALE_SMPTE_BANDS,
};

struct scene_definition
{
    const char *name;
    const char *file;
    uint32_t source_width;
    uint32_t source_height;
    enum scale_mode scale;
    const char *source_pixel_sha256;
    const char *frame_rgba_sha256;
};

#include "scenes.generated.h"

struct source_image
{
    uint32_t width;
    uint32_t height;
    uint8_t *pixels;
    size_t length;
};

struct drm_scanout
{
    int fd;
    uint32_t connector_id;
    uint32_t crtc_id;
    drmModeModeInfo mode;
    uint32_t handle;
    uint32_t pitch;
    uint64_t size;
    uint32_t framebuffer_id;
    uint8_t *map;
};

static void fail(const char *message)
{
    fprintf(stderr, "V86_GPU_COLOR_ERROR=%s: %s\n", message, strerror(errno));
    exit(EXIT_FAILURE);
}

static void fail_value(const char *message)
{
    fprintf(stderr, "V86_GPU_COLOR_ERROR=%s\n", message);
    exit(EXIT_FAILURE);
}

static size_t checked_size(uint32_t width, uint32_t height, uint32_t bytes_per_pixel)
{
    if(width == 0 || height == 0 || width > SIZE_MAX / height ||
       (size_t)width * height > SIZE_MAX / bytes_per_pixel)
    {
        fail_value("image dimensions overflow");
    }
    return (size_t)width * height * bytes_per_pixel;
}

static void close_source(struct source_image *source)
{
    free(source->pixels);
    memset(source, 0, sizeof(*source));
}

static struct source_image load_source(const struct scene_definition *scene)
{
    char filename[PATH_MAX];
    if(snprintf(filename, sizeof(filename), "%s/%s", ASSET_ROOT, scene->file) >= (int)sizeof(filename))
    {
        fail_value("fixture path is too long");
    }

    FILE *file = fopen(filename, "rb");
    if(file == NULL) fail("opening fixture");

    char magic[16];
    char dimensions[64];
    char maximum[16];
    if(fgets(magic, sizeof(magic), file) == NULL || strcmp(magic, "P6\n") != 0 ||
       fgets(dimensions, sizeof(dimensions), file) == NULL ||
       fgets(maximum, sizeof(maximum), file) == NULL || strcmp(maximum, "255\n") != 0)
    {
        fclose(file);
        fail_value("fixture has an invalid PPM header");
    }

    unsigned int width;
    unsigned int height;
    char trailing;
    if(sscanf(dimensions, "%u %u%c", &width, &height, &trailing) != 3 || trailing != '\n' ||
       width != scene->source_width || height != scene->source_height)
    {
        fclose(file);
        fail_value("fixture dimensions do not match the scene table");
    }

    const size_t length = checked_size(width, height, 3);
    const size_t frame_length = checked_size(FRAME_WIDTH, FRAME_HEIGHT, BYTES_PER_PIXEL);
    if(length > DECODED_MEMORY_CEILING - frame_length)
    {
        fclose(file);
        fail_value("fixture exceeds the decoded-memory ceiling");
    }

    uint8_t *pixels = malloc(length);
    if(pixels == NULL)
    {
        fclose(file);
        fail("allocating fixture");
    }
    if(fread(pixels, 1, length, file) != length || fgetc(file) != EOF)
    {
        free(pixels);
        fclose(file);
        fail_value("fixture pixel payload has the wrong length");
    }
    if(fclose(file) != 0)
    {
        free(pixels);
        fail("closing fixture");
    }
    return (struct source_image){ width, height, pixels, length };
}

static drmModeConnector *find_connector(int fd, drmModeRes *resources)
{
    for(int index = 0; index < resources->count_connectors; index++)
    {
        drmModeConnector *connector = drmModeGetConnector(fd, resources->connectors[index]);
        if(connector != NULL && connector->connection == DRM_MODE_CONNECTED && connector->count_modes > 0)
        {
            return connector;
        }
        drmModeFreeConnector(connector);
    }
    return NULL;
}

static drmModeModeInfo find_mode(const drmModeConnector *connector)
{
    for(int index = 0; index < connector->count_modes; index++)
    {
        if(connector->modes[index].hdisplay == FRAME_WIDTH && connector->modes[index].vdisplay == FRAME_HEIGHT)
        {
            return connector->modes[index];
        }
    }
    fail_value("connected DRM output does not expose 1024x768");
    return (drmModeModeInfo){0};
}

static uint32_t find_crtc(int fd, const drmModeRes *resources, const drmModeConnector *connector)
{
    if(connector->encoder_id != 0)
    {
        drmModeEncoder *encoder = drmModeGetEncoder(fd, connector->encoder_id);
        if(encoder != NULL && encoder->crtc_id != 0)
        {
            const uint32_t crtc_id = encoder->crtc_id;
            drmModeFreeEncoder(encoder);
            return crtc_id;
        }
        drmModeFreeEncoder(encoder);
    }

    for(int encoder_index = 0; encoder_index < connector->count_encoders; encoder_index++)
    {
        drmModeEncoder *encoder = drmModeGetEncoder(fd, connector->encoders[encoder_index]);
        if(encoder == NULL) continue;
        for(int crtc_index = 0; crtc_index < resources->count_crtcs; crtc_index++)
        {
            if(encoder->possible_crtcs & (1U << crtc_index))
            {
                const uint32_t crtc_id = resources->crtcs[crtc_index];
                drmModeFreeEncoder(encoder);
                return crtc_id;
            }
        }
        drmModeFreeEncoder(encoder);
    }
    fail_value("connected DRM output has no compatible CRTC");
    return 0;
}

static struct drm_scanout create_scanout(void)
{
    struct drm_scanout scanout = { .fd = -1 };
    scanout.fd = open("/dev/dri/card0", O_RDWR | O_CLOEXEC);
    if(scanout.fd < 0) fail("opening /dev/dri/card0");
    if(drmSetClientCap(scanout.fd, DRM_CLIENT_CAP_UNIVERSAL_PLANES, 1) != 0)
    {
        fail("enabling universal planes");
    }

    drmModeRes *resources = drmModeGetResources(scanout.fd);
    if(resources == NULL) fail("reading DRM resources");
    drmModeConnector *connector = find_connector(scanout.fd, resources);
    if(connector == NULL)
    {
        drmModeFreeResources(resources);
        fail_value("no connected DRM output");
    }
    scanout.connector_id = connector->connector_id;
    scanout.crtc_id = find_crtc(scanout.fd, resources, connector);
    scanout.mode = find_mode(connector);
    drmModeFreeConnector(connector);
    drmModeFreeResources(resources);

    struct drm_mode_create_dumb create = {
        .width = FRAME_WIDTH,
        .height = FRAME_HEIGHT,
        .bpp = 32,
    };
    if(ioctl(scanout.fd, DRM_IOCTL_MODE_CREATE_DUMB, &create) < 0) fail("creating dumb buffer");
    scanout.handle = create.handle;
    scanout.pitch = create.pitch;
    scanout.size = create.size;

    const size_t minimum_stride = checked_size(FRAME_WIDTH, 1, BYTES_PER_PIXEL);
    const size_t minimum_size = checked_size(FRAME_WIDTH, FRAME_HEIGHT, BYTES_PER_PIXEL);
    if(scanout.pitch < minimum_stride || scanout.size < minimum_size ||
       scanout.pitch > SIZE_MAX / FRAME_HEIGHT || scanout.size < (uint64_t)scanout.pitch * FRAME_HEIGHT)
    {
        fail_value("DRM dumb-buffer pitch or size is invalid");
    }

    struct drm_mode_map_dumb map = { .handle = scanout.handle };
    if(ioctl(scanout.fd, DRM_IOCTL_MODE_MAP_DUMB, &map) < 0) fail("mapping dumb buffer");
    scanout.map = mmap(NULL, scanout.size, PROT_READ | PROT_WRITE, MAP_SHARED, scanout.fd, map.offset);
    if(scanout.map == MAP_FAILED) fail("mapping framebuffer memory");
    memset(scanout.map, 0, scanout.size);
    return scanout;
}

static void destroy_scanout(struct drm_scanout *scanout)
{
    if(scanout->map != NULL && scanout->map != MAP_FAILED) munmap(scanout->map, scanout->size);
    if(scanout->framebuffer_id != 0) drmModeRmFB(scanout->fd, scanout->framebuffer_id);
    if(scanout->handle != 0)
    {
        struct drm_mode_destroy_dumb destroy = { .handle = scanout->handle };
        ioctl(scanout->fd, DRM_IOCTL_MODE_DESTROY_DUMB, &destroy);
    }
    if(scanout->fd >= 0) close(scanout->fd);
}

static uint32_t source_y_for(const struct scene_definition *scene, uint32_t y)
{
    if(scene->scale == SCALE_SMPTE_BANDS)
    {
        if(y < FRAME_HEIGHT * 6 / 9) return 0;
        if(y < FRAME_HEIGHT * 7 / 9) return 1;
        return 2;
    }
    return (uint32_t)((uint64_t)y * scene->source_height / FRAME_HEIGHT);
}

static void present_scene(struct drm_scanout *scanout, const struct scene_definition *scene)
{
    struct source_image source = load_source(scene);
    for(uint32_t y = 0; y < FRAME_HEIGHT; y++)
    {
        const uint32_t source_y = source_y_for(scene, y);
        uint32_t *target = (uint32_t *)(scanout->map + (size_t)y * scanout->pitch);
        for(uint32_t x = 0; x < FRAME_WIDTH; x++)
        {
            const uint32_t source_x = (uint32_t)((uint64_t)x * source.width / FRAME_WIDTH);
            const size_t offset = ((size_t)source_y * source.width + source_x) * 3;
            target[x] = (uint32_t)source.pixels[offset + 2] |
                (uint32_t)source.pixels[offset + 1] << 8 |
                (uint32_t)source.pixels[offset] << 16;
        }
    }
    close_source(&source);

    if(scanout->framebuffer_id != 0)
    {
        if(drmModeRmFB(scanout->fd, scanout->framebuffer_id) != 0)
        {
            fail("releasing previous DRM framebuffer");
        }
        scanout->framebuffer_id = 0;
    }
    if(drmModeAddFB2(scanout->fd, FRAME_WIDTH, FRAME_HEIGHT, DRM_FORMAT_XRGB8888,
        (uint32_t[4]){ scanout->handle }, (uint32_t[4]){ scanout->pitch }, (uint32_t[4]){ 0 },
        &scanout->framebuffer_id, 0) != 0)
    {
        fail("creating DRM framebuffer");
    }
    if(drmModeSetCrtc(scanout->fd, scanout->crtc_id, scanout->framebuffer_id, 0, 0,
        &scanout->connector_id, 1, &scanout->mode) != 0)
    {
        fail("setting DRM scanout");
    }
    printf("V86_GPU_COLOR_SCENE=%s DIGEST=%s SOURCE_DIGEST=%s "
        "WIDTH=%u HEIGHT=%u STRIDE=%u FORMAT=B8G8R8X8\n",
        scene->name, scene->frame_rgba_sha256, scene->source_pixel_sha256,
        FRAME_WIDTH, FRAME_HEIGHT, scanout->pitch);
    fflush(stdout);
}

int main(void)
{
    struct drm_scanout scanout = create_scanout();
    printf("V86_GPU_COLOR_READY WIDTH=%u HEIGHT=%u SCENES=%zu MAX_DECODED_BYTES=%u\n",
        FRAME_WIDTH, FRAME_HEIGHT, ARRAY_LENGTH(SCENES), DECODED_MEMORY_CEILING);
    fflush(stdout);

    size_t scene_index = 0;
    present_scene(&scanout, &SCENES[scene_index]);
    char command[128];
    while(fgets(command, sizeof(command), stdin) != NULL)
    {
        command[strcspn(command, "\r\n")] = '\0';
        if(strcmp(command, "next") == 0)
        {
            if(scene_index + 1 >= ARRAY_LENGTH(SCENES))
            {
                printf("V86_GPU_COLOR_ERROR=no more scenes\n");
                fflush(stdout);
                continue;
            }
            present_scene(&scanout, &SCENES[++scene_index]);
        }
        else if(strcmp(command, "quit") == 0)
        {
            printf("V86_GPU_COLOR_DONE\n");
            fflush(stdout);
            break;
        }
        else
        {
            printf("V86_GPU_COLOR_ERROR=unknown command '%s'\n", command);
            fflush(stdout);
        }
    }
    destroy_scanout(&scanout);
    return 0;
}
