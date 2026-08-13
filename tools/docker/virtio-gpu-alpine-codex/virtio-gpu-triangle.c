#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <unistd.h>

#include <drm.h>
#include <xf86drm.h>
#include <xf86drmMode.h>
#include <virtgpu_drm.h>

#define V86_CAPSET_ID 7U
#define V86_CAPSET_VERSION_1 1U
#define V86_CAPSET_VERSION_2 2U
#define V86_CAPSET_SIZE 912U
#define V86_CAPSET_MAGIC 0x57363856U
#define V86_SUBMIT_MAGIC 0x53363856U
#define V86_FORMAT_R8G8B8A8_UNORM 67U
#define V86_FEATURE_BASIC_RENDER 1U
#define V86_SHADER_IR_WGSL 1U
#define V86_TARGET_TEXTURE_2D 2U
#define V86_BIND_RENDER_TARGET 2U
#define V86_TOPOLOGY_TRIANGLE_LIST 3U

#define V86_OP_CREATE_SHADER 1U
#define V86_OP_CREATE_PIPELINE 3U
#define V86_OP_BEGIN_RENDER_PASS 16U
#define V86_OP_SET_PIPELINE 17U
#define V86_OP_SET_VIEWPORT 18U
#define V86_OP_SET_SCISSOR 19U
#define V86_OP_DRAW 20U
#define V86_OP_END_RENDER_PASS 21U

#define V86_SHADER_STAGE_VERTEX 1U
#define V86_SHADER_STAGE_FRAGMENT 2U
#define V86_LOAD_OP_CLEAR 1U
#define V86_STORE_OP_STORE 1U

#define ARRAY_LENGTH(array) (sizeof(array) / sizeof((array)[0]))

static const char vertex_shader[] =
    "@vertex fn main(@builtin(vertex_index) i: u32) -> "
    "@builtin(position) vec4f {"
    "let p = array<vec2f, 3>(vec2f(0.0, 0.72), "
    "vec2f(-0.72, -0.72), vec2f(0.72, -0.72));"
    "return vec4f(p[i], 0.0, 1.0);}";
static const char fragment_shader[] =
    "@fragment fn main() -> @location(0) vec4f {"
    "return vec4f(1.0, 0.08, 0.04, 1.0);}";
static const char shader_v2_vertex[] =
    "@vertex fn main(@builtin(vertex_index) index: u32) -> "
    "@builtin(position) vec4f {"
    "let positions = array<vec2f, 3>(vec2f(0.0, 0.68), "
    "vec2f(-0.68, -0.68), vec2f(0.68, -0.68));"
    "return vec4f(positions[index], 0.0, 1.0);}";
static const char shader_v2_fragment[] =
    "@fragment fn main() -> @location(0) vec4f {"
    "return vec4f(0.02, 0.95, 0.04, 1.0);}";

struct submit_builder
{
    uint8_t bytes[4096];
    size_t offset;
    uint32_t command_count;
    uint32_t resource_count;
};

static void put_u16(uint8_t *target, uint16_t value)
{
    memcpy(target, &value, sizeof(value));
}

static void put_u32(uint8_t *target, uint32_t value)
{
    memcpy(target, &value, sizeof(value));
}

static void put_f32(uint8_t *target, float value)
{
    memcpy(target, &value, sizeof(value));
}

static int fail(const char *stage)
{
    printf("V86_GPU_TRIANGLE_%s=FAIL errno=%d (%s)\n",
        stage, errno, strerror(errno));
    return 1;
}

static void begin_submit(struct submit_builder *builder,
    const uint32_t *resources, uint32_t resource_count)
{
    memset(builder, 0, sizeof(*builder));
    builder->resource_count = resource_count;
    builder->offset = 32;
    for(uint32_t index = 0; index < resource_count; index++)
    {
        put_u32(builder->bytes + builder->offset, resources[index]);
        builder->offset += 4;
    }
    while(builder->offset & 7)
    {
        builder->bytes[builder->offset++] = 0;
    }
}

static uint8_t *begin_record(struct submit_builder *builder,
    uint16_t opcode, size_t size)
{
    uint8_t *record;

    if(size < 8 || (size & 7) || builder->offset + size > sizeof(builder->bytes))
    {
        errno = EOVERFLOW;
        return NULL;
    }
    record = builder->bytes + builder->offset;
    memset(record, 0, size);
    put_u16(record, opcode);
    put_u16(record + 2, (uint16_t)(size / 4));
    builder->offset += size;
    builder->command_count++;
    return record;
}

