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
#include <sys/mman.h>

#include <EGL/egl.h>
#include <EGL/eglext.h>
#include <GLES2/gl2.h>
#include <gbm.h>

#include <drm.h>
#include <xf86drm.h>
#include <xf86drmMode.h>
#include <virtgpu_drm.h>

#define V86_CAPSET_ID 7U
#define V86_CAPSET_VERSION_1 1U
#define V86_CAPSET_VERSION_2 2U
#define V86_CAPSET_VERSION_3 3U
#define V86_CAPSET_SIZE 912U
#define V86_CAPSET_MAGIC 0x57363856U
#define V86_SUBMIT_MAGIC 0x53363856U
#define V86_FORMAT_R8_UNORM 64U
#define V86_FORMAT_R8G8B8A8_UNORM 67U
#define V86_FEATURE_BASIC_RENDER (1U << 0)
#define V86_FEATURE_VERTEX_BUFFERS (1U << 1)
#define V86_FEATURE_INDEXED_DRAW (1U << 2)
#define V86_FEATURE_SAMPLED_TEXTURES (1U << 3)
#define V86_FEATURE_UNIFORM_BUFFERS (1U << 4)
#define V86_FEATURE_BLENDING (1U << 6)
#define V86_SHADER_IR_WGSL (1U << 0)
#define V86_SHADER_IR_SPIRV (1U << 1)
#define V86_TARGET_BUFFER 0U
#define V86_TARGET_TEXTURE_2D 2U
#define V86_BIND_CONSTANT_BUFFER (1U << 2)
#define V86_BIND_SAMPLER_VIEW (1U << 3)
#define V86_BIND_VERTEX_BUFFER (1U << 4)
#define V86_BIND_INDEX_BUFFER (1U << 6)
#define V86_BIND_RENDER_TARGET (1U << 1)
#define V86_TOPOLOGY_TRIANGLE_LIST 3U

#define V86_OP_CREATE_SHADER 1U
#define V86_OP_CREATE_PIPELINE 3U
#define V86_OP_BEGIN_RENDER_PASS 16U
#define V86_OP_SET_PIPELINE 17U
#define V86_OP_SET_VIEWPORT 18U
#define V86_OP_SET_SCISSOR 19U
#define V86_OP_DRAW 20U
#define V86_OP_END_RENDER_PASS 21U
#define V86_OP_SET_VERTEX_BUFFER 22U
#define V86_OP_SET_BIND_GROUP 23U
#define V86_OP_SET_INDEX_BUFFER 24U
#define V86_OP_DRAW_INDEXED 25U

#define V86_SHADER_STAGE_VERTEX 1U
#define V86_SHADER_STAGE_FRAGMENT 2U
#define V86_LOAD_OP_CLEAR 1U
#define V86_STORE_OP_STORE 1U
#define V86_BLEND_PREMULTIPLIED_ALPHA 1U
#define V86_VERTEX_FORMAT_FLOAT32X2 2U
#define V86_BINDING_BUFFER 1U
#define V86_BINDING_TEXTURE 2U
#define V86_BINDING_SAMPLER 3U

#define ARRAY_LENGTH(array) (sizeof(array) / sizeof((array)[0]))
#define V86_INDEX_FORMAT_UINT32 2U

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

#include "virtio-gpu-triangle-spv.h"