static int add_shader(struct submit_builder *builder,
    uint32_t id, uint32_t stage, const char *source)
{
    size_t source_length = strlen(source);
    size_t padded_length = (source_length + 7) & ~(size_t)7;
    uint8_t *record = begin_record(builder, V86_OP_CREATE_SHADER,
        24 + padded_length);

    if(!record)
    {
        return -1;
    }
    put_u32(record + 8, id);
    put_u32(record + 12, stage);
    put_u32(record + 16, V86_SHADER_IR_WGSL);
    put_u32(record + 20, (uint32_t)source_length);
    memcpy(record + 24, source, source_length);
    return 0;
}

static void finish_submit(struct submit_builder *builder, uint16_t version)
{
    put_u32(builder->bytes, V86_SUBMIT_MAGIC);
    put_u16(builder->bytes + 4, version);
    put_u16(builder->bytes + 6, 0);
    put_u32(builder->bytes + 8, (uint32_t)builder->offset);
    put_u32(builder->bytes + 12, builder->command_count);
    put_u32(builder->bytes + 16, builder->resource_count);
}

static int exec_submit(int fd, struct submit_builder *builder,
    uint32_t *bo_handles, uint32_t bo_count)
{
    struct drm_virtgpu_execbuffer execbuffer = {
        .flags = VIRTGPU_EXECBUF_FENCE_FD_OUT,
        .size = (uint32_t)builder->offset,
        .command = (uintptr_t)builder->bytes,
        .bo_handles = (uintptr_t)bo_handles,
        .num_bo_handles = bo_count,
        .fence_fd = -1,
    };
    struct pollfd pollfd;

    if(ioctl(fd, DRM_IOCTL_VIRTGPU_EXECBUFFER, &execbuffer) < 0)
    {
        return -1;
    }
    if(execbuffer.fence_fd < 0)
    {
        errno = EPROTO;
        return -1;
    }
    pollfd.fd = execbuffer.fence_fd;
    pollfd.events = POLLIN;
    pollfd.revents = 0;
    if(poll(&pollfd, 1, 30000) <= 0)
    {
        close(execbuffer.fence_fd);
        errno = ETIMEDOUT;
        return -1;
    }
    close(execbuffer.fence_fd);
    return 0;
}

static drmModeConnector *find_connector(int fd,
    drmModeRes *resources, drmModeModeInfo *mode)
{
    for(int index = 0; index < resources->count_connectors; index++)
    {
        drmModeConnector *connector = drmModeGetConnector(fd,
            resources->connectors[index]);
        if(connector && connector->connection == DRM_MODE_CONNECTED &&
            connector->count_modes > 0)
        {
            *mode = connector->modes[0];
            return connector;
        }
        drmModeFreeConnector(connector);
    }
    return NULL;
}

static uint32_t find_crtc(int fd, drmModeRes *resources,
    drmModeConnector *connector)
{
    drmModeEncoder *encoder = NULL;
    uint32_t crtc_id = 0;

    if(connector->encoder_id)
    {
        encoder = drmModeGetEncoder(fd, connector->encoder_id);
        if(encoder)
        {
            crtc_id = encoder->crtc_id;
            drmModeFreeEncoder(encoder);
        }
    }
    if(crtc_id)
    {
        return crtc_id;
    }
    for(int encoder_index = 0; encoder_index < connector->count_encoders; encoder_index++)
    {
        encoder = drmModeGetEncoder(fd, connector->encoders[encoder_index]);
        if(!encoder)
        {
            continue;
        }
        for(int crtc_index = 0; crtc_index < resources->count_crtcs; crtc_index++)
        {
            if(encoder->possible_crtcs & (1U << crtc_index))
            {
                crtc_id = resources->crtcs[crtc_index];
                break;
            }
        }
        drmModeFreeEncoder(encoder);
        if(crtc_id)
        {
            break;
        }
    }
    return crtc_id;
}

static volatile sig_atomic_t stop_requested;

static void request_stop(int signal_number)
{
    (void)signal_number;
    stop_requested = 1;
}

int main(int argc, char **argv)
{
    int shader_v2 = argc == 2 && strcmp(argv[1], "--shader-v2") == 0;
    uint16_t submit_version = shader_v2 ?
        V86_CAPSET_VERSION_2 : V86_CAPSET_VERSION_1;
    uint8_t capset[V86_CAPSET_SIZE] = { 0 };
    struct drm_virtgpu_get_caps get_caps = {
        .cap_set_id = V86_CAPSET_ID,
        .cap_set_ver = submit_version,
        .addr = (uintptr_t)capset,
        .size = sizeof(capset),
    };
    struct drm_virtgpu_context_set_param context_param = {
        .param = VIRTGPU_CONTEXT_PARAM_CAPSET_ID,
        .value = V86_CAPSET_ID,
    };
    struct drm_virtgpu_context_init context_init = {
        .num_params = 1,
        .ctx_set_params = (uintptr_t)&context_param,
    };
    struct drm_virtgpu_resource_create resource_create = { 0 };
    struct drm_virtgpu_3d_transfer_to_host transfer = { 0 };
    struct submit_builder builder;
    drmModeRes *mode_resources = NULL;
    drmModeConnector *connector = NULL;
    drmModeModeInfo mode = { 0 };
    uint32_t crtc_id;
    uint32_t card_handle = 0;
    uint32_t framebuffer_id = 0;
    uint32_t magic;
    uint32_t feature_bits;
    uint32_t shader_ir_bits;
    uint32_t bo_handle;
    int render_fd = -1;
    int card_fd = -1;
    int prime_fd = -1;
    uint8_t *record;
    uint16_t capset_version;
    const char *selected_vertex_shader;
    const char *selected_fragment_shader;

    if(argc > 2 || (argc == 2 && !shader_v2))
    {
        fprintf(stderr, "usage: %s [--shader-v2]\n", argv[0]);
        return 2;
    }
    selected_vertex_shader = shader_v2 ? shader_v2_vertex : vertex_shader;
    selected_fragment_shader = shader_v2 ? shader_v2_fragment : fragment_shader;

    printf("V86_GPU_TRIANGLE_BEGIN\n");
    render_fd = open("/dev/dri/renderD128", O_RDWR | O_CLOEXEC);
    if(render_fd < 0)
    {
        return fail("RENDER_NODE");
    }
    printf("V86_GPU_TRIANGLE_RENDER_NODE=/dev/dri/renderD128\n");

    if(ioctl(render_fd, DRM_IOCTL_VIRTGPU_GET_CAPS, &get_caps) < 0)
    {
        return fail("GET_CAPS");
    }
    memcpy(&magic, capset, sizeof(magic));
    memcpy(&capset_version, capset + 4, sizeof(capset_version));
    memcpy(&feature_bits, capset + 12, sizeof(feature_bits));
    memcpy(&shader_ir_bits, capset + 16, sizeof(shader_ir_bits));
    if(magic != V86_CAPSET_MAGIC ||
       capset_version != submit_version ||
       !(feature_bits & V86_FEATURE_BASIC_RENDER) ||
       !(shader_ir_bits & V86_SHADER_IR_WGSL))
    {
        errno = EPROTO;
        return fail("GET_CAPS");
    }
    printf("V86_GPU_TRIANGLE_GET_CAPS=PASS version=%u features=0x%08x shaders=0x%08x\n",
        capset_version, feature_bits, shader_ir_bits);
    if(ioctl(render_fd, DRM_IOCTL_VIRTGPU_CONTEXT_INIT, &context_init) < 0)
    {
        return fail("CONTEXT_INIT");
    }
    printf("V86_GPU_TRIANGLE_CONTEXT_INIT=PASS capset=%u\n", V86_CAPSET_ID);

    card_fd = open("/dev/dri/card0", O_RDWR | O_CLOEXEC);
    if(card_fd < 0)
    {
        return fail("CARD_OPEN");
    }
    if(drmSetMaster(card_fd) < 0 && errno != EBUSY)
    {
        return fail("DRM_MASTER");
    }
    mode_resources = drmModeGetResources(card_fd);
    if(!mode_resources)
    {
        return fail("MODE_RESOURCES");
    }
    connector = find_connector(card_fd, mode_resources, &mode);
    if(!connector)
    {
        errno = ENODEV;
        return fail("CONNECTOR");
    }
    crtc_id = find_crtc(card_fd, mode_resources, connector);
    if(!crtc_id)
    {
        errno = ENODEV;
        return fail("CRTC");
    }
    resource_create.target = V86_TARGET_TEXTURE_2D;
    resource_create.format = V86_FORMAT_R8G8B8A8_UNORM;
    resource_create.bind = V86_BIND_RENDER_TARGET;
    resource_create.width = mode.hdisplay;
    resource_create.height = mode.vdisplay;
    resource_create.depth = 1;
    resource_create.array_size = 1;
    resource_create.last_level = 0;
    resource_create.nr_samples = 1;
    resource_create.size = mode.hdisplay * mode.vdisplay * 4U;
    resource_create.stride = mode.hdisplay * 4U;
    if(ioctl(render_fd, DRM_IOCTL_VIRTGPU_RESOURCE_CREATE, &resource_create) < 0)
    {
        return fail("RESOURCE_CREATE");
    }
    bo_handle = resource_create.bo_handle;

    transfer.bo_handle = bo_handle;
    transfer.box.w = 1;
    transfer.box.h = 1;
    transfer.box.d = 1;
    transfer.stride = 0;
    if(ioctl(render_fd, DRM_IOCTL_VIRTGPU_TRANSFER_TO_HOST, &transfer) < 0)
    {
        return fail("TRANSFER");
    }
    printf("V86_GPU_TRIANGLE_TRANSFER=PASS\n");

    begin_submit(&builder, NULL, 0);
    if(add_shader(&builder, 1, V86_SHADER_STAGE_VERTEX, selected_vertex_shader) < 0 ||
       add_shader(&builder, 2, V86_SHADER_STAGE_FRAGMENT, selected_fragment_shader) < 0)
    {
        return fail("SHADER_RECORD");
    }
    record = begin_record(&builder, V86_OP_CREATE_PIPELINE, 40);
    if(!record)
    {
        return fail("PIPELINE_RECORD");
    }
    put_u32(record + 8, 1);
    put_u32(record + 12, 1);
    put_u32(record + 16, 2);
    put_u32(record + 20, V86_TOPOLOGY_TRIANGLE_LIST);
    put_u32(record + 24, V86_FORMAT_R8G8B8A8_UNORM);
    put_u32(record + 28, 1);
    finish_submit(&builder, submit_version);
    if(exec_submit(render_fd, &builder, NULL, 0) < 0)
    {
        return fail("OBJECT_SUBMIT");
    }

    begin_submit(&builder, &resource_create.res_handle, 1);
    record = begin_record(&builder, V86_OP_BEGIN_RENDER_PASS, 40);
    if(!record)
    {
        return fail("RENDER_RECORD");
    }
    put_u32(record + 8, 0);
    put_u32(record + 12, V86_LOAD_OP_CLEAR);
    put_u32(record + 16, V86_STORE_OP_STORE);
    put_f32(record + 20, 0.02F);
    put_f32(record + 24, 0.04F);
    put_f32(record + 28, 0.10F);
    put_f32(record + 32, 1.0F);
    record = begin_record(&builder, V86_OP_SET_PIPELINE, 16);
    put_u32(record + 8, 1);
    record = begin_record(&builder, V86_OP_SET_VIEWPORT, 32);
    put_f32(record + 8, 0.0F);
    put_f32(record + 12, 0.0F);
    put_f32(record + 16, mode.hdisplay);
    put_f32(record + 20, mode.vdisplay);
    put_f32(record + 24, 0.0F);
    put_f32(record + 28, 1.0F);
    record = begin_record(&builder, V86_OP_SET_SCISSOR, 24);
    put_u32(record + 16, mode.hdisplay);
    put_u32(record + 20, mode.vdisplay);
    record = begin_record(&builder, V86_OP_DRAW, 24);
    put_u32(record + 8, 3);
    put_u32(record + 12, 1);
    if(!begin_record(&builder, V86_OP_END_RENDER_PASS, 8))
    {
        return fail("RENDER_RECORD");
    }
    finish_submit(&builder, submit_version);
    if(exec_submit(render_fd, &builder, &bo_handle, 1) < 0)
    {
        return fail("RENDER_SUBMIT");
    }
    printf("V86_GPU_TRIANGLE_SUBMIT=PASS\n");

    if(drmPrimeHandleToFD(render_fd, bo_handle, DRM_CLOEXEC | DRM_RDWR, &prime_fd) < 0 ||
       drmPrimeFDToHandle(card_fd, prime_fd, &card_handle) < 0)
    {
        return fail("PRIME_IMPORT");
    }
    if(drmModeAddFB(card_fd, mode.hdisplay, mode.vdisplay, 24, 32,
        resource_create.stride, card_handle, &framebuffer_id) < 0)
    {
        return fail("FRAMEBUFFER");
    }
    if(drmModeSetCrtc(card_fd, crtc_id, framebuffer_id, 0, 0,
        &connector->connector_id, 1, &mode) < 0)
    {
        return fail("MODESET");
    }
    printf("V86_GPU_TRIANGLE_FENCE=PASS\n");
    if(drmModeDirtyFB(card_fd, framebuffer_id, NULL, 0) < 0)
    {
        return fail("FLUSH");
    }

    printf("V86_GPU_TRIANGLE_MODESET=PASS width=%u height=%u\n",
        mode.hdisplay, mode.vdisplay);
    printf("V86_GPU_TRIANGLE_READY=PASS\n");
    if(shader_v2)
    {
        printf("V86_GPU_SHADER_V2=PASS\n");
    }
    printf("V86_APPLIANCE_READY=PASS\n");
    signal(SIGINT, request_stop);
    signal(SIGTERM, request_stop);
    fflush(stdout);
    while(!stop_requested)
    {
        pause();
    }
    drmModeSetCrtc(card_fd, crtc_id, 0, 0, 0, NULL, 0, NULL);
    drmModeRmFB(card_fd, framebuffer_id);

    close(prime_fd);
    drmModeFreeConnector(connector);
    drmModeFreeResources(mode_resources);
    close(card_fd);
    close(render_fd);
    printf("V86_GPU_TRIANGLE_TEARDOWN=PASS\n");
    printf("V86_GPU_TRIANGLE_END\n");
    return 0;
}