struct submit_builder
{
    uint8_t bytes[32768];
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

static int add_shader(struct submit_builder *builder, uint32_t id,
    uint32_t stage, uint32_t ir_kind, const void *source, size_t source_length)
{
    size_t padded_length = (source_length + 7) & ~(size_t)7;
    uint8_t *record = begin_record(builder, V86_OP_CREATE_SHADER,
        24 + padded_length);

    if(!record)
    {
        return -1;
    }
    put_u32(record + 8, id);
    put_u32(record + 12, stage);
    put_u32(record + 16, ir_kind);
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

static GLuint compile_gl_shader(GLenum stage, const char *source)
{
    GLuint shader = glCreateShader(stage);
    GLint compiled = GL_FALSE;

    glShaderSource(shader, 1, &source, NULL);
    glCompileShader(shader);
    glGetShaderiv(shader, GL_COMPILE_STATUS, &compiled);
    if(compiled != GL_TRUE)
    {
        char log[1024] = { 0 };
        glGetShaderInfoLog(shader, sizeof(log), NULL, log);
        fprintf(stderr, "V86_GPU_GLSL_COMPILE_ERROR stage=0x%x log=%s\n",
            stage, log);
        glDeleteShader(shader);
        errno = EPROTO;
        return 0;
    }
    return shader;
}

static int run_llvmpipe_reference(void)
{
    static const char reference_vertex_shader[] =
        "attribute vec2 position;"
        "attribute vec2 uv_in;"
        "varying vec2 uv;"
        "void main(){gl_Position=vec4(position,0.0,1.0);uv=uv_in;}";
    static const char reference_fragment_shader[] =
        "precision mediump float;"
        "varying vec2 uv;"
        "uniform sampler2D color_texture;"
        "uniform vec4 tint;"
        "void main(){gl_FragColor=texture2D(color_texture,uv)*tint;}";
    static const GLfloat positions[] = {
        0.0F, 0.72F, -0.72F, -0.72F, 0.72F, -0.72F,
    };
    static const GLfloat uvs[] = {
        0.5F, 0.0F, 0.0F, 1.0F, 1.0F, 1.0F,
    };
    static const uint8_t texture_pixels[] = {
        255, 16, 8, 255, 255, 16, 8, 255,
        255, 16, 8, 255, 255, 16, 8, 255,
    };
    static const EGLint config_attributes[] = {
        EGL_SURFACE_TYPE, EGL_PBUFFER_BIT,
        EGL_RENDERABLE_TYPE, EGL_OPENGL_ES2_BIT,
        EGL_RED_SIZE, 8, EGL_GREEN_SIZE, 8, EGL_BLUE_SIZE, 8, EGL_ALPHA_SIZE, 8,
        EGL_NONE,
    };
    static const EGLint surface_attributes[] = {
        EGL_WIDTH, 64, EGL_HEIGHT, 64, EGL_NONE,
    };
    static const EGLint context_attributes[] = {
        EGL_CONTEXT_CLIENT_VERSION, 2, EGL_NONE,
    };
    EGLDisplay display = EGL_NO_DISPLAY;
    EGLSurface surface = EGL_NO_SURFACE;
    EGLContext context = EGL_NO_CONTEXT;
    EGLConfig config = NULL;
    EGLint config_count = 0;
    GLuint vertex_shader = 0;
    GLuint fragment_shader = 0;
    GLuint program = 0;
    GLuint buffers[2] = { 0, 0 };
    GLuint texture = 0;
    uint8_t center[4] = { 0 };
    uint8_t corner[4] = { 0 };
    const char *renderer;
    int result = -1;
    struct gbm_device *gbm = NULL;
    int drm_fd = -1;
    int webgpuvirt = getenv("V86_MESA_WEBGPUVIRT") != NULL;

    if(webgpuvirt)
    {
        unsetenv("LIBGL_ALWAYS_SOFTWARE");
        unsetenv("GALLIUM_DRIVER");
        setenv("EGL_PLATFORM", "surfaceless", 1);
        display = eglGetPlatformDisplay(EGL_PLATFORM_SURFACELESS_MESA,
            EGL_DEFAULT_DISPLAY, NULL);
    }
    else
    {
        setenv("LIBGL_ALWAYS_SOFTWARE", "true", 1);
        setenv("LIBGL_DRIVERS_PATH", "/usr/lib/dri", 1);
        setenv("GALLIUM_DRIVER", "llvmpipe", 1);
        setenv("EGL_PLATFORM", "surfaceless", 1);
        display = eglGetPlatformDisplay(EGL_PLATFORM_SURFACELESS_MESA,
            EGL_DEFAULT_DISPLAY, NULL);
    }
    if(display == EGL_NO_DISPLAY || !eglInitialize(display, NULL, NULL) ||
       !eglChooseConfig(display, config_attributes, &config, 1, &config_count) ||
       config_count != 1 || !eglBindAPI(EGL_OPENGL_ES_API))
    {
        fprintf(stderr, "V86_GPU_EGL_INIT_ERROR=0x%x display=%p configs=%d\n",
            eglGetError(), (void *)display, config_count);
        errno = EPROTO;
        goto cleanup;
    }
    surface = eglCreatePbufferSurface(display, config, surface_attributes);
    context = eglCreateContext(display, config, EGL_NO_CONTEXT, context_attributes);
    if(surface == EGL_NO_SURFACE || context == EGL_NO_CONTEXT ||
       !eglMakeCurrent(display, surface, surface, context))
    {
        fprintf(stderr, "V86_GPU_EGL_CONTEXT_ERROR=0x%x surface=%p context=%p\n",
            eglGetError(), (void *)surface, (void *)context);
        errno = EPROTO;
        goto cleanup;
    }
    renderer = (const char *)glGetString(GL_RENDERER);
    if(!renderer ||
       (webgpuvirt ? !strstr(renderer, "webgpuvirt") : !strstr(renderer, "llvmpipe")))
    {
        errno = EPROTO;
        goto cleanup;
    }

    fprintf(stderr, "V86_GPU_MESA_RENDERER=%s\n", renderer);
    vertex_shader = compile_gl_shader(GL_VERTEX_SHADER, reference_vertex_shader);
    fragment_shader = compile_gl_shader(GL_FRAGMENT_SHADER, reference_fragment_shader);
    if(!vertex_shader || !fragment_shader)
    {
        goto cleanup;
    }
    program = glCreateProgram();
    glAttachShader(program, vertex_shader);
    glAttachShader(program, fragment_shader);
    glBindAttribLocation(program, 0, "position");
    glBindAttribLocation(program, 1, "uv_in");
    glLinkProgram(program);
    {
        GLint linked = GL_FALSE;
        glGetProgramiv(program, GL_LINK_STATUS, &linked);
        if(linked != GL_TRUE)
        {
            errno = EPROTO;
            goto cleanup;
        }
    }
    glUseProgram(program);
    glGenBuffers(2, buffers);
    glBindBuffer(GL_ARRAY_BUFFER, buffers[0]);
    glBufferData(GL_ARRAY_BUFFER, sizeof(positions), positions, GL_STATIC_DRAW);
    glVertexAttribPointer(0, 2, GL_FLOAT, GL_FALSE, 0, NULL);
    glEnableVertexAttribArray(0);
    glBindBuffer(GL_ARRAY_BUFFER, buffers[1]);
    glBufferData(GL_ARRAY_BUFFER, sizeof(uvs), uvs, GL_STATIC_DRAW);
    glVertexAttribPointer(1, 2, GL_FLOAT, GL_FALSE, 0, NULL);
    glEnableVertexAttribArray(1);
    glGenTextures(1, &texture);
    glActiveTexture(GL_TEXTURE0);
    glBindTexture(GL_TEXTURE_2D, texture);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_NEAREST);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_NEAREST);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
    glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA, 2, 2, 0,
        GL_RGBA, GL_UNSIGNED_BYTE, texture_pixels);
    glUniform1i(glGetUniformLocation(program, "color_texture"), 0);
    glUniform4f(glGetUniformLocation(program, "tint"), 1.0F, 1.0F, 1.0F, 1.0F);
    glEnable(GL_BLEND);
    glBlendFunc(GL_ONE, GL_ONE_MINUS_SRC_ALPHA);
    glViewport(0, 0, 64, 64);
    glClearColor(0.02F, 0.04F, 0.30F, 1.0F);
    glClear(GL_COLOR_BUFFER_BIT);
    glDrawArrays(GL_TRIANGLES, 0, 3);
    glFinish();
    glReadPixels(32, 32, 1, 1, GL_RGBA, GL_UNSIGNED_BYTE, center);
    glReadPixels(1, 1, 1, 1, GL_RGBA, GL_UNSIGNED_BYTE, corner);
    fprintf(stderr, "V86_GPU_MESA_PIXELS center=%u,%u,%u,%u corner=%u,%u,%u,%u\n",
        center[0], center[1], center[2], center[3],
        corner[0], corner[1], corner[2], corner[3]);
    if(glGetError() != GL_NO_ERROR ||
       center[0] < 180 || center[1] > 100 || center[2] > 100 ||
       corner[2] <= corner[0] || corner[2] <= corner[1])
    {
        errno = EPROTO;
        goto cleanup;
    }
    printf("%s renderer=%s center=%u,%u,%u,%u corner=%u,%u,%u,%u\n",
        webgpuvirt ? "V86_GPU_MESA_WEBGPUVIRT=PASS" :
            "V86_GPU_LLVMPIPE_REFERENCE=PASS",
        renderer, center[0], center[1], center[2], center[3],
        corner[0], corner[1], corner[2], corner[3]);
    result = 0;

cleanup:
    if(texture) glDeleteTextures(1, &texture);
    if(buffers[0] || buffers[1]) glDeleteBuffers(2, buffers);
    if(program) glDeleteProgram(program);
    if(vertex_shader) glDeleteShader(vertex_shader);
    if(fragment_shader) glDeleteShader(fragment_shader);
    if(display != EGL_NO_DISPLAY)
    {
        eglMakeCurrent(display, EGL_NO_SURFACE, EGL_NO_SURFACE, EGL_NO_CONTEXT);
        if(context != EGL_NO_CONTEXT) eglDestroyContext(display, context);
        if(surface != EGL_NO_SURFACE) eglDestroySurface(display, surface);
        eglTerminate(display);
    }
    if(gbm) gbm_device_destroy(gbm);
    if(drm_fd >= 0) close(drm_fd);
    return result;
}

static int create_resource(int fd, struct drm_virtgpu_resource_create *resource,
    uint32_t target, uint32_t format, uint32_t bind, uint32_t width,
    uint32_t height, uint32_t size, uint32_t stride)
{
    memset(resource, 0, sizeof(*resource));
    resource->target = target;
    resource->format = format;
    resource->bind = bind;
    resource->width = width;
    resource->height = height;
    resource->depth = 1;
    resource->array_size = 1;
    resource->nr_samples = 1;
    resource->size = size;
    resource->stride = stride;
    return ioctl(fd, DRM_IOCTL_VIRTGPU_RESOURCE_CREATE, resource);
}

static int upload_resource(int fd, const struct drm_virtgpu_resource_create *resource,
    const void *data, size_t size, uint32_t width, uint32_t height)
{
    struct drm_virtgpu_map map = { .handle = resource->bo_handle };
    struct drm_virtgpu_3d_transfer_to_host transfer = {
        .bo_handle = resource->bo_handle,
        .box = { .w = width, .h = height, .d = 1 },
    };
    void *address;

    if(size > resource->size)
    {
        errno = EOVERFLOW;
        printf("V86_GPU_TRIANGLE_UPLOAD_STAGE=SIZE handle=%u\n", resource->bo_handle);
        return -1;
    }
    if(ioctl(fd, DRM_IOCTL_VIRTGPU_MAP, &map) < 0)
    {
        printf("V86_GPU_TRIANGLE_UPLOAD_STAGE=MAP handle=%u errno=%d\n",
            resource->bo_handle, errno);
        return -1;
    }
    address = mmap(NULL, resource->size, PROT_READ | PROT_WRITE, MAP_SHARED, fd, map.offset);
    if(address == MAP_FAILED)
    {
        printf("V86_GPU_TRIANGLE_UPLOAD_STAGE=MMAP handle=%u errno=%d\n",
            resource->bo_handle, errno);
        return -1;
    }
    memcpy(address, data, size);
    if(munmap(address, resource->size) < 0)
    {
        printf("V86_GPU_TRIANGLE_UPLOAD_STAGE=MUNMAP handle=%u errno=%d\n",
            resource->bo_handle, errno);
        return -1;
    }
    if(ioctl(fd, DRM_IOCTL_VIRTGPU_TRANSFER_TO_HOST, &transfer) < 0)
    {
        printf("V86_GPU_TRIANGLE_UPLOAD_STAGE=TRANSFER handle=%u errno=%d\n",
            resource->bo_handle, errno);
        return -1;
    }
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
    static const float positions[] = {
        0.0F, 0.72F, -0.72F, -0.72F, 0.72F, -0.72F,
    };
    static const float uvs[] = {
        0.5F, 0.0F, 0.0F, 1.0F, 1.0F, 1.0F,
    };
    static const uint32_t indices[] = { 0, 1, 2 };
    static const uint8_t texture_pixels[] = {
        255, 16, 8, 255, 255, 16, 8, 255,
        255, 16, 8, 255, 255, 16, 8, 255,
    };
    static const float tint[] = { 1.0F, 1.0F, 1.0F, 1.0F };
    int shader_v2 = argc == 2 && strcmp(argv[1], "--shader-v2") == 0;
    int shader_v3 = argc == 2 && strcmp(argv[1], "--shader-v3") == 0;
    uint16_t submit_version = shader_v3 ? V86_CAPSET_VERSION_3 :
        shader_v2 ? V86_CAPSET_VERSION_2 : V86_CAPSET_VERSION_1;
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
    struct drm_virtgpu_resource_create gpu_resources[6] = { 0 };
    struct drm_virtgpu_3d_transfer_to_host transfer = { 0 };
    struct submit_builder builder;
    drmModeRes *mode_resources = NULL;
    drmModeConnector *connector = NULL;
    drmModeModeInfo mode = { 0 };
    uint32_t resource_ids[6] = { 0 };
    uint32_t bo_handles[6] = { 0 };
    uint32_t resource_count = shader_v3 ? 6 : 1;
    uint32_t crtc_id;
    uint32_t card_handle = 0;
    uint32_t framebuffer_id = 0;
    uint32_t magic;
    uint32_t feature_bits;
    uint32_t shader_ir_bits;
    uint32_t required_features = V86_FEATURE_BASIC_RENDER;
    uint32_t required_shader_ir = shader_v3 ? V86_SHADER_IR_SPIRV : V86_SHADER_IR_WGSL;
    int render_fd = -1;
    int card_fd = -1;
    int prime_fd = -1;
    uint8_t *record;
    uint16_t capset_version;
    const void *selected_vertex_shader;
    const void *selected_fragment_shader;
    size_t selected_vertex_shader_size;
    size_t selected_fragment_shader_size;

    if(argc > 2 || (argc == 2 && !shader_v2 && !shader_v3))
    {
        fprintf(stderr, "usage: %s [--shader-v2|--shader-v3]\n", argv[0]);
        return 2;
    }
    if(shader_v3)
    {
        selected_vertex_shader = shader_v3_vertex_spirv;
        selected_vertex_shader_size = sizeof(shader_v3_vertex_spirv);
        selected_fragment_shader = shader_v3_fragment_spirv;
        selected_fragment_shader_size = sizeof(shader_v3_fragment_spirv);
        required_features |= V86_FEATURE_VERTEX_BUFFERS | V86_FEATURE_INDEXED_DRAW |
            V86_FEATURE_SAMPLED_TEXTURES | V86_FEATURE_UNIFORM_BUFFERS |
            V86_FEATURE_BLENDING;
    }
    else
    {
        selected_vertex_shader = shader_v2 ? shader_v2_vertex : vertex_shader;
        selected_vertex_shader_size = strlen(selected_vertex_shader);
        selected_fragment_shader = shader_v2 ? shader_v2_fragment : fragment_shader;
        selected_fragment_shader_size = strlen(selected_fragment_shader);
    }

    printf("V86_GPU_TRIANGLE_BEGIN\n");
    if(shader_v3 && run_llvmpipe_reference() < 0)
    {
        return fail("LLVMPIPE_REFERENCE");
    }
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
    if(magic != V86_CAPSET_MAGIC || capset_version != submit_version ||
       (feature_bits & required_features) != required_features ||
       !(shader_ir_bits & required_shader_ir))
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
    if(create_resource(render_fd, &gpu_resources[0], V86_TARGET_TEXTURE_2D,
        V86_FORMAT_R8G8B8A8_UNORM, V86_BIND_RENDER_TARGET,
        mode.hdisplay, mode.vdisplay, mode.hdisplay * mode.vdisplay * 4U,
        mode.hdisplay * 4U) < 0)
    {
        return fail("RESOURCE_CREATE");
    }
    transfer.bo_handle = gpu_resources[0].bo_handle;
    transfer.box.w = 1;
    transfer.box.h = 1;
    transfer.box.d = 1;
    if(ioctl(render_fd, DRM_IOCTL_VIRTGPU_TRANSFER_TO_HOST, &transfer) < 0)
    {
        return fail("TRANSFER");
    }

    if(shader_v3)
    {
        if(create_resource(render_fd, &gpu_resources[1], V86_TARGET_BUFFER,
            V86_FORMAT_R8_UNORM, V86_BIND_VERTEX_BUFFER,
            sizeof(positions), 1, sizeof(positions), sizeof(positions)) < 0 ||
           create_resource(render_fd, &gpu_resources[2], V86_TARGET_BUFFER,
            V86_FORMAT_R8_UNORM, V86_BIND_VERTEX_BUFFER,
            sizeof(uvs), 1, sizeof(uvs), sizeof(uvs)) < 0 ||
           create_resource(render_fd, &gpu_resources[3], V86_TARGET_TEXTURE_2D,
            V86_FORMAT_R8G8B8A8_UNORM, V86_BIND_SAMPLER_VIEW,
            2, 2, sizeof(texture_pixels), 8) < 0 ||
           create_resource(render_fd, &gpu_resources[4], V86_TARGET_BUFFER,
            V86_FORMAT_R8_UNORM, V86_BIND_CONSTANT_BUFFER,
            sizeof(tint), 1, sizeof(tint), sizeof(tint)) < 0 ||
           create_resource(render_fd, &gpu_resources[5], V86_TARGET_BUFFER,
            V86_FORMAT_R8_UNORM, V86_BIND_INDEX_BUFFER,
            sizeof(indices), 1, sizeof(indices), sizeof(indices)) < 0)
        {
            return fail("RESOURCE_CREATE");
        }
        if(upload_resource(render_fd, &gpu_resources[1], positions, sizeof(positions),
            sizeof(positions), 1) < 0 ||
           upload_resource(render_fd, &gpu_resources[2], uvs, sizeof(uvs),
            sizeof(uvs), 1) < 0 ||
           upload_resource(render_fd, &gpu_resources[3], texture_pixels,
            sizeof(texture_pixels), 2, 2) < 0 ||
           upload_resource(render_fd, &gpu_resources[4], tint, sizeof(tint),
            sizeof(tint), 1) < 0 ||
           upload_resource(render_fd, &gpu_resources[5], indices, sizeof(indices),
            sizeof(indices), 1) < 0)
        {
            return fail("RESOURCE_UPLOAD");
        }
        printf("V86_GPU_TRIANGLE_RESOURCES=PASS textures=2 vertex_buffers=2 index_buffers=1 uniforms=1\n");
    }
    printf("V86_GPU_TRIANGLE_TRANSFER=PASS\n");

    begin_submit(&builder, NULL, 0);
    if(add_shader(&builder, 1, V86_SHADER_STAGE_VERTEX, required_shader_ir,
        selected_vertex_shader, selected_vertex_shader_size) < 0 ||
       add_shader(&builder, 2, V86_SHADER_STAGE_FRAGMENT, required_shader_ir,
        selected_fragment_shader, selected_fragment_shader_size) < 0)
    {
        return fail("SHADER_RECORD");
    }
    record = begin_record(&builder, V86_OP_CREATE_PIPELINE, shader_v3 ? 96 : 40);
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
    if(shader_v3)
    {
        put_u32(record + 32, V86_BLEND_PREMULTIPLIED_ALPHA);
        put_u32(record + 36, 2);
        put_u32(record + 40, 2);
        put_u32(record + 48, sizeof(float) * 2);
        put_u32(record + 56, sizeof(float) * 2);
        put_u32(record + 64, 0);
        put_u32(record + 68, 0);
        put_u32(record + 72, V86_VERTEX_FORMAT_FLOAT32X2);
        put_u32(record + 76, 0);
        put_u32(record + 80, 1);
        put_u32(record + 84, 0);
        put_u32(record + 88, V86_VERTEX_FORMAT_FLOAT32X2);
        put_u32(record + 92, 1);
    }
    finish_submit(&builder, submit_version);
    if(exec_submit(render_fd, &builder, NULL, 0) < 0)
    {
        return fail("OBJECT_SUBMIT");
    }

    for(uint32_t index = 0; index < resource_count; index++)
    {
        resource_ids[index] = gpu_resources[index].res_handle;
        bo_handles[index] = gpu_resources[index].bo_handle;
    }
    begin_submit(&builder, resource_ids, resource_count);
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
    put_f32(record + 28, 0.30F);
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
    if(shader_v3)
    {
        record = begin_record(&builder, V86_OP_SET_VERTEX_BUFFER, 32);
        put_u32(record + 8, 1);
        put_u32(record + 20, sizeof(positions));
        put_u32(record + 28, 0);
        record = begin_record(&builder, V86_OP_SET_VERTEX_BUFFER, 32);
        put_u32(record + 8, 2);
        put_u32(record + 20, sizeof(uvs));
        put_u32(record + 28, 1);
        record = begin_record(&builder, V86_OP_SET_BIND_GROUP, 112);
        put_u32(record + 8, 3);
        put_u32(record + 16, 0);
        put_u32(record + 20, V86_BINDING_TEXTURE);
        put_u32(record + 24, 3);
        put_u32(record + 48, 1);
        put_u32(record + 52, V86_BINDING_SAMPLER);
        put_u32(record + 56, UINT32_MAX);
        put_u32(record + 80, 2);
        put_u32(record + 84, V86_BINDING_BUFFER);
        put_u32(record + 88, 4);
        put_u32(record + 104, sizeof(tint));
        record = begin_record(&builder, V86_OP_SET_INDEX_BUFFER, 32);
        put_u32(record + 8, 5);
        put_u32(record + 20, sizeof(indices));
        put_u32(record + 28, V86_INDEX_FORMAT_UINT32);
        record = begin_record(&builder, V86_OP_DRAW_INDEXED, 32);
        put_u32(record + 8, 3);
        put_u32(record + 12, 1);
    }
    else
    {
        record = begin_record(&builder, V86_OP_DRAW, 24);
        put_u32(record + 8, 3);
        put_u32(record + 12, 1);
    }
    if(!begin_record(&builder, V86_OP_END_RENDER_PASS, 8))
    {
        return fail("RENDER_RECORD");
    }
    finish_submit(&builder, submit_version);
    if(exec_submit(render_fd, &builder, bo_handles, resource_count) < 0)
    {
        return fail("RENDER_SUBMIT");
    }
    printf("V86_GPU_TRIANGLE_SUBMIT=PASS\n");
    if(shader_v3)
    {
        printf("V86_GPU_SHADER_V3=PASS resources=%u bindings=3 indexed_draws=1\n",
            resource_count);
    }

    if(drmPrimeHandleToFD(render_fd, gpu_resources[0].bo_handle,
        DRM_CLOEXEC | DRM_RDWR, &prime_fd) < 0 ||
       drmPrimeFDToHandle(card_fd, prime_fd, &card_handle) < 0)
    {
        return fail("PRIME_IMPORT");
    }
    if(drmModeAddFB(card_fd, mode.hdisplay, mode.vdisplay, 24, 32,
        gpu_resources[0].stride, card_handle, &framebuffer_id) < 0)
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
