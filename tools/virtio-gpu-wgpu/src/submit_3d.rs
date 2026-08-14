use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::sync::Arc;

use futures_channel::oneshot;
use futures_util::future::{Either, select};
use wasm_bindgen::{JsCast, closure::Closure};

use super::{
    FORMAT_B8G8R8A8_SRGB, FORMAT_B8G8R8A8_UNORM, FORMAT_B8G8R8X8_SRGB, FORMAT_R8_UNORM,
    FORMAT_R8G8B8A8_SRGB, FORMAT_R8G8B8A8_UNORM, Renderer, record_fault,
};

const SUBMIT_MAGIC: u32 = 0x5336_3856; // "V86S"
const SUBMIT_V1: u16 = 1;
const SUBMIT_V2: u16 = 2;
const SUBMIT_V3: u16 = 3;
const SUBMIT_MINOR: u16 = 0;
const SUBMIT_HEADER_SIZE: usize = 32;
const MAX_SUBMIT_BYTES: usize = 256 * 1024;
const MAX_COMMANDS: usize = 64;
const MAX_RESOURCES: usize = 128;
const MAX_SHADER_BYTES_V1: usize = VERTEX_SHADER_SOURCE.len();
const MAX_SHADER_BYTES_V2: usize = 16 * 1024;
const MAX_SHADER_BYTES_PER_CONTEXT_V1: usize = MAX_SHADER_BYTES_V1 * MAX_SHADERS;
const MAX_SHADER_BYTES_PER_CONTEXT_V2: usize = 128 * 1024;
const MAX_SHADER_BYTES_PER_CONTEXT_V3: usize = 256 * 1024;
const MAX_SHADERS: usize = 32;
const MAX_PIPELINES: usize = 64;
const MAX_DRAWS: usize = 256;
const PIPELINE_COMPILATION_TIMEOUT_MS: i32 = 5000;
const GPU_WORK_TIMEOUT_MS: i32 = 5000;
const MAX_VERTEX_INVOCATIONS_V2: u32 = 64 * 1024;
const MAX_INSTANCES_V2: u32 = 1;
const MAX_VERTEX_INVOCATIONS_V3: u32 = 4 * 1024 * 1024;
const MAX_INSTANCES_V3: u32 = 1024;
const MAX_VERTEX_ATTRIBUTES_V3: usize = 8;
const MAX_BINDINGS_V3: usize = 16;
const MAX_INLINE_CONSTANT_WORDS: usize = 4 * 1024;
const MAX_VERTEX_BUFFERS_V3: usize = 8;

const OP_CREATE_SHADER: u16 = 1;
const OP_DESTROY_SHADER: u16 = 2;
const OP_CREATE_PIPELINE: u16 = 3;
const OP_DESTROY_PIPELINE: u16 = 4;
const OP_BEGIN_RENDER_PASS: u16 = 16;
const OP_SET_PIPELINE: u16 = 17;
const OP_SET_VIEWPORT: u16 = 18;
const OP_SET_SCISSOR: u16 = 19;
const OP_DRAW: u16 = 20;
const OP_END_RENDER_PASS: u16 = 21;
const OP_SET_VERTEX_BUFFER: u16 = 22;
const OP_SET_BIND_GROUP: u16 = 23;
const OP_SET_INDEX_BUFFER: u16 = 24;
const OP_DRAW_INDEXED: u16 = 25;

const SHADER_IR_WGSL: u32 = 1;
const SHADER_IR_SPIRV: u32 = 2;
const TOPOLOGY_TRIANGLE_LIST: u32 = 3;
const LOAD_OP_CLEAR: u32 = 1;
const STORE_OP_STORE: u32 = 1;
const SHADER_STAGE_VERTEX: u32 = 1;
const SHADER_STAGE_FRAGMENT: u32 = 2;
const BLEND_REPLACE: u32 = 0;
const BLEND_PREMULTIPLIED_ALPHA: u32 = 1;
const VERTEX_FORMAT_FLOAT32: u32 = 1;
const VERTEX_FORMAT_FLOAT32X2: u32 = 2;
const VERTEX_FORMAT_FLOAT32X3: u32 = 3;
const VERTEX_FORMAT_FLOAT32X4: u32 = 4;
const VERTEX_FORMAT_UNORM8X4: u32 = 5;
const INDEX_FORMAT_UINT16: u32 = 1;
const INDEX_FORMAT_UINT32: u32 = 2;

fn is_color_target_format(format: u32) -> bool {
    matches!(
        format,
        FORMAT_R8_UNORM
            | FORMAT_R8G8B8A8_UNORM
            | FORMAT_B8G8R8A8_UNORM
            | FORMAT_R8G8B8A8_SRGB
            | FORMAT_B8G8R8A8_SRGB
            | FORMAT_B8G8R8X8_SRGB
    )
}

const VIRGL_FORMAT_R32_FLOAT: u32 = 28;
const VIRGL_FORMAT_R32G32_FLOAT: u32 = 29;
const VIRGL_FORMAT_R16G16_USCALED: u32 = 53;
const VIRGL_FORMAT_R16G16_SSCALED: u32 = 61;
const VIRGL_FORMAT_R32G32B32_FLOAT: u32 = 30;
const VIRGL_FORMAT_R32G32B32A32_FLOAT: u32 = 31;
const VIRGL_FORMAT_R8_UINT: u32 = 177;
const VIRGL_FORMAT_R8G8B8A8_UINT: u32 = 180;
const VIRGL_FORMAT_R16G16_UINT: u32 = 186;
const VIRGL_FORMAT_R16G16_SINT: u32 = 190;
const VIRGL_FORMAT_R32G32_UINT: u32 = 194;

fn mesa_vertex_format(format: u32) -> Result<wgpu::VertexFormat, String> {
    match format {
        VIRGL_FORMAT_R32_FLOAT => Ok(wgpu::VertexFormat::Float32),
        VIRGL_FORMAT_R32G32_FLOAT => Ok(wgpu::VertexFormat::Float32x2),
        VIRGL_FORMAT_R16G16_USCALED => Ok(wgpu::VertexFormat::Uint16x2),
        VIRGL_FORMAT_R16G16_SSCALED => Ok(wgpu::VertexFormat::Sint16x2),
        VIRGL_FORMAT_R32G32B32_FLOAT => Ok(wgpu::VertexFormat::Float32x3),
        VIRGL_FORMAT_R32G32B32A32_FLOAT => Ok(wgpu::VertexFormat::Float32x4),
        VIRGL_FORMAT_R8G8B8A8_UINT => Ok(wgpu::VertexFormat::Uint8x4),
        VIRGL_FORMAT_R16G16_UINT => Ok(wgpu::VertexFormat::Uint16x2),
        VIRGL_FORMAT_R16G16_SINT => Ok(wgpu::VertexFormat::Sint16x2),
        VIRGL_FORMAT_R32G32_UINT => Ok(wgpu::VertexFormat::Uint32x2),
        VIRGL_FORMAT_R8_UINT => Err(invalid(
            "single-byte Mesa vertex attributes require packing",
        )),
        _ => Err(invalid(format!("unsupported Mesa vertex format {format}"))),
    }
}

fn mesa_vertex_attributes(
    elements: &[MesaVertexElement],
    strides: &[u64],
) -> Result<Vec<VertexAttribute3D>, String> {
    let mut attributes = Vec::with_capacity(elements.len());
    let mut location = 0;
    while location < elements.len() {
        let element = elements[location];
        let slot = element.buffer_slot as usize;
        let step_mode = if element.instance_divisor == 0 {
            wgpu::VertexStepMode::Vertex
        } else {
            wgpu::VertexStepMode::Instance
        };
        let (format, byte_length, consumed) = if element.format == VIRGL_FORMAT_R8_UINT {
            let next = elements
                .get(location + 1)
                .filter(|next| {
                    next.format == VIRGL_FORMAT_R8_UINT
                        && next.buffer_slot == element.buffer_slot
                        && next.instance_divisor == element.instance_divisor
                        && next.offset == element.offset + 1
                })
                .ok_or_else(|| invalid("unpaired single-byte Mesa vertex attribute"))?;
            let _ = next;
            (wgpu::VertexFormat::Uint8x2, 2, 2)
        } else {
            let format = mesa_vertex_format(element.format)?;
            (format, format.size(), 1)
        };
        if slot >= strides.len()
            || element
                .offset
                .checked_add(byte_length)
                .is_none_or(|end| end > strides[slot])
        {
            return Err(invalid("Mesa vertex attribute exceeds its buffer stride"));
        }
        attributes.push(VertexAttribute3D {
            location: location as u32,
            offset: element.offset,
            format,
            buffer_slot: element.buffer_slot,
            step_mode,
        });
        location += consumed;
    }
    Ok(attributes)
}

fn color_target_format(format: u32) -> Result<wgpu::TextureFormat, String> {
    match format {
        FORMAT_R8_UNORM => Ok(wgpu::TextureFormat::R8Unorm),
        FORMAT_R8G8B8A8_UNORM | FORMAT_B8G8R8A8_UNORM => Ok(wgpu::TextureFormat::Rgba8Unorm),
        FORMAT_R8G8B8A8_SRGB | FORMAT_B8G8R8A8_SRGB | FORMAT_B8G8R8X8_SRGB => {
            Ok(wgpu::TextureFormat::Rgba8UnormSrgb)
        },
        _ => Err(invalid("unsupported color target format")),
    }
}
const VERTEX_SHADER_SOURCE: &str = concat!(
    "@vertex fn main(@builtin(vertex_index) i: u32) -> ",
    "@builtin(position) vec4f {",
    "let p = array<vec2f, 3>(vec2f(0.0, 0.72), ",
    "vec2f(-0.72, -0.72), vec2f(0.72, -0.72));",
    "return vec4f(p[i], 0.0, 1.0);}",
);
const MESA_VERTEX_SHADER_SOURCE: &str = concat!(
    "struct VertexOutput {",
    "@builtin(position) position: vec4f,",
    "@location(0) uv: vec2f,",
    "};",
    "@vertex fn main(",
    "@location(0) position: vec2f,",
    "@location(1) uv: vec2f",
    ") -> VertexOutput {",
    "var output: VertexOutput;",
    "output.position = vec4f(position, 0.0, 1.0);",
    "output.uv = uv;",
    "return output;",
    "}",
);
const MESA_FRAGMENT_SHADER_SOURCE: &str = concat!(
    "@group(0) @binding(0) var color_texture: texture_2d<f32>;",
    "@group(0) @binding(1) var color_sampler: sampler;",
    "@fragment fn main(@location(0) uv: vec2f) -> @location(0) vec4f {",
    "return textureSample(color_texture, color_sampler, uv).bgra;",
    "}",
);
const MESA_VERTEX_SHADER_ID: u32 = u32::MAX - 2;
const MESA_FRAGMENT_SHADER_ID: u32 = u32::MAX - 1;
const MESA_PIPELINE_ID: u32 = u32::MAX - 64;
const GHOSTTY_COMMON_SHADER_SOURCE: &str = r#"
struct Globals {
    projection_matrix: mat4x4<f32>,
    screen_size: vec2<f32>,
    cell_size: vec2<f32>,
    grid_size_packed_2u16: u32,
    grid_padding: vec4<f32>,
    padding_extend: u32,
    min_contrast: f32,
    cursor_pos_packed_2u16: u32,
    cursor_color_packed_4u8: u32,
    bg_color_packed_4u8: u32,
    bools: u32,
}
@group(0) @binding(0) var<uniform> globals: Globals;

const CURSOR_WIDE: u32 = 1u;
const USE_LINEAR_BLENDING: u32 = 4u;
const USE_LINEAR_CORRECTION: u32 = 8u;
const EXTEND_LEFT: u32 = 1u;
const EXTEND_RIGHT: u32 = 2u;
const EXTEND_UP: u32 = 4u;
const EXTEND_DOWN: u32 = 8u;

fn unpack4u8(value: u32) -> vec4<u32> {
    return vec4<u32>(
        value & 0xffu,
        (value >> 8u) & 0xffu,
        (value >> 16u) & 0xffu,
        (value >> 24u) & 0xffu,
    );
}

fn unpack2u16(value: u32) -> vec2<u32> {
    return vec2<u32>(value & 0xffffu, value >> 16u);
}

fn linearize_component(value: f32) -> f32 {
    if value <= 0.04045 {
        return value / 12.92;
    }
    return pow((value + 0.055) / 1.055, 2.4);
}

fn unlinearize_component(value: f32) -> f32 {
    if value <= 0.0031308 {
        return value * 12.92;
    }
    return pow(value, 1.0 / 2.4) * 1.055 - 0.055;
}

fn linearize_rgb(value: vec3<f32>) -> vec3<f32> {
    return vec3<f32>(
        linearize_component(value.r),
        linearize_component(value.g),
        linearize_component(value.b),
    );
}

fn unlinearize_rgb(value: vec3<f32>) -> vec3<f32> {
    return vec3<f32>(
        unlinearize_component(value.r),
        unlinearize_component(value.g),
        unlinearize_component(value.b),
    );
}

fn load_color(packed: u32, linear: bool) -> vec4<f32> {
    let bytes = vec4<f32>(unpack4u8(packed)) / vec4<f32>(255.0);
    var color = bytes;
    if linear {
        color = vec4<f32>(linearize_rgb(color.rgb), color.a);
    }
    return vec4<f32>(color.rgb * color.a, color.a);
}

fn luminance(color: vec3<f32>) -> f32 {
    return dot(color, vec3<f32>(0.2126, 0.7152, 0.0722));
}

fn contrast_ratio(a: vec3<f32>, b: vec3<f32>) -> f32 {
    let a_luminance = luminance(a) + 0.05;
    let b_luminance = luminance(b) + 0.05;
    return max(a_luminance, b_luminance) / min(a_luminance, b_luminance);
}

fn contrasted_color(minimum: f32, foreground: vec4<f32>, background: vec4<f32>) -> vec4<f32> {
    if contrast_ratio(foreground.rgb, background.rgb) < minimum {
        if contrast_ratio(vec3<f32>(1.0), background.rgb) >
            contrast_ratio(vec3<f32>(0.0), background.rgb) {
            return vec4<f32>(1.0);
        }
        return vec4<f32>(0.0, 0.0, 0.0, 1.0);
    }
    return foreground;
}
"#;
const GHOSTTY_FULLSCREEN_VERTEX_SHADER_SOURCE: &str = r#"
@vertex fn main(@builtin(vertex_index) vertex: u32) -> @builtin(position) vec4<f32> {
    let positions = array<vec2<f32>, 4>(
        vec2<f32>(-1.0, 1.0),
        vec2<f32>(1.0, 1.0),
        vec2<f32>(-1.0, -1.0),
        vec2<f32>(1.0, -1.0),
    );
    return vec4<f32>(positions[vertex], 0.0, 1.0);
}
"#;
const GHOSTTY_BACKGROUND_FRAGMENT_SHADER_SOURCE: &str = r#"
@fragment fn main() -> @location(0) vec4<f32> {
    let linear = (globals.bools & USE_LINEAR_BLENDING) != 0u;
    return load_color(globals.bg_color_packed_4u8, linear);
}
"#;
const GHOSTTY_CELL_BACKGROUND_FRAGMENT_SHADER_SOURCE: &str = r#"
struct CellColors {
    values: array<u32>,
}
@group(0) @binding(1) var<storage, read> cell_colors: CellColors;

@fragment fn main(@builtin(position) position: vec4<f32>) -> @location(0) vec4<f32> {
    let grid_size = vec2<i32>(unpack2u16(globals.grid_size_packed_2u16));
    var grid_position = vec2<i32>(floor(
        (position.xy - globals.grid_padding.wx) / globals.cell_size
    ));
    if grid_position.x < 0 {
        if (globals.padding_extend & EXTEND_LEFT) == 0u {
            return vec4<f32>(0.0);
        }
        grid_position.x = 0;
    } else if grid_position.x >= grid_size.x {
        if (globals.padding_extend & EXTEND_RIGHT) == 0u {
            return vec4<f32>(0.0);
        }
        grid_position.x = grid_size.x - 1;
    }
    if grid_position.y < 0 {
        if (globals.padding_extend & EXTEND_UP) == 0u {
            return vec4<f32>(0.0);
        }
        grid_position.y = 0;
    } else if grid_position.y >= grid_size.y {
        if (globals.padding_extend & EXTEND_DOWN) == 0u {
            return vec4<f32>(0.0);
        }
        grid_position.y = grid_size.y - 1;
    }
    let index = u32(grid_position.y * grid_size.x + grid_position.x);
    let linear = (globals.bools & USE_LINEAR_BLENDING) != 0u;
    return load_color(cell_colors.values[index], linear);
}
"#;
const GHOSTTY_CELL_TEXT_VERTEX_SHADER_SOURCE: &str = r#"
struct CellColors {
    values: array<u32>,
}
@group(0) @binding(1) var<storage, read> cell_colors: CellColors;

struct TextVertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) @interpolate(flat) atlas: u32,
    @location(1) @interpolate(flat) color: vec4<f32>,
    @location(2) @interpolate(flat) background: vec4<f32>,
    @location(3) texture_coordinate: vec2<f32>,
}

@vertex fn main(
    @builtin(vertex_index) vertex: u32,
    @location(0) glyph_position: vec2<u32>,
    @location(1) glyph_size: vec2<u32>,
    @location(2) bearings: vec2<i32>,
    @location(3) grid_position: vec2<u32>,
    @location(4) color: vec4<u32>,
    @location(5) atlas: u32,
    @location(6) glyph_bools: u32,
) -> TextVertexOutput {
    let grid_size = unpack2u16(globals.grid_size_packed_2u16);
    let cursor_position = unpack2u16(globals.cursor_pos_packed_2u16);
    let cursor_wide = (globals.bools & CURSOR_WIDE) != 0u;
    let linear_blending = (globals.bools & USE_LINEAR_BLENDING) != 0u;
    let corner = vec2<f32>(
        select(0.0, 1.0, vertex == 1u || vertex == 3u),
        select(0.0, 1.0, vertex == 2u || vertex == 3u),
    );
    let glyph_offset = vec2<f32>(
        f32(bearings.x),
        globals.cell_size.y - f32(bearings.y),
    );
    let cell_position = globals.cell_size * vec2<f32>(grid_position);
    let world_position = cell_position + vec2<f32>(glyph_size) * corner + glyph_offset;

    var output: TextVertexOutput;
    output.position = globals.projection_matrix * vec4<f32>(world_position, 0.0, 1.0);
    output.texture_coordinate =
        vec2<f32>(glyph_position) + vec2<f32>(glyph_size) * corner;
    output.atlas = atlas;
    output.color = load_color(
        color.x | (color.y << 8u) | (color.z << 16u) | (color.w << 24u),
        true,
    );
    let cell_index = grid_position.y * grid_size.x + grid_position.x;
    output.background = load_color(cell_colors.values[cell_index], true);
    let global_background = load_color(globals.bg_color_packed_4u8, true);
    output.background += global_background * (1.0 - output.background.a);

    if globals.min_contrast > 1.0 && (glyph_bools & 1u) == 0u {
        output.color = contrasted_color(
            globals.min_contrast,
            output.color,
            output.background,
        );
    }
    let cursor_cell =
        (grid_position.x == cursor_position.x ||
            (cursor_wide && grid_position.x == cursor_position.x + 1u)) &&
        grid_position.y == cursor_position.y;
    if (glyph_bools & 2u) == 0u && cursor_cell {
        output.color = load_color(
            globals.cursor_color_packed_4u8,
            linear_blending,
        );
    }
    return output;
}
"#;
const GHOSTTY_CELL_TEXT_FRAGMENT_SHADER_SOURCE: &str = r#"
@group(0) @binding(2) var grayscale_atlas: texture_2d<f32>;
@group(0) @binding(3) var color_atlas: texture_2d<f32>;

struct TextFragmentInput {
    @location(0) @interpolate(flat) atlas: u32,
    @location(1) @interpolate(flat) color: vec4<f32>,
    @location(2) @interpolate(flat) background: vec4<f32>,
    @location(3) texture_coordinate: vec2<f32>,
}

@fragment fn main(input: TextFragmentInput) -> @location(0) vec4<f32> {
    let linear_blending = (globals.bools & USE_LINEAR_BLENDING) != 0u;
    if input.atlas == 1u {
        var color = textureLoad(
            color_atlas,
            vec2<i32>(input.texture_coordinate),
            0,
        );
        if !linear_blending && color.a > 0.0 {
            color = vec4<f32>(
                unlinearize_rgb(color.rgb / color.a) * color.a,
                color.a,
            );
        }
        return color;
    }

    var foreground = input.color;
    if !linear_blending && foreground.a > 0.0 {
        foreground = vec4<f32>(
            unlinearize_rgb(foreground.rgb / foreground.a) * foreground.a,
            foreground.a,
        );
    }
    var alpha = textureLoad(
        grayscale_atlas,
        vec2<i32>(input.texture_coordinate),
        0,
    ).r;
    if (globals.bools & USE_LINEAR_CORRECTION) != 0u {
        let foreground_luminance = luminance(foreground.rgb);
        let background_luminance = luminance(input.background.rgb);
        if abs(foreground_luminance - background_luminance) > 0.001 {
            let blended_luminance = linearize_component(
                unlinearize_component(foreground_luminance) * alpha +
                unlinearize_component(background_luminance) * (1.0 - alpha),
            );
            alpha = clamp(
                (blended_luminance - background_luminance) /
                    (foreground_luminance - background_luminance),
                0.0,
                1.0,
            );
        }
    }
    return foreground * alpha;
}
"#;
const GHOSTTY_IMAGE_VERTEX_SHADER_SOURCE: &str = r#"
@group(0) @binding(1) var image: texture_2d<f32>;

struct ImageVertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) texture_coordinate: vec2<f32>,
}

@vertex fn main(
    @builtin(vertex_index) vertex: u32,
    @location(0) grid_position: vec2<f32>,
    @location(1) cell_offset: vec2<f32>,
    @location(2) source_rectangle: vec4<f32>,
    @location(3) destination_size: vec2<f32>,
) -> ImageVertexOutput {
    let corner = vec2<f32>(
        select(0.0, 1.0, vertex == 1u || vertex == 3u),
        select(0.0, 1.0, vertex == 2u || vertex == 3u),
    );
    let dimensions = vec2<f32>(textureDimensions(image));
    let image_position =
        globals.cell_size * grid_position + cell_offset + destination_size * corner;
    var output: ImageVertexOutput;
    output.position =
        globals.projection_matrix * vec4<f32>(image_position, 1.0, 1.0);
    output.texture_coordinate =
        (source_rectangle.xy + source_rectangle.zw * corner) / dimensions;
    return output;
}
"#;
const GHOSTTY_IMAGE_FRAGMENT_SHADER_SOURCE: &str = r#"
@group(0) @binding(1) var image: texture_2d<f32>;
@group(0) @binding(2) var image_sampler: sampler;

@fragment fn main(@location(0) texture_coordinate: vec2<f32>) ->
    @location(0) vec4<f32> {
    var color = textureSample(image, image_sampler, texture_coordinate);
    if (globals.bools & USE_LINEAR_BLENDING) == 0u {
        color = vec4<f32>(unlinearize_rgb(color.rgb), color.a);
    }
    return vec4<f32>(color.rgb * color.a, color.a);
}
"#;
const MESA_SOLID_VERTEX_SHADER_SOURCE: &str = r#"
struct VertexConstants {
    values: array<vec4<f32>, 1>,
}
@group(0) @binding(0) var<uniform> constants: VertexConstants;

@vertex fn main(@location(0) position: vec2<f32>) -> @builtin(position) vec4<f32> {
    let transform = constants.values[0];
    return vec4<f32>(
        position * vec2<f32>(transform.x, transform.z) +
            vec2<f32>(transform.y, transform.w),
        0.0,
        1.0,
    );
}
"#;
const MESA_RECTANGLE_VERTEX_SHADER_SOURCE: &str = r#"
struct VertexConstants {
    values: array<vec4<f32>, 1>,
}
@group(0) @binding(0) var<uniform> constants: VertexConstants;

@vertex fn main(
    @builtin(vertex_index) vertex: u32,
    @location(0) origin_raw: vec2<i32>,
    @location(1) size_raw: vec2<u32>,
) -> @builtin(position) vec4<f32> {
    let origin = vec2<f32>(origin_raw);
    let size = vec2<f32>(size_raw);
    let corner = vec2<f32>(
        f32(vertex & 1u),
        f32((vertex & 2u) >> 1u),
    );
    let position = origin + size * corner;
    let transform = constants.values[0];
    return vec4<f32>(
        position * vec2<f32>(transform.x, transform.z) +
            vec2<f32>(transform.y, transform.w),
        0.0,
        1.0,
    );
}
"#;
const MESA_SOLID_FRAGMENT_SHADER_SOURCE: &str = r#"
struct FragmentConstants {
    values: array<vec4<f32>, 1>,
}
@group(0) @binding(1) var<uniform> constants: FragmentConstants;

@fragment fn main() -> @location(0) vec4<f32> {
    return constants.values[0];
}
"#;
const FRAGMENT_SHADER_SOURCE: &str = concat!(
    "@fragment fn main() -> @location(0) vec4f {",
    "return vec4f(1.0, 0.08, 0.04, 1.0);}",
);

pub(crate) fn create_pinned_pipeline(
    device: &wgpu::Device,
) -> Result<(wgpu::PipelineLayout, wgpu::RenderPipeline), String> {
    validate_guest_shader(VERTEX_SHADER_SOURCE, naga::ShaderStage::Vertex)?;
    validate_guest_shader(FRAGMENT_SHADER_SOURCE, naga::ShaderStage::Fragment)?;

    let vertex = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some("v86 pinned guest vertex shader"),
        source: wgpu::ShaderSource::Wgsl(VERTEX_SHADER_SOURCE.into()),
    });
    let fragment = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some("v86 pinned guest fragment shader"),
        source: wgpu::ShaderSource::Wgsl(FRAGMENT_SHADER_SOURCE.into()),
    });
    let layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
        label: Some("v86 guest pipeline layout"),
        bind_group_layouts: &[],
        immediate_size: 0,
    });
    let pipeline = create_render_pipeline(
        device,
        &layout,
        &vertex,
        &fragment,
        "v86 pinned guest pipeline",
    );
    Ok((layout, pipeline))
}

fn create_render_pipeline(
    device: &wgpu::Device,
    layout: &wgpu::PipelineLayout,
    vertex: &wgpu::ShaderModule,
    fragment: &wgpu::ShaderModule,
    label: &str,
) -> wgpu::RenderPipeline {
    device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: Some(label),
        layout: Some(layout),
        vertex: wgpu::VertexState {
            module: vertex,
            entry_point: Some("main"),
            compilation_options: Default::default(),
            buffers: &[],
        },
        primitive: wgpu::PrimitiveState::default(),
        depth_stencil: None,
        multisample: wgpu::MultisampleState::default(),
        fragment: Some(wgpu::FragmentState {
            module: fragment,
            entry_point: Some("main"),
            compilation_options: Default::default(),
            targets: &[Some(wgpu::ColorTargetState {
                format: wgpu::TextureFormat::Rgba8Unorm,
                blend: None,
                write_mask: wgpu::ColorWrites::ALL,
            })],
        }),
        multiview_mask: None,
        cache: None,
    })
}
#[allow(clippy::too_many_arguments)]
fn create_guest_pipeline(
    device: &wgpu::Device,
    vertex: &wgpu::ShaderModule,
    fragment: &wgpu::ShaderModule,
    vertex_strides: &[u64],
    attributes: &[VertexAttribute3D],
    format: u32,
    blend: u32,
    topology: wgpu::PrimitiveTopology,
) -> Result<(wgpu::RenderPipeline, wgpu::BindGroupLayout), String> {
    let mut attribute_groups = vec![Vec::new(); vertex_strides.len()];
    let mut step_modes = vec![None; vertex_strides.len()];
    for attribute in attributes {
        let slot = attribute.buffer_slot as usize;
        if slot >= attribute_groups.len() {
            return Err(invalid("vertex attribute references unknown buffer"));
        }
        if step_modes[slot].is_some_and(|mode| mode != attribute.step_mode) {
            return Err(invalid(
                "vertex buffer mixes vertex and instance attributes",
            ));
        }
        step_modes[slot] = Some(attribute.step_mode);
        attribute_groups[slot].push(wgpu::VertexAttribute {
            format: attribute.format,
            offset: attribute.offset,
            shader_location: attribute.location,
        });
    }
    let vertex_buffers = vertex_strides
        .iter()
        .enumerate()
        .map(|(slot, stride)| {
            Some(wgpu::VertexBufferLayout {
                array_stride: *stride,
                step_mode: step_modes[slot].unwrap_or(wgpu::VertexStepMode::Vertex),
                attributes: &attribute_groups[slot],
            })
        })
        .collect::<Vec<_>>();
    let blend = match blend {
        BLEND_REPLACE => None,
        BLEND_PREMULTIPLIED_ALPHA => Some(wgpu::BlendState::PREMULTIPLIED_ALPHA_BLENDING),
        _ => return Err(invalid("unsupported blend mode")),
    };
    let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: Some("v86 guest workload pipeline"),
        layout: None,
        vertex: wgpu::VertexState {
            module: vertex,
            entry_point: Some("main"),
            compilation_options: Default::default(),
            buffers: &vertex_buffers,
        },
        primitive: wgpu::PrimitiveState {
            topology,
            ..Default::default()
        },
        depth_stencil: None,
        multisample: wgpu::MultisampleState::default(),
        fragment: Some(wgpu::FragmentState {
            module: fragment,
            entry_point: Some("main"),
            compilation_options: Default::default(),
            targets: &[Some(wgpu::ColorTargetState {
                format: color_target_format(format)?,
                blend,
                write_mask: wgpu::ColorWrites::ALL,
            })],
        }),
        multiview_mask: None,
        cache: None,
    });
    let bind_group_layout = pipeline.get_bind_group_layout(0);
    Ok((pipeline, bind_group_layout))
}

pub(crate) fn encode_pinned_pipeline_probe(
    device: &wgpu::Device,
    pipeline: &wgpu::RenderPipeline,
) -> wgpu::CommandBuffer {
    let texture = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("v86 pinned guest pipeline probe target"),
        size: wgpu::Extent3d {
            width: 1,
            height: 1,
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::Rgba8Unorm,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
        view_formats: &[],
    });
    let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
    let attachment = wgpu::RenderPassColorAttachment {
        view: &view,
        depth_slice: None,
        resolve_target: None,
        ops: wgpu::Operations {
            load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT),
            store: wgpu::StoreOp::Discard,
        },
    };
    let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
        label: Some("v86 pinned guest pipeline probe encoder"),
    });
    {
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("v86 pinned guest pipeline probe pass"),
            color_attachments: &[Some(attachment)],
            depth_stencil_attachment: None,
            timestamp_writes: None,
            occlusion_query_set: None,
            multiview_mask: None,
        });
        pass.set_pipeline(pipeline);
        pass.draw(0..3, 0..1);
    }
    encoder.finish()
}

fn validate_guest_shader(source: &str, expected_stage: naga::ShaderStage) -> Result<(), String> {
    let module = naga::front::wgsl::parse_str(source).map_err(|error| {
        invalid(format!(
            "WGSL parse failed: {}",
            error.emit_to_string(source)
        ))
    })?;
    validate_shader_module(&module, expected_stage, false).map(|_| ())
}

fn validate_internal_shader(source: &str, expected_stage: naga::ShaderStage) -> Result<(), String> {
    let module = naga::front::wgsl::parse_str(source)
        .map_err(|error| invalid(format!("internal WGSL parse failed: {error}")))?;
    validate_shader_module(&module, expected_stage, true).map(|_| ())
}

fn spirv_to_wgsl(source: &[u8], expected_stage: naga::ShaderStage) -> Result<String, String> {
    let module = naga::front::spv::parse_u8_slice(source, &Default::default())
        .map_err(|error| invalid(format!("SPIR-V parse failed: {error}")))?;
    let info = validate_shader_module(&module, expected_stage, true)?;
    naga::back::wgsl::write_string(&module, &info, naga::back::wgsl::WriterFlags::empty())
        .map_err(|error| invalid(format!("SPIR-V translation failed: {error}")))
}

fn validate_shader_module(
    module: &naga::Module,
    expected_stage: naga::ShaderStage,
    allow_bindings: bool,
) -> Result<naga::valid::ModuleInfo, String> {
    let info = naga::valid::Validator::new(
        naga::valid::ValidationFlags::all(),
        naga::valid::Capabilities::empty(),
    )
    .validate(module)
    .map_err(|error| invalid(format!("shader validation failed: {error}")))?;
    if module.entry_points.len() != 1
        || module.entry_points[0].name != "main"
        || module.entry_points[0].stage != expected_stage
    {
        return Err(invalid(
            "shader must define exactly one matching-stage main entry point",
        ));
    }
    for (_, variable) in module.global_variables.iter() {
        if let Some(binding) = variable.binding
            && (!allow_bindings || binding.group != 0 || binding.binding >= MAX_BINDINGS_V3 as u32)
        {
            return Err(invalid("shader binding is outside group zero limits"));
        }
    }
    Ok(info)
}

#[derive(Clone)]
enum ShaderSource3D {
    Wgsl(String),
    InternalWgsl(String),
    Spirv(Vec<u8>),
}

impl ShaderSource3D {
    fn byte_length(&self) -> usize {
        match self {
            Self::Wgsl(source) | Self::InternalWgsl(source) => source.len(),
            Self::Spirv(source) => source.len(),
        }
    }
}

#[derive(Clone, Copy)]
struct VertexAttribute3D {
    location: u32,
    offset: u64,
    format: wgpu::VertexFormat,
    buffer_slot: u32,
    step_mode: wgpu::VertexStepMode,
}

#[derive(Clone)]
enum Binding3D {
    Buffer {
        binding: u32,
        resource_id: u32,
        offset: u64,
        size: u64,
    },
    InlineBuffer {
        binding: u32,
        words: Arc<[u32]>,
    },
    Texture {
        binding: u32,
        resource_id: u32,
    },
    Sampler {
        binding: u32,
    },
}

#[derive(Clone, Copy)]
struct VertexBuffer3D {
    slot: u32,
    resource_id: u32,
    offset: u64,
    size: u64,
}

#[derive(Clone, Copy)]
struct IndexBuffer3D {
    resource_id: u32,
    offset: u64,
    size: u64,
    format: wgpu::IndexFormat,
}

#[derive(Clone, Copy)]
struct MesaVertexElement {
    offset: u64,
    instance_divisor: u32,
    buffer_slot: u32,
    format: u32,
}

#[derive(Clone)]
struct MesaShader {
    stage: u32,
    expected_length: usize,
    source: Arc<Vec<u8>>,
}

#[derive(Clone, Copy)]
struct MesaBufferBinding {
    resource_id: u32,
    offset: u64,
    size: u64,
}

#[derive(Clone, Default)]
struct MesaState {
    shaders: HashMap<u32, MesaShader>,
    bound_shaders: [Option<u32>; 2],
    surfaces: HashMap<u32, u32>,
    sampler_views: HashMap<u32, u32>,
    bound_sampler_views: [HashMap<u32, u32>; 2],
    constant_buffers: [HashMap<u32, Arc<[u32]>>; 2],
    uniform_buffers: [HashMap<u32, MesaBufferBinding>; 2],
    shader_buffers: [HashMap<u32, MesaBufferBinding>; 2],
    vertex_elements: HashMap<u32, Vec<MesaVertexElement>>,
    bound_vertex_elements: Option<u32>,
    framebuffer: Option<u32>,
    vertex_buffers: Vec<(u32, u32, u32)>,
    index_buffer: Option<(u32, u32, u32)>,
    viewport: Option<Viewport>,
    scissor: Option<Scissor>,
    clear: Option<[f64; 4]>,
}
struct MesaDraw {
    first: u32,
    count: u32,
    indexed: bool,
    instances: u32,
    index_bias: i32,
    first_instance: u32,
    topology: u32,
    vertex_shader: u32,
    fragment_shader: u32,
    target: Option<u32>,
    vertex_buffers: Vec<(u32, u32, u32)>,
    vertex_elements: Vec<MesaVertexElement>,
    sampled_textures: [HashMap<u32, u32>; 2],
    constant_buffers: [HashMap<u32, Arc<[u32]>>; 2],
    uniform_buffers: [HashMap<u32, MesaBufferBinding>; 2],
    shader_buffers: [HashMap<u32, MesaBufferBinding>; 2],
    index_buffer: Option<(u32, u32, u32)>,
    viewport: Option<Viewport>,
    scissor: Option<Scissor>,
    clear: Option<[f64; 4]>,
}

pub(crate) struct Context3D {
    pub(crate) attachments: HashSet<u32>,
    protocol_major: Option<u16>,
    shader_bytes: usize,
    shaders: HashMap<u32, Shader3D>,
    pipelines: HashMap<u32, Pipeline3D>,
    mesa: MesaState,
}

struct Shader3D {
    stage: u32,
    byte_length: usize,
    module: Option<wgpu::ShaderModule>,
}

struct Pipeline3D {
    vertex_shader: u32,
    fragment_shader: u32,
    pipeline: Option<wgpu::RenderPipeline>,
    bind_group_layout: Option<wgpu::BindGroupLayout>,
    vertex_strides: Vec<u64>,
}

impl Context3D {
    pub(crate) fn new() -> Self {
        Self {
            attachments: HashSet::new(),
            protocol_major: None,
            shader_bytes: 0,
            shaders: HashMap::new(),
            pipelines: HashMap::new(),
            mesa: MesaState::default(),
        }
    }

    pub(crate) fn object_stats(&self) -> (usize, usize, usize) {
        (self.shaders.len(), self.pipelines.len(), self.shader_bytes)
    }
}

fn update_mesa_shader(state: &mut MesaState, payload: &[u32]) -> Result<(), String> {
    if payload.len() < 6 || payload[0] == 0 || payload[1] > 1 {
        return Err(invalid("malformed Mesa virgl shader"));
    }
    let handle = payload[0];
    let stage = payload[1];
    let continuation = payload[2] & (1 << 31) != 0;
    let offset_or_length = (payload[2] & !(1 << 31)) as usize;
    let stream_output_count = payload[4] as usize;
    let stream_output_words = if stream_output_count == 0 {
        0
    } else {
        4_usize
            .checked_add(
                stream_output_count
                    .checked_mul(2)
                    .ok_or_else(|| invalid("Mesa shader stream-output overflow"))?,
            )
            .ok_or_else(|| invalid("Mesa shader stream-output overflow"))?
    };
    let source_offset = 5_usize
        .checked_add(stream_output_words)
        .filter(|offset| *offset < payload.len())
        .ok_or_else(|| invalid("truncated Mesa virgl shader"))?;
    let mut chunk = payload[source_offset..]
        .iter()
        .flat_map(|word| word.to_le_bytes())
        .collect::<Vec<_>>();

    if continuation {
        let shader = state
            .shaders
            .get_mut(&handle)
            .ok_or_else(|| invalid("unknown Mesa shader continuation"))?;
        if shader.stage != stage
            || shader.source.len() != offset_or_length
            || shader.source.len() >= shader.expected_length
        {
            return Err(invalid("out-of-order Mesa shader continuation"));
        }
        let source = Arc::make_mut(&mut shader.source);
        chunk.truncate(shader.expected_length - source.len());
        source.extend_from_slice(&chunk);
        if source.len() == shader.expected_length && source.last() != Some(&0) {
            return Err(invalid("unterminated Mesa shader"));
        }
        return Ok(());
    }

    if offset_or_length == 0
        || offset_or_length > MAX_SHADER_BYTES_PER_CONTEXT_V3
        || state.shaders.contains_key(&handle)
        || state.shaders.len() >= MAX_SHADERS
    {
        return Err(invalid("invalid Mesa shader allocation"));
    }
    if state
        .shaders
        .values()
        .try_fold(offset_or_length, |total, shader| {
            total.checked_add(shader.expected_length)
        })
        .is_none_or(|total| total > MAX_SHADER_BYTES_PER_CONTEXT_V3)
    {
        return Err(invalid("Mesa shader byte limit exceeded"));
    }
    chunk.truncate(offset_or_length);
    let expected_prefix = if stage == 0 { b"VERT\n" } else { b"FRAG\n" };
    if !chunk.starts_with(expected_prefix) {
        return Err(invalid("unsupported Mesa virgl shader"));
    }
    if chunk.len() == offset_or_length && chunk.last() != Some(&0) {
        return Err(invalid("unterminated Mesa shader"));
    }
    state.shaders.insert(
        handle,
        MesaShader {
            stage,
            expected_length: offset_or_length,
            source: Arc::new(chunk),
        },
    );
    Ok(())
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
enum MesaProgram {
    Probe,
    BackgroundColor,
    CellBackground,
    CellText,
    Image,
    SolidColor,
    RectangleColor,
}

fn mesa_declared_max(source: &str, file: &str) -> Option<u32> {
    let marker = format!("{file}[");
    source
        .lines()
        .filter_map(|line| {
            let declaration = line.trim_start().strip_prefix("DCL ")?;
            let start = declaration.find(&marker)? + marker.len();
            let end = declaration[start..].find(']')? + start;
            declaration[start..end].split("..").last()?.parse().ok()
        })
        .max()
}

fn classify_mesa_program(
    vertex: &MesaShader,
    fragment: &MesaShader,
) -> Result<MesaProgram, String> {
    if vertex.stage != 0
        || fragment.stage != 1
        || vertex.source.len() != vertex.expected_length
        || fragment.source.len() != fragment.expected_length
    {
        return Err(invalid("incomplete Mesa shader program"));
    }
    let vertex_source = std::str::from_utf8(
        vertex
            .source
            .strip_suffix(&[0])
            .ok_or_else(|| invalid("unterminated Mesa vertex shader"))?,
    )
    .map_err(|_| invalid("non-UTF-8 Mesa vertex shader"))?;
    let fragment_source = std::str::from_utf8(
        fragment
            .source
            .strip_suffix(&[0])
            .ok_or_else(|| invalid("unterminated Mesa fragment shader"))?,
    )
    .map_err(|_| invalid("non-UTF-8 Mesa fragment shader"))?;
    let vertex_inputs = mesa_declared_max(vertex_source, "IN");
    let fragment_samplers = mesa_declared_max(fragment_source, "SAMP");
    let fragment_buffers = mesa_declared_max(fragment_source, "BUFFER");
    match (vertex_inputs, fragment_samplers, fragment_buffers) {
        (None, None, None) => Ok(MesaProgram::BackgroundColor),
        (None, None, Some(_)) => Ok(MesaProgram::CellBackground),
        (Some(max), Some(1), _) if max >= 6 => Ok(MesaProgram::CellText),
        (Some(3), Some(0), None) => Ok(MesaProgram::Image),
        (Some(1), Some(0), None) => Ok(MesaProgram::Probe),
        (Some(1), None, None) => Ok(MesaProgram::RectangleColor),
        (Some(0), None, None) => Ok(MesaProgram::SolidColor),
        _ => Err(invalid(format!(
            "unsupported Mesa shader program inputs={vertex_inputs:?} samplers={fragment_samplers:?} \
             buffers={fragment_buffers:?}\nvertex:\n{}\nfragment:\n{}",
            vertex_source
                .lines()
                .take(20)
                .collect::<Vec<_>>()
                .join("\n"),
            fragment_source
                .lines()
                .take(20)
                .collect::<Vec<_>>()
                .join("\n"),
        ))),
    }
}

fn mesa_program_index(program: MesaProgram) -> u32 {
    match program {
        MesaProgram::Probe => 0,
        MesaProgram::BackgroundColor => 1,
        MesaProgram::CellBackground => 2,
        MesaProgram::CellText => 3,
        MesaProgram::Image => 4,
        MesaProgram::SolidColor => 5,
        MesaProgram::RectangleColor => 6,
    }
}

fn mesa_program_shader_ids(program: MesaProgram) -> (u32, u32) {
    let offset = mesa_program_index(program) * 2;
    (
        MESA_VERTEX_SHADER_ID - offset,
        MESA_FRAGMENT_SHADER_ID - offset,
    )
}

fn with_ghostty_common(source: &str) -> String {
    let mut shader = String::with_capacity(GHOSTTY_COMMON_SHADER_SOURCE.len() + source.len());
    shader.push_str(GHOSTTY_COMMON_SHADER_SOURCE);
    shader.push_str(source);
    shader
}

fn mesa_program_shader_sources(program: MesaProgram) -> (String, String) {
    match program {
        MesaProgram::Probe => (
            MESA_VERTEX_SHADER_SOURCE.to_owned(),
            MESA_FRAGMENT_SHADER_SOURCE.to_owned(),
        ),
        MesaProgram::BackgroundColor => (
            GHOSTTY_FULLSCREEN_VERTEX_SHADER_SOURCE.to_owned(),
            with_ghostty_common(GHOSTTY_BACKGROUND_FRAGMENT_SHADER_SOURCE),
        ),
        MesaProgram::CellBackground => (
            GHOSTTY_FULLSCREEN_VERTEX_SHADER_SOURCE.to_owned(),
            with_ghostty_common(GHOSTTY_CELL_BACKGROUND_FRAGMENT_SHADER_SOURCE),
        ),
        MesaProgram::CellText => (
            with_ghostty_common(GHOSTTY_CELL_TEXT_VERTEX_SHADER_SOURCE),
            with_ghostty_common(GHOSTTY_CELL_TEXT_FRAGMENT_SHADER_SOURCE),
        ),
        MesaProgram::Image => (
            with_ghostty_common(GHOSTTY_IMAGE_VERTEX_SHADER_SOURCE),
            with_ghostty_common(GHOSTTY_IMAGE_FRAGMENT_SHADER_SOURCE),
        ),
        MesaProgram::SolidColor => (
            MESA_SOLID_VERTEX_SHADER_SOURCE.to_owned(),
            MESA_SOLID_FRAGMENT_SHADER_SOURCE.to_owned(),
        ),
        MesaProgram::RectangleColor => (
            MESA_RECTANGLE_VERTEX_SHADER_SOURCE.to_owned(),
            MESA_SOLID_FRAGMENT_SHADER_SOURCE.to_owned(),
        ),
    }
}

fn mesa_buffer_binding(
    buffers: &[HashMap<u32, MesaBufferBinding>; 2],
    stage: usize,
    slot: u32,
    binding: u32,
) -> Result<Binding3D, String> {
    let buffer = buffers[stage].get(&slot).ok_or_else(|| {
        invalid(format!(
            "Mesa buffer is not bound stage={stage} slot={slot} available={:?}",
            buffers[stage].keys().collect::<Vec<_>>(),
        ))
    })?;
    Ok(Binding3D::Buffer {
        binding,
        resource_id: buffer.resource_id,
        offset: buffer.offset,
        size: buffer.size,
    })
}

fn mesa_inline_buffer_binding(
    buffers: &[HashMap<u32, Arc<[u32]>>; 2],
    stage: usize,
    slot: u32,
    binding: u32,
) -> Result<Binding3D, String> {
    let words = buffers[stage]
        .get(&slot)
        .ok_or_else(|| invalid("Mesa inline constant buffer is not bound"))?;
    Ok(Binding3D::InlineBuffer {
        binding,
        words: Arc::clone(words),
    })
}

fn mesa_texture_binding(draw: &MesaDraw, slot: u32, binding: u32) -> Result<Binding3D, String> {
    Ok(Binding3D::Texture {
        binding,
        resource_id: *draw.sampled_textures[1]
            .get(&slot)
            .ok_or_else(|| invalid("Mesa fragment texture is not bound"))?,
    })
}

fn mesa_program_bindings(program: MesaProgram, draw: &MesaDraw) -> Result<Vec<Binding3D>, String> {
    match program {
        MesaProgram::Probe => Ok(vec![
            mesa_texture_binding(draw, 0, 0)?,
            Binding3D::Sampler { binding: 1 },
        ]),
        MesaProgram::BackgroundColor => {
            Ok(vec![mesa_buffer_binding(&draw.uniform_buffers, 1, 1, 0)?])
        },
        MesaProgram::CellBackground => Ok(vec![
            mesa_buffer_binding(&draw.uniform_buffers, 1, 1, 0)?,
            mesa_buffer_binding(&draw.shader_buffers, 1, 1, 1)?,
        ]),
        MesaProgram::CellText => Ok(vec![
            mesa_buffer_binding(&draw.uniform_buffers, 0, 1, 0)?,
            mesa_buffer_binding(&draw.shader_buffers, 0, 1, 1)?,
            mesa_texture_binding(draw, 0, 2)?,
            mesa_texture_binding(draw, 1, 3)?,
        ]),
        MesaProgram::Image => Ok(vec![
            mesa_buffer_binding(&draw.uniform_buffers, 0, 1, 0)?,
            mesa_texture_binding(draw, 0, 1)?,
            Binding3D::Sampler { binding: 2 },
        ]),
        MesaProgram::SolidColor | MesaProgram::RectangleColor => Ok(vec![
            mesa_inline_buffer_binding(&draw.constant_buffers, 0, 0, 0)?,
            mesa_inline_buffer_binding(&draw.constant_buffers, 1, 0, 1)?,
        ]),
    }
}

enum Record {
    CreateShader {
        id: u32,
        stage: u32,
        source: Option<ShaderSource3D>,
    },
    DestroyShader(u32),
    CreatePipeline {
        id: u32,
        vertex_shader: u32,
        fragment_shader: u32,
        format: u32,
        blend: u32,
        topology: wgpu::PrimitiveTopology,
        vertex_strides: Vec<u64>,
        attributes: Vec<VertexAttribute3D>,
    },
    DestroyPipeline(u32),
    BeginRenderPass {
        resource_id: u32,
        clear: [f64; 4],
        load: bool,
    },
    SetPipeline(u32),
    SetViewport {
        x: f32,
        y: f32,
        width: f32,
        height: f32,
        min_depth: f32,
        max_depth: f32,
    },
    SetScissor {
        x: u32,
        y: u32,
        width: u32,
        height: u32,
    },
    SetVertexBuffer(VertexBuffer3D),
    SetIndexBuffer(IndexBuffer3D),
    SetBindGroup(Vec<Binding3D>),
    Draw {
        vertices: u32,
        instances: u32,
        first_vertex: u32,
        first_instance: u32,
    },
    DrawIndexed {
        indices: u32,
        instances: u32,
        first_index: u32,
        base_vertex: i32,
        first_instance: u32,
    },
    EndRenderPass,
}

struct Submit {
    major: u16,
    records: Vec<Record>,
    resources: HashSet<u32>,
}

#[derive(Clone, Copy)]
struct Viewport {
    x: f32,
    y: f32,
    width: f32,
    height: f32,
    min_depth: f32,
    max_depth: f32,
}

#[derive(Clone, Copy)]
struct Scissor {
    x: u32,
    y: u32,
    width: u32,
    height: u32,
}

#[derive(Clone, Copy)]
enum DrawCommand3D {
    NonIndexed {
        vertices: u32,
        first_vertex: u32,
    },
    Indexed {
        index_buffer: IndexBuffer3D,
        indices: u32,
        first_index: u32,
        base_vertex: i32,
    },
}

struct Draw {
    pipeline_id: u32,
    viewport: Option<Viewport>,
    scissor: Option<Scissor>,
    vertex_buffers: Vec<Option<VertexBuffer3D>>,
    bindings: Vec<Binding3D>,
    command: DrawCommand3D,
    instances: u32,
    first_instance: u32,
}

struct Pass {
    resource_id: u32,
    clear: [f64; 4],
    load: bool,
    draws: Vec<Draw>,
}

pub(crate) async fn submit(
    renderer: &mut Renderer,
    context_id: u32,
    bytes: &[u8],
    allowed_resources: &[u32],
) -> Result<(), String> {
    renderer.check_fault()?;
    let mut allowed = HashSet::with_capacity(allowed_resources.len());
    for &resource_id in allowed_resources {
        if resource_id == 0 || !allowed.insert(resource_id) {
            return Err(invalid("invalid attached resource table"));
        }
    }

    let mut context = renderer
        .contexts
        .remove(&context_id)
        .ok_or_else(|| invalid("unknown context"))?;
    let result = if bytes.starts_with(&SUBMIT_MAGIC.to_le_bytes()) {
        let submit = decode(bytes).map_err(invalid)?;
        submit_inner(renderer, &mut context, submit, &allowed).await
    } else {
        submit_mesa_triangle(renderer, &mut context, bytes, &allowed).await
    };
    renderer.contexts.insert(context_id, context);
    result
}

async fn submit_mesa_triangle(
    renderer: &mut Renderer,
    context: &mut Context3D,
    bytes: &[u8],
    allowed_resources: &HashSet<u32>,
) -> Result<(), String> {
    let original_mesa = context.mesa.clone();
    let original_protocol_major = context.protocol_major;
    let original_shader_bytes = context.shader_bytes;
    let original_shader_ids = context.shaders.keys().copied().collect::<HashSet<_>>();
    let original_pipeline_ids = context.pipelines.keys().copied().collect::<HashSet<_>>();
    let result = submit_mesa_triangle_inner(renderer, context, bytes, allowed_resources).await;
    if result.is_err() {
        context.mesa = original_mesa;
        context.protocol_major = original_protocol_major;
        context.shader_bytes = original_shader_bytes;
        context
            .shaders
            .retain(|id, _| original_shader_ids.contains(id));
        context
            .pipelines
            .retain(|id, _| original_pipeline_ids.contains(id));
    }
    result
}

async fn submit_mesa_triangle_inner(
    renderer: &mut Renderer,
    context: &mut Context3D,
    bytes: &[u8],
    allowed_resources: &HashSet<u32>,
) -> Result<(), String> {
    if bytes.is_empty() || bytes.len() & 3 != 0 || bytes.len() > MAX_SUBMIT_BYTES {
        return Err(invalid("malformed Mesa virgl submit"));
    }
    let words = bytes
        .chunks_exact(4)
        .map(|word| u32::from_le_bytes(word.try_into().unwrap()))
        .collect::<Vec<_>>();
    let mut offset = 0;
    let mut draws = Vec::new();
    let mut vertex_invocations = 0_u32;
    let mut command_count = 0;
    while offset < words.len() {
        let header = words[offset];
        let length = (header >> 16) as usize;
        let end = offset
            .checked_add(length + 1)
            .filter(|end| *end <= words.len())
            .ok_or_else(|| invalid("truncated Mesa virgl command"))?;
        let command = (header & 0xFF) as u8;
        let object = ((header >> 8) & 0xFF) as u8;
        let payload = &words[offset + 1..end];
        command_count += 1;
        if command_count > MAX_COMMANDS {
            return Err(invalid("Mesa virgl command limit exceeded"));
        }
        match (command, object) {
            (1, 4) => update_mesa_shader(&mut context.mesa, payload)?,
            (3, 4) if payload.len() == 1 => {
                context.mesa.shaders.remove(&payload[0]);
                for bound in &mut context.mesa.bound_shaders {
                    if *bound == Some(payload[0]) {
                        *bound = None;
                    }
                }
            },
            (1, 5)
                if !payload.is_empty()
                    && (payload.len() - 1) % 4 == 0
                    && (payload.len() - 1) / 4 <= MAX_VERTEX_ATTRIBUTES_V3 =>
            {
                let handle = payload[0];
                if handle == 0 {
                    return Err(invalid("invalid Mesa vertex element handle"));
                }
                let elements = payload[1..]
                    .chunks_exact(4)
                    .map(|element| MesaVertexElement {
                        offset: u64::from(element[0]),
                        instance_divisor: element[1],
                        buffer_slot: element[2],
                        format: element[3],
                    })
                    .collect::<Vec<_>>();
                if elements.iter().any(|element| {
                    element.buffer_slot >= MAX_VERTEX_BUFFERS_V3 as u32
                        || element.instance_divisor > 1
                }) {
                    return Err(invalid("unsupported Mesa vertex element"));
                }
                if !context.mesa.vertex_elements.contains_key(&handle)
                    && context.mesa.vertex_elements.len() >= MAX_PIPELINES
                {
                    return Err(invalid("Mesa vertex element limit exceeded"));
                }
                context.mesa.vertex_elements.insert(handle, elements);
            },
            (2, 5) if payload.len() == 1 => {
                context.mesa.bound_vertex_elements = if payload[0] == 0 {
                    None
                } else if context.mesa.vertex_elements.contains_key(&payload[0]) {
                    Some(payload[0])
                } else {
                    return Err(invalid("unknown Mesa vertex elements"));
                };
            },
            (3, 5) if payload.len() == 1 => {
                context.mesa.vertex_elements.remove(&payload[0]);
                if context.mesa.bound_vertex_elements == Some(payload[0]) {
                    context.mesa.bound_vertex_elements = None;
                }
            },
            (1, 8) if payload.len() == 5 => {
                if !context.mesa.surfaces.contains_key(&payload[0])
                    && context.mesa.surfaces.len() >= MAX_RESOURCES
                {
                    return Err(invalid("Mesa virgl surface limit exceeded"));
                }
                context.mesa.surfaces.insert(payload[0], payload[1]);
            },
            (1, 6) if payload.len() == 6 => {
                if !context.mesa.sampler_views.contains_key(&payload[0])
                    && context.mesa.sampler_views.len() >= MAX_RESOURCES
                {
                    return Err(invalid("Mesa virgl sampler view limit exceeded"));
                }
                context.mesa.sampler_views.insert(payload[0], payload[1]);
            },
            (3, 8) if payload.len() == 1 => {
                context.mesa.surfaces.remove(&payload[0]);
            },
            (3, 6) if payload.len() == 1 => {
                context.mesa.sampler_views.remove(&payload[0]);
            },
            (4, 0) if payload.len() == 7 && payload[0] == 0 => {
                let scale_x = f32::from_bits(payload[1]).abs();
                let scale_y = f32::from_bits(payload[2]).abs();
                let scale_z = f32::from_bits(payload[3]).abs();
                let translate_x = f32::from_bits(payload[4]);
                let translate_y = f32::from_bits(payload[5]);
                let translate_z = f32::from_bits(payload[6]);
                let viewport = Viewport {
                    x: translate_x - scale_x,
                    y: translate_y - scale_y,
                    width: scale_x * 2.0,
                    height: scale_y * 2.0,
                    min_depth: (translate_z - scale_z).clamp(0.0, 1.0),
                    max_depth: (translate_z + scale_z).clamp(0.0, 1.0),
                };
                if ![
                    viewport.x,
                    viewport.y,
                    viewport.width,
                    viewport.height,
                    viewport.min_depth,
                    viewport.max_depth,
                ]
                .iter()
                .all(|value| value.is_finite())
                    || viewport.width <= 0.0
                    || viewport.height <= 0.0
                {
                    return Err(invalid("invalid Mesa virgl viewport"));
                }
                context.mesa.viewport = Some(viewport);
            },
            (5, 0) if payload.len() == 3 && payload[0] == 1 && payload[1] == 0 => {
                context.mesa.framebuffer = context.mesa.surfaces.get(&payload[2]).copied();
            },
            (5, 0) if payload == [0, 0] => {
                context.mesa.framebuffer = None;
            },
            (6, 0) if payload.len() <= MAX_VERTEX_BUFFERS_V3 * 3 && payload.len() % 3 == 0 => {
                context.mesa.vertex_buffers = payload
                    .chunks_exact(3)
                    .map(|buffer| (buffer[2], buffer[0], buffer[1]))
                    .collect();
            },
            (7, 0) if payload.len() == 8 && payload[0] & 4 != 0 => {
                let clear = [
                    f64::from(f32::from_bits(payload[1])),
                    f64::from(f32::from_bits(payload[2])),
                    f64::from(f32::from_bits(payload[3])),
                    f64::from(f32::from_bits(payload[4])),
                ];
                if clear
                    .iter()
                    .any(|value| !value.is_finite() || *value < 0.0 || *value > 1.0)
                {
                    return Err(invalid("invalid Mesa virgl clear color"));
                }
                context.mesa.clear = Some(clear);
            },
            (8, 0)
                if payload.len() == 12
                    && payload[1] > 0
                    && matches!(payload[2], 4 | 5)
                    && payload[3] <= 1
                    && payload[4] > 0 =>
            {
                vertex_invocations = payload[1]
                    .checked_mul(payload[4])
                    .and_then(|count| vertex_invocations.checked_add(count))
                    .filter(|count| *count <= MAX_VERTEX_INVOCATIONS_V3)
                    .ok_or_else(|| invalid("Mesa virgl vertex invocation limit exceeded"))?;
                if draws.len() >= MAX_DRAWS {
                    return Err(invalid("Mesa virgl draw limit exceeded"));
                }
                let vertex_shader = context.mesa.bound_shaders[0]
                    .ok_or_else(|| invalid("Mesa virgl draw has no vertex shader"))?;
                let fragment_shader = context.mesa.bound_shaders[1]
                    .ok_or_else(|| invalid("Mesa virgl draw has no fragment shader"))?;
                for (stage, handle) in [vertex_shader, fragment_shader].into_iter().enumerate() {
                    let shader = context
                        .mesa
                        .shaders
                        .get(&handle)
                        .filter(|shader| {
                            shader.stage == stage as u32
                                && shader.source.len() == shader.expected_length
                        })
                        .ok_or_else(|| invalid("Mesa virgl draw uses an incomplete shader"))?;
                    let _ = shader;
                }
                let vertex_elements = context
                    .mesa
                    .bound_vertex_elements
                    .and_then(|handle| context.mesa.vertex_elements.get(&handle))
                    .cloned()
                    .ok_or_else(|| invalid("Mesa virgl draw has no vertex elements"))?;
                draws.push(MesaDraw {
                    first: payload[0],
                    count: payload[1],
                    indexed: payload[3] != 0,
                    instances: payload[4],
                    index_bias: payload[5] as i32,
                    first_instance: payload[6],
                    topology: payload[2],
                    vertex_shader,
                    fragment_shader,
                    target: context.mesa.framebuffer,
                    vertex_buffers: context.mesa.vertex_buffers.clone(),
                    vertex_elements,
                    sampled_textures: context.mesa.bound_sampler_views.clone(),
                    constant_buffers: context.mesa.constant_buffers.clone(),
                    uniform_buffers: context.mesa.uniform_buffers.clone(),
                    shader_buffers: context.mesa.shader_buffers.clone(),
                    index_buffer: context.mesa.index_buffer,
                    viewport: context.mesa.viewport,
                    scissor: context.mesa.scissor,
                    clear: context.mesa.clear.take(),
                });
            },
            (10, 0)
                if payload.len() >= 2
                    && payload[0] <= 1
                    && payload[1] < 4
                    && payload.len() - 2 <= 4 - payload[1] as usize =>
            {
                let stage = payload[0] as usize;
                let start_slot = payload[1];
                for (index, handle) in payload[2..].iter().copied().enumerate() {
                    let slot = start_slot + index as u32;
                    if handle == 0 {
                        context.mesa.bound_sampler_views[stage].remove(&slot);
                    } else {
                        let resource_id = context
                            .mesa
                            .sampler_views
                            .get(&handle)
                            .copied()
                            .ok_or_else(|| invalid("unknown Mesa sampler view"))?;
                        context.mesa.bound_sampler_views[stage].insert(slot, resource_id);
                    }
                }
            },
            (11, 0) if payload.len() == 3 && matches!(payload[1], 2 | 4) => {
                context.mesa.index_buffer = Some((payload[0], payload[1], payload[2]));
            },
            (11, 0) if payload == [0] => {
                context.mesa.index_buffer = None;
            },
            (12, 0)
                if payload.len() >= 2
                    && payload.len() - 2 <= MAX_INLINE_CONSTANT_WORDS
                    && payload[0] <= 1
                    && payload[1] < 8 =>
            {
                let stage = payload[0] as usize;
                let slot = payload[1];
                if payload.len() == 2 {
                    context.mesa.constant_buffers[stage].remove(&slot);
                } else {
                    context.mesa.constant_buffers[stage]
                        .insert(slot, Arc::<[u32]>::from(&payload[2..]));
                }
            },
            (12, 0) if payload.len() == 2 && payload[0] < 6 && payload[1] < 8 => {},
            (15, 0) if payload.len() == 3 && payload[0] == 0 => {
                let min_x = payload[1] & 0xFFFF;
                let min_y = payload[1] >> 16;
                let max_x = payload[2] & 0xFFFF;
                let max_y = payload[2] >> 16;
                context.mesa.scissor = Some(Scissor {
                    x: min_x,
                    y: min_y,
                    width: max_x
                        .checked_sub(min_x)
                        .ok_or_else(|| invalid("invalid Mesa virgl scissor"))?,
                    height: max_y
                        .checked_sub(min_y)
                        .ok_or_else(|| invalid("invalid Mesa virgl scissor"))?,
                });
            },
            (27, 0) if payload.len() == 5 && payload[0] <= 1 && payload[1] < 8 => {
                let stage = payload[0] as usize;
                let slot = payload[1];
                if payload[4] == 0 {
                    context.mesa.uniform_buffers[stage].remove(&slot);
                } else if payload[3] == 0 {
                    return Err(invalid("empty Mesa uniform buffer"));
                } else {
                    context.mesa.uniform_buffers[stage].insert(
                        slot,
                        MesaBufferBinding {
                            resource_id: payload[4],
                            offset: u64::from(payload[2]),
                            size: u64::from(payload[3]),
                        },
                    );
                }
            },
            (31, 0) if payload.len() == 2 && payload[1] <= 1 => {
                let stage = payload[1] as usize;
                context.mesa.bound_shaders[stage] = if payload[0] == 0 {
                    None
                } else if context
                    .mesa
                    .shaders
                    .get(&payload[0])
                    .is_some_and(|shader| shader.stage as usize == stage)
                {
                    Some(payload[0])
                } else {
                    return Err(invalid("unknown Mesa shader binding"));
                };
            },
            (31, 0) if payload.len() == 2 && payload[0] == 0 && payload[1] < 6 => {},
            (34, 0)
                if payload.len() >= 2
                    && payload[0] <= 1
                    && payload[1] < 8
                    && (payload.len() - 2) % 3 == 0
                    && (payload.len() - 2) / 3 <= 8 - payload[1] as usize =>
            {
                let stage = payload[0] as usize;
                let start_slot = payload[1];
                for (index, buffer) in payload[2..].chunks_exact(3).enumerate() {
                    let slot = start_slot + index as u32;
                    if buffer[2] == 0 {
                        context.mesa.shader_buffers[stage].remove(&slot);
                    } else if buffer[1] == 0 {
                        return Err(invalid("empty Mesa shader buffer"));
                    } else {
                        context.mesa.shader_buffers[stage].insert(
                            slot,
                            MesaBufferBinding {
                                resource_id: buffer[2],
                                offset: u64::from(buffer[0]),
                                size: u64::from(buffer[1]),
                            },
                        );
                    }
                }
            },
            (1, 1 | 2 | 3 | 7) | (2 | 3, 1 | 2 | 3 | 6 | 7 | 8) => {},
            (13 | 14 | 18 | 22 | 24 | 28 | 29 | 30, 0) => {},
            _ => {
                return Err(invalid(format!(
                    "unsupported Mesa virgl command {command}:{object}:{} payload={payload:?}",
                    payload.len()
                )));
            },
        }
        offset = end;
    }
    if draws.len() > 1 {
        return Err(invalid("multiple Mesa draws in one submit are unsupported"));
    }

    for draw in draws {
        render_mesa_draw(renderer, context, draw, allowed_resources).await?;
    }
    Ok(())
}

async fn render_mesa_draw(
    renderer: &mut Renderer,
    context: &mut Context3D,
    draw: MesaDraw,
    allowed_resources: &HashSet<u32>,
) -> Result<(), String> {
    if context
        .protocol_major
        .is_some_and(|major| major != SUBMIT_V3)
    {
        return Err(invalid("Mesa virgl submit version mismatch"));
    }
    let program = classify_mesa_program(
        context
            .mesa
            .shaders
            .get(&draw.vertex_shader)
            .ok_or_else(|| invalid("unknown Mesa vertex shader"))?,
        context
            .mesa
            .shaders
            .get(&draw.fragment_shader)
            .ok_or_else(|| invalid("unknown Mesa fragment shader"))?,
    )?;
    let target = draw
        .target
        .ok_or_else(|| invalid("Mesa virgl draw has no framebuffer"))?;
    let expected_vertex_buffers = match program {
        MesaProgram::Probe | MesaProgram::RectangleColor => 2,
        MesaProgram::BackgroundColor | MesaProgram::CellBackground => 0,
        MesaProgram::CellText | MesaProgram::Image | MesaProgram::SolidColor => 1,
    };
    if draw.vertex_buffers.len() != expected_vertex_buffers {
        return Err(invalid(format!(
            "Mesa virgl draw has an incompatible vertex layout program={program:?} \
             expected={expected_vertex_buffers} actual={}",
            draw.vertex_buffers.len(),
        )));
    }
    let mut resources = HashSet::from([target]);
    resources.extend(
        draw.vertex_buffers
            .iter()
            .map(|(resource_id, _, _)| *resource_id),
    );
    let bindings = mesa_program_bindings(program, &draw)?;
    let index_buffer = if draw.indexed {
        let (resource_id, index_size, offset) = draw
            .index_buffer
            .ok_or_else(|| invalid("indexed Mesa virgl draw has no index buffer"))?;
        let resource = renderer
            .resources
            .get(&resource_id)
            .ok_or_else(|| invalid(format!("unknown Mesa virgl index buffer {resource_id}")))?;
        let size = resource
            .byte_length
            .checked_sub(offset as usize)
            .ok_or_else(|| invalid("Mesa virgl index buffer offset is out of range"))?;
        resources.insert(resource_id);
        Some(IndexBuffer3D {
            resource_id,
            offset: u64::from(offset),
            size: size as u64,
            format: if index_size == 2 {
                wgpu::IndexFormat::Uint16
            } else {
                wgpu::IndexFormat::Uint32
            },
        })
    } else {
        None
    };
    for resource_id in draw
        .sampled_textures
        .iter()
        .flat_map(|textures| textures.values())
    {
        let resource = renderer
            .resources
            .get(resource_id)
            .ok_or_else(|| invalid("unknown Mesa sampled texture"))?;
        if resource.texture.is_none() {
            return Err(invalid("Mesa sampler view references a buffer"));
        }
        resources.insert(*resource_id);
    }
    for binding in draw
        .uniform_buffers
        .iter()
        .chain(&draw.shader_buffers)
        .flat_map(|buffers| buffers.values())
    {
        let resource = renderer
            .resources
            .get(&binding.resource_id)
            .ok_or_else(|| invalid("unknown Mesa binding buffer"))?;
        let end = binding
            .offset
            .checked_add(binding.size)
            .ok_or_else(|| invalid("Mesa binding buffer range overflow"))?;
        if resource.buffer.is_none() || end > resource.byte_length as u64 {
            return Err(invalid("invalid Mesa binding buffer range"));
        }
        resources.insert(binding.resource_id);
    }
    if !resources.is_subset(allowed_resources) || !resources.is_subset(&context.attachments) {
        return Err(invalid(
            "Mesa virgl resource is not attached to the context",
        ));
    }
    let (width, height, target_format) = {
        let target_resource = renderer
            .resources
            .get(&target)
            .ok_or_else(|| invalid("unknown Mesa virgl render target"))?;
        (
            target_resource.width,
            target_resource.height,
            target_resource.format,
        )
    };
    if !is_color_target_format(target_format) {
        return Err(invalid("unsupported Mesa virgl render target format"));
    }
    let vertex_sizes = draw
        .vertex_buffers
        .iter()
        .map(|(resource_id, _, offset)| {
            renderer
                .resources
                .get(resource_id)
                .ok_or_else(|| invalid("unknown Mesa virgl vertex buffer"))?
                .byte_length
                .checked_sub(*offset as usize)
                .map(|size| size as u64)
                .ok_or_else(|| invalid("Mesa virgl vertex buffer offset is out of range"))
        })
        .collect::<Result<Vec<_>, _>>()?;
    let format_offset = match target_format {
        FORMAT_R8G8B8A8_UNORM => 0,
        FORMAT_R8G8B8A8_SRGB => 3,
        FORMAT_B8G8R8A8_UNORM => 4,
        FORMAT_B8G8R8A8_SRGB | FORMAT_B8G8R8X8_SRGB => 5,
        FORMAT_R8_UNORM => 6,
        _ => return Err(invalid("unsupported Mesa virgl render target format")),
    };
    let pipeline_id = MESA_PIPELINE_ID - mesa_program_index(program) * 8 - format_offset;
    let topology = match draw.topology {
        4 => wgpu::PrimitiveTopology::TriangleList,
        5 if !draw.indexed => wgpu::PrimitiveTopology::TriangleStrip,
        _ => return Err(invalid("unsupported Mesa primitive topology")),
    };
    let vertex_strides = draw
        .vertex_buffers
        .iter()
        .map(|(_, stride, _)| u64::from(*stride))
        .collect::<Vec<_>>();
    let attributes = mesa_vertex_attributes(&draw.vertex_elements, &vertex_strides)?;
    if let Some(pipeline) = context.pipelines.get(&pipeline_id) {
        if pipeline.vertex_strides != vertex_strides {
            return Err(invalid("Mesa virgl vertex layout changed"));
        }
    } else {
        let mut mutations = Vec::new();
        let (vertex_shader, fragment_shader) = mesa_program_shader_ids(program);
        let (vertex_source, fragment_source) = mesa_program_shader_sources(program);
        if !context.shaders.contains_key(&vertex_shader) {
            mutations.push(Record::CreateShader {
                id: vertex_shader,
                stage: SHADER_STAGE_VERTEX,
                source: Some(ShaderSource3D::InternalWgsl(vertex_source)),
            });
        }
        if !context.shaders.contains_key(&fragment_shader) {
            mutations.push(Record::CreateShader {
                id: fragment_shader,
                stage: SHADER_STAGE_FRAGMENT,
                source: Some(ShaderSource3D::InternalWgsl(fragment_source)),
            });
        }
        mutations.push(Record::CreatePipeline {
            id: pipeline_id,
            vertex_shader,
            fragment_shader,
            format: target_format,
            topology,
            blend: if matches!(
                program,
                MesaProgram::BackgroundColor | MesaProgram::SolidColor
            ) {
                BLEND_REPLACE
            } else {
                BLEND_PREMULTIPLIED_ALPHA
            },
            vertex_strides: vertex_strides.clone(),
            attributes,
        });
        apply_mutations(renderer, context, SUBMIT_V3, mutations).await?;
    }

    let viewport = draw.viewport.unwrap_or(Viewport {
        x: 0.0,
        y: 0.0,
        width: width as f32,
        height: height as f32,
        min_depth: 0.0,
        max_depth: 1.0,
    });
    let load = draw.clear.is_none();
    let clear = draw.clear.unwrap_or([0.0; 4]);
    let mut records = vec![
        Record::BeginRenderPass {
            resource_id: target,
            clear,
            load,
        },
        Record::SetPipeline(pipeline_id),
        Record::SetViewport {
            x: viewport.x,
            y: viewport.y,
            width: viewport.width,
            height: viewport.height,
            min_depth: viewport.min_depth,
            max_depth: viewport.max_depth,
        },
    ];
    if let Some(scissor) = draw.scissor {
        records.push(Record::SetScissor {
            x: scissor.x,
            y: scissor.y,
            width: scissor.width,
            height: scissor.height,
        });
    }
    for (slot, ((resource_id, _, offset), size)) in
        draw.vertex_buffers.iter().zip(&vertex_sizes).enumerate()
    {
        records.push(Record::SetVertexBuffer(VertexBuffer3D {
            slot: slot as u32,
            resource_id: *resource_id,
            offset: u64::from(*offset),
            size: *size,
        }));
    }
    records.push(Record::SetBindGroup(bindings));
    if let Some(index_buffer) = index_buffer {
        records.push(Record::SetIndexBuffer(index_buffer));
        records.push(Record::DrawIndexed {
            indices: draw.count,
            instances: draw.instances,
            first_index: draw.first,
            base_vertex: draw.index_bias,
            first_instance: draw.first_instance,
        });
    } else {
        records.push(Record::Draw {
            vertices: draw.count,
            instances: draw.instances,
            first_vertex: draw.first,
            first_instance: draw.first_instance,
        });
    }
    records.push(Record::EndRenderPass);
    render(renderer, context, records, &resources).await
}
async fn submit_inner(
    renderer: &mut Renderer,
    context: &mut Context3D,
    submit: Submit,
    allowed_resources: &HashSet<u32>,
) -> Result<(), String> {
    let Submit {
        major,
        records,
        resources,
    } = submit;
    if context
        .protocol_major
        .is_some_and(|version| version != major)
    {
        return Err(invalid("submit version does not match the context"));
    }
    if !resources.is_subset(allowed_resources) || !resources.is_subset(&context.attachments) {
        return Err(invalid("submit resource is not attached to the context"));
    }

    let has_mutation = records.iter().any(|record| {
        matches!(
            record,
            Record::CreateShader { .. }
                | Record::DestroyShader(_)
                | Record::CreatePipeline { .. }
                | Record::DestroyPipeline(_)
        )
    });
    let has_render = records.iter().any(|record| {
        matches!(
            record,
            Record::BeginRenderPass { .. }
                | Record::SetPipeline(_)
                | Record::SetViewport { .. }
                | Record::SetScissor { .. }
                | Record::SetVertexBuffer(_)
                | Record::SetIndexBuffer(_)
                | Record::SetBindGroup(_)
                | Record::Draw { .. }
                | Record::DrawIndexed { .. }
                | Record::EndRenderPass
        )
    });
    if has_mutation && has_render {
        return Err(invalid("object and render records cannot share a submit"));
    }
    if has_mutation {
        apply_mutations(renderer, context, major, records).await
    } else if has_render {
        render(renderer, context, records, &resources).await
    } else {
        Err(invalid("empty submit"))
    }
}

async fn apply_mutations(
    renderer: &Renderer,
    context: &mut Context3D,
    major: u16,
    records: Vec<Record>,
) -> Result<(), String> {
    let has_create = records.iter().any(|record| {
        matches!(
            record,
            Record::CreateShader { .. } | Record::CreatePipeline { .. }
        )
    });
    let has_destroy = records.iter().any(|record| {
        matches!(
            record,
            Record::DestroyShader(_) | Record::DestroyPipeline(_)
        )
    });
    if has_create && has_destroy {
        return Err(invalid("create and destroy records cannot share a submit"));
    }
    if has_destroy {
        return apply_destroys(context, records);
    }

    let max_shader_bytes = match major {
        SUBMIT_V1 => MAX_SHADER_BYTES_PER_CONTEXT_V1,
        SUBMIT_V2 => MAX_SHADER_BYTES_PER_CONTEXT_V2,
        SUBMIT_V3 => MAX_SHADER_BYTES_PER_CONTEXT_V3,
        _ => unreachable!(),
    };
    let mut shader_bytes = context.shader_bytes;
    let mut shader_ids = context.shaders.keys().copied().collect::<HashSet<_>>();
    let mut pipeline_ids = context.pipelines.keys().copied().collect::<HashSet<_>>();
    let mut staged_shader_metadata = HashMap::new();
    let mut staged_shader_sources = HashMap::new();
    for record in &records {
        match record {
            Record::CreateShader { id, stage, source } => {
                if shader_ids.len() >= MAX_SHADERS || !shader_ids.insert(*id) {
                    return Err(invalid("duplicate shader or shader limit exceeded"));
                }
                let stage_kind = shader_stage(*stage)?;
                let byte_length = source
                    .as_ref()
                    .map_or_else(|| pinned_source(*stage).len(), ShaderSource3D::byte_length);
                shader_bytes = shader_bytes
                    .checked_add(byte_length)
                    .filter(|size| *size <= max_shader_bytes)
                    .ok_or_else(|| invalid("shader byte limit exceeded"))?;
                let translated = match (major, source) {
                    (SUBMIT_V1, None) => None,
                    (SUBMIT_V2 | SUBMIT_V3, Some(ShaderSource3D::Wgsl(source))) => {
                        validate_guest_shader(source, stage_kind)?;
                        Some(source.clone())
                    },
                    (SUBMIT_V3, Some(ShaderSource3D::InternalWgsl(source))) => {
                        validate_internal_shader(source, stage_kind)?;
                        Some(source.clone())
                    },
                    (SUBMIT_V3, Some(ShaderSource3D::Spirv(source))) => {
                        Some(spirv_to_wgsl(source, stage_kind)?)
                    },
                    _ => return Err(invalid("shader source does not match submit version")),
                };
                if let Some(translated) = translated {
                    staged_shader_sources.insert(*id, translated);
                }
                staged_shader_metadata.insert(*id, (*stage, byte_length));
            },
            Record::CreatePipeline {
                id,
                vertex_shader,
                fragment_shader,
                format,
                blend,
                topology,
                vertex_strides,
                attributes,
            } => {
                if pipeline_ids.len() >= MAX_PIPELINES || !pipeline_ids.insert(*id) {
                    return Err(invalid("duplicate pipeline or pipeline limit exceeded"));
                }
                if !shader_ids.contains(vertex_shader) || !shader_ids.contains(fragment_shader) {
                    return Err(invalid("pipeline references an unknown shader"));
                }
                if !is_color_target_format(*format)
                    || !matches!(*blend, BLEND_REPLACE | BLEND_PREMULTIPLIED_ALPHA)
                {
                    return Err(invalid("unsupported pipeline state"));
                }
                if major < SUBMIT_V3
                    && (*blend != BLEND_REPLACE
                        || *topology != wgpu::PrimitiveTopology::TriangleList
                        || !vertex_strides.is_empty()
                        || !attributes.is_empty())
                {
                    return Err(invalid("versioned pipeline state is not zero"));
                }
                if attributes.len() > MAX_VERTEX_ATTRIBUTES_V3
                    || vertex_strides.len() > MAX_VERTEX_BUFFERS_V3
                    || attributes.is_empty() != vertex_strides.is_empty()
                    || vertex_strides
                        .iter()
                        .any(|stride| *stride == 0 || *stride > 2048)
                {
                    return Err(invalid("invalid vertex layout"));
                }
                let mut locations = HashSet::new();
                for attribute in attributes {
                    let stride = vertex_strides
                        .get(attribute.buffer_slot as usize)
                        .ok_or_else(|| invalid("vertex buffer slot is out of range"))?;
                    let end = attribute
                        .offset
                        .checked_add(vertex_format_size(attribute.format))
                        .ok_or_else(|| invalid("vertex attribute overflow"))?;
                    if end > *stride || !locations.insert(attribute.location) {
                        return Err(invalid("invalid vertex attribute"));
                    }
                }
            },
            _ => return Err(invalid("invalid mutation record")),
        }
    }
    for record in &records {
        if let Record::CreatePipeline {
            vertex_shader,
            fragment_shader,
            ..
        } = record
        {
            let vertex_stage = staged_shader_metadata
                .get(vertex_shader)
                .map(|shader| shader.0)
                .or_else(|| {
                    context
                        .shaders
                        .get(vertex_shader)
                        .map(|shader| shader.stage)
                });
            let fragment_stage = staged_shader_metadata
                .get(fragment_shader)
                .map(|shader| shader.0)
                .or_else(|| {
                    context
                        .shaders
                        .get(fragment_shader)
                        .map(|shader| shader.stage)
                });
            if vertex_stage != Some(SHADER_STAGE_VERTEX)
                || fragment_stage != Some(SHADER_STAGE_FRAGMENT)
            {
                return Err(invalid("pipeline shader stage mismatch"));
            }
        }
    }

    let validation_scope = (major >= SUBMIT_V2).then(|| {
        renderer
            .device
            .push_error_scope(wgpu::ErrorFilter::Validation)
    });
    let mut staged_shaders = HashMap::new();
    for record in &records {
        if let Record::CreateShader { id, stage, .. } = record {
            let module = staged_shader_sources.get(id).map(|source| {
                renderer
                    .device
                    .create_shader_module(wgpu::ShaderModuleDescriptor {
                        label: Some("v86 guest shader"),
                        source: wgpu::ShaderSource::Wgsl(source.as_str().into()),
                    })
            });
            let byte_length = staged_shader_metadata.get(id).unwrap().1;
            staged_shaders.insert(
                *id,
                Shader3D {
                    stage: *stage,
                    byte_length,
                    module,
                },
            );
        }
    }
    let mut staged_pipelines = HashMap::new();
    for record in &records {
        if let Record::CreatePipeline {
            id,
            vertex_shader,
            fragment_shader,
            format,
            blend,
            topology,
            vertex_strides,
            attributes,
        } = record
        {
            let vertex = staged_shaders
                .get(vertex_shader)
                .or_else(|| context.shaders.get(vertex_shader))
                .unwrap();
            let fragment = staged_shaders
                .get(fragment_shader)
                .or_else(|| context.shaders.get(fragment_shader))
                .unwrap();
            let (pipeline, bind_group_layout) = match (&vertex.module, &fragment.module) {
                (Some(vertex), Some(fragment)) if major == SUBMIT_V2 => (
                    Some(create_render_pipeline(
                        &renderer.device,
                        &renderer.guest_pipeline_layout,
                        vertex,
                        fragment,
                        "v86 guest pipeline",
                    )),
                    None,
                ),
                (Some(vertex), Some(fragment)) if major == SUBMIT_V3 => {
                    let (pipeline, layout) = create_guest_pipeline(
                        &renderer.device,
                        vertex,
                        fragment,
                        vertex_strides,
                        attributes,
                        *format,
                        *blend,
                        *topology,
                    )?;
                    (Some(pipeline), Some(layout))
                },
                (None, None) if major == SUBMIT_V1 => (None, None),
                _ => return Err(invalid("pipeline shader object version mismatch")),
            };
            staged_pipelines.insert(
                *id,
                Pipeline3D {
                    vertex_shader: *vertex_shader,
                    fragment_shader: *fragment_shader,
                    pipeline,
                    bind_group_layout,
                    vertex_strides: vertex_strides.clone(),
                },
            );
        }
    }

    if let Some(validation_scope) = validation_scope {
        if let Some(error) = await_compilation(renderer, validation_scope).await? {
            return Err(invalid(format!(
                "shader or pipeline validation failed: {error}"
            )));
        }
        renderer.check_fault()?;
    }
    context.protocol_major = Some(major);
    context.shader_bytes = shader_bytes;
    context.shaders.extend(staged_shaders);
    context.pipelines.extend(staged_pipelines);
    Ok(())
}

async fn await_compilation(
    renderer: &Renderer,
    validation_scope: wgpu::ErrorScopeGuard,
) -> Result<Option<wgpu::Error>, String> {
    await_with_timeout(
        renderer,
        validation_scope.pop(),
        "WebGPU pipeline compilation",
        PIPELINE_COMPILATION_TIMEOUT_MS,
    )
    .await
}

pub(crate) async fn await_with_timeout<F, T>(
    renderer: &Renderer,
    future: F,
    operation: &str,
    timeout_ms: i32,
) -> Result<T, String>
where
    F: Future<Output = T>,
{
    let window = web_sys::window().ok_or_else(|| format!("{operation} requires a window"))?;
    let (timeout_sender, timeout_receiver) = oneshot::channel();
    let timeout_callback = Closure::once(move || {
        let _ = timeout_sender.send(());
    });
    let timeout_id = match window.set_timeout_with_callback_and_timeout_and_arguments_0(
        timeout_callback.as_ref().unchecked_ref(),
        timeout_ms,
    ) {
        Ok(timeout_id) => timeout_id,
        Err(_) => {
            let message = format!("Failed to schedule {operation} timeout");
            record_fault(&renderer.fault, message.clone());
            renderer.device.destroy();
            return Err(message);
        },
    };
    let future = Box::pin(future);
    let timeout = Box::pin(timeout_receiver);
    match select(future, timeout).await {
        Either::Left((result, _)) => {
            window.clear_timeout_with_handle(timeout_id);
            drop(timeout_callback);
            Ok(result)
        },
        Either::Right((_, future)) => {
            drop(future);
            drop(timeout_callback);
            let message = format!("{operation} timed out after {timeout_ms} ms");
            record_fault(&renderer.fault, message.clone());
            renderer.device.destroy();
            Err(message)
        },
    }
}

fn shader_stage(stage: u32) -> Result<naga::ShaderStage, String> {
    match stage {
        SHADER_STAGE_VERTEX => Ok(naga::ShaderStage::Vertex),
        SHADER_STAGE_FRAGMENT => Ok(naga::ShaderStage::Fragment),
        _ => Err(invalid("unsupported shader stage")),
    }
}

fn pinned_source(stage: u32) -> &'static str {
    match stage {
        SHADER_STAGE_VERTEX => VERTEX_SHADER_SOURCE,
        SHADER_STAGE_FRAGMENT => FRAGMENT_SHADER_SOURCE,
        _ => unreachable!(),
    }
}

fn apply_destroys(context: &mut Context3D, records: Vec<Record>) -> Result<(), String> {
    let mut shaders = context.shaders.keys().copied().collect::<HashSet<_>>();
    let mut pipelines = context.pipelines.keys().copied().collect::<HashSet<_>>();
    for record in &records {
        match record {
            Record::DestroyShader(id) if shaders.remove(id) => {},
            Record::DestroyPipeline(id) if pipelines.remove(id) => {},
            Record::DestroyShader(_) => return Err(invalid("unknown shader")),
            Record::DestroyPipeline(_) => return Err(invalid("unknown pipeline")),
            _ => return Err(invalid("invalid mutation record")),
        }
    }
    for (id, pipeline) in &context.pipelines {
        if pipelines.contains(id)
            && (!shaders.contains(&pipeline.vertex_shader)
                || !shaders.contains(&pipeline.fragment_shader))
        {
            return Err(invalid("shader is still referenced by a pipeline"));
        }
    }
    for record in records {
        match record {
            Record::DestroyShader(id) => {
                let shader = context.shaders.remove(&id).unwrap();
                context.shader_bytes -= shader.byte_length;
            },
            Record::DestroyPipeline(id) => {
                context.pipelines.remove(&id);
            },
            _ => unreachable!(),
        }
    }
    Ok(())
}

async fn render(
    renderer: &mut Renderer,
    context: &Context3D,
    records: Vec<Record>,
    submit_resources: &HashSet<u32>,
) -> Result<(), String> {
    let mut passes = Vec::new();
    let mut current_pass: Option<Pass> = None;
    let mut current_pipeline = None;
    let mut viewport = None;
    let mut scissor = None;
    let mut vertex_buffers = vec![None; MAX_VERTEX_BUFFERS_V3];
    let mut index_buffer = None;
    let mut bindings = Vec::new();
    let mut draw_count = 0;
    let mut vertex_invocations = 0_u32;
    for record in records {
        match record {
            Record::BeginRenderPass {
                resource_id,
                clear,
                load,
            } => {
                if current_pass.is_some() || !submit_resources.contains(&resource_id) {
                    return Err(invalid("invalid render pass resource"));
                }
                let resource = renderer
                    .resources
                    .get(&resource_id)
                    .ok_or_else(|| invalid("unknown render target"))?;
                if !resource.renderable {
                    return Err(invalid("resource is not renderable"));
                }
                current_pass = Some(Pass {
                    resource_id,
                    clear,
                    load,
                    draws: Vec::new(),
                });
                current_pipeline = None;
                viewport = None;
                scissor = None;
                vertex_buffers.fill(None);
                index_buffer = None;
                bindings.clear();
            },
            Record::SetPipeline(id) => {
                if current_pass.is_none() || !context.pipelines.contains_key(&id) {
                    return Err(invalid("unknown pipeline or no active render pass"));
                }
                current_pipeline = Some(id);
            },
            Record::SetViewport {
                x,
                y,
                width,
                height,
                min_depth,
                max_depth,
            } => {
                let pass = current_pass
                    .as_ref()
                    .ok_or_else(|| invalid("viewport outside render pass"))?;
                let resource = renderer.resources.get(&pass.resource_id).unwrap();
                if x < 0.0
                    || y < 0.0
                    || width <= 0.0
                    || height <= 0.0
                    || x + width > resource.width as f32
                    || y + height > resource.height as f32
                    || min_depth < 0.0
                    || max_depth > 1.0
                    || min_depth > max_depth
                {
                    return Err(invalid("invalid viewport"));
                }
                viewport = Some(Viewport {
                    x,
                    y,
                    width,
                    height,
                    min_depth,
                    max_depth,
                });
            },
            Record::SetScissor {
                x,
                y,
                width,
                height,
            } => {
                let pass = current_pass
                    .as_ref()
                    .ok_or_else(|| invalid("scissor outside render pass"))?;
                let resource = renderer.resources.get(&pass.resource_id).unwrap();
                let right = x
                    .checked_add(width)
                    .ok_or_else(|| invalid("scissor overflow"))?;
                let bottom = y
                    .checked_add(height)
                    .ok_or_else(|| invalid("scissor overflow"))?;
                if width == 0 || height == 0 || right > resource.width || bottom > resource.height {
                    return Err(invalid("invalid scissor"));
                }
                scissor = Some(Scissor {
                    x,
                    y,
                    width,
                    height,
                });
            },
            Record::SetVertexBuffer(binding) => {
                if current_pass.is_none()
                    || binding.slot >= MAX_VERTEX_BUFFERS_V3 as u32
                    || !submit_resources.contains(&binding.resource_id)
                    || binding.size == 0
                {
                    return Err(invalid("invalid vertex buffer state"));
                }
                let resource = renderer
                    .resources
                    .get(&binding.resource_id)
                    .ok_or_else(|| invalid("unknown vertex buffer"))?;
                let end = binding
                    .offset
                    .checked_add(binding.size)
                    .ok_or_else(|| invalid("vertex buffer range overflow"))?;
                if resource.buffer.is_none() || end > resource.byte_length as u64 {
                    return Err(invalid("invalid vertex buffer resource"));
                }
                vertex_buffers[binding.slot as usize] = Some(binding);
            },
            Record::SetIndexBuffer(binding) => {
                if current_pass.is_none()
                    || !submit_resources.contains(&binding.resource_id)
                    || binding.size == 0
                {
                    return Err(invalid("invalid index buffer state"));
                }
                let resource = renderer
                    .resources
                    .get(&binding.resource_id)
                    .ok_or_else(|| invalid("unknown index buffer"))?;
                let end = binding
                    .offset
                    .checked_add(binding.size)
                    .ok_or_else(|| invalid("index buffer range overflow"))?;
                let alignment = match binding.format {
                    wgpu::IndexFormat::Uint16 => 2,
                    wgpu::IndexFormat::Uint32 => 4,
                };
                if resource.buffer.is_none()
                    || end > resource.byte_length as u64
                    || binding.offset % alignment != 0
                    || binding.size % alignment != 0
                {
                    return Err(invalid("invalid index buffer resource"));
                }
                index_buffer = Some(binding);
            },
            Record::SetBindGroup(next_bindings) => {
                if current_pass.is_none() || next_bindings.len() > MAX_BINDINGS_V3 {
                    return Err(invalid("invalid bind group state"));
                }
                let mut binding_ids = HashSet::new();
                for binding in &next_bindings {
                    let (binding_id, resource_id) = match *binding {
                        Binding3D::Buffer {
                            binding,
                            resource_id,
                            offset,
                            size,
                        } => {
                            let resource = renderer
                                .resources
                                .get(&resource_id)
                                .ok_or_else(|| invalid("unknown binding buffer"))?;
                            let end = offset
                                .checked_add(size)
                                .ok_or_else(|| invalid("binding range overflow"))?;
                            if size == 0
                                || resource.buffer.is_none()
                                || end > resource.byte_length as u64
                            {
                                return Err(invalid("invalid binding buffer range"));
                            }
                            (binding, Some(resource_id))
                        },
                        Binding3D::InlineBuffer { binding, ref words } => {
                            if words.is_empty() || words.len() > MAX_INLINE_CONSTANT_WORDS {
                                return Err(invalid("invalid inline constant buffer"));
                            }
                            (binding, None)
                        },
                        Binding3D::Texture {
                            binding,
                            resource_id,
                        } => {
                            let resource = renderer
                                .resources
                                .get(&resource_id)
                                .ok_or_else(|| invalid("unknown binding texture"))?;
                            if resource.texture.is_none() {
                                return Err(invalid("invalid binding texture"));
                            }
                            (binding, Some(resource_id))
                        },
                        Binding3D::Sampler { binding } => (binding, None),
                    };
                    if binding_id >= MAX_BINDINGS_V3 as u32 || !binding_ids.insert(binding_id) {
                        return Err(invalid("duplicate or out-of-range binding"));
                    }
                    if resource_id.is_some_and(|id| !submit_resources.contains(&id)) {
                        return Err(invalid("binding resource is absent from submit table"));
                    }
                }
                bindings = next_bindings;
            },
            Record::Draw {
                vertices,
                instances,
                first_vertex,
                first_instance,
            } => {
                let pass = current_pass
                    .as_mut()
                    .ok_or_else(|| invalid("draw outside render pass"))?;
                let pipeline_id =
                    current_pipeline.ok_or_else(|| invalid("draw without pipeline"))?;
                let pipeline = context.pipelines.get(&pipeline_id).unwrap();
                if vertices == 0 || instances == 0 {
                    return Err(invalid("empty draw"));
                }
                let vertex_end = first_vertex
                    .checked_add(vertices)
                    .ok_or_else(|| invalid("draw vertex range overflow"))?;
                if first_instance.checked_add(instances).is_none() {
                    return Err(invalid("draw instance range overflow"));
                }
                for (slot, stride) in pipeline.vertex_strides.iter().enumerate() {
                    let vertex_buffer = vertex_buffers[slot]
                        .ok_or_else(|| invalid("draw without required vertex buffer"))?;
                    let required = u64::from(vertex_end)
                        .checked_mul(*stride)
                        .ok_or_else(|| invalid("vertex fetch range overflow"))?;
                    if required > vertex_buffer.size {
                        return Err(invalid("vertex fetch exceeds buffer"));
                    }
                }
                let (max_invocations, max_instances) = match context.protocol_major {
                    Some(SUBMIT_V2) => (MAX_VERTEX_INVOCATIONS_V2, MAX_INSTANCES_V2),
                    Some(SUBMIT_V3) => (MAX_VERTEX_INVOCATIONS_V3, MAX_INSTANCES_V3),
                    _ => (u32::MAX, u32::MAX),
                };
                let invocations = vertices
                    .checked_mul(instances)
                    .ok_or_else(|| invalid("draw work overflow"))?;
                vertex_invocations = vertex_invocations
                    .checked_add(invocations)
                    .filter(|count| *count <= max_invocations)
                    .ok_or_else(|| invalid("draw work limit exceeded"))?;
                if instances > max_instances {
                    return Err(invalid("instance limit exceeded"));
                }
                draw_count += 1;
                if draw_count > MAX_DRAWS {
                    return Err(invalid("draw limit exceeded"));
                }
                pass.draws.push(Draw {
                    pipeline_id,
                    viewport,
                    scissor,
                    vertex_buffers: vertex_buffers.clone(),
                    bindings: bindings.clone(),
                    command: DrawCommand3D::NonIndexed {
                        vertices,
                        first_vertex,
                    },
                    instances,
                    first_instance,
                });
            },
            Record::DrawIndexed {
                indices,
                instances,
                first_index,
                base_vertex,
                first_instance,
            } => {
                let pass = current_pass
                    .as_mut()
                    .ok_or_else(|| invalid("indexed draw outside render pass"))?;
                let pipeline_id =
                    current_pipeline.ok_or_else(|| invalid("indexed draw without pipeline"))?;
                let pipeline = context.pipelines.get(&pipeline_id).unwrap();
                let index_buffer =
                    index_buffer.ok_or_else(|| invalid("indexed draw without index buffer"))?;
                if indices == 0 || instances == 0 {
                    return Err(invalid("empty indexed draw"));
                }
                let index_end = first_index
                    .checked_add(indices)
                    .ok_or_else(|| invalid("draw index range overflow"))?;
                let index_size = match index_buffer.format {
                    wgpu::IndexFormat::Uint16 => 2,
                    wgpu::IndexFormat::Uint32 => 4,
                };
                let required_indices = u64::from(index_end)
                    .checked_mul(index_size)
                    .ok_or_else(|| invalid("index fetch range overflow"))?;
                if required_indices > index_buffer.size {
                    return Err(invalid("index fetch exceeds buffer"));
                }
                if first_instance.checked_add(instances).is_none() {
                    return Err(invalid("draw instance range overflow"));
                }
                for (slot, stride) in pipeline.vertex_strides.iter().enumerate() {
                    let vertex_buffer = vertex_buffers[slot]
                        .ok_or_else(|| invalid("indexed draw without required vertex buffer"))?;
                    if *stride > vertex_buffer.size {
                        return Err(invalid("vertex fetch exceeds buffer"));
                    }
                }
                let invocations = indices
                    .checked_mul(instances)
                    .ok_or_else(|| invalid("draw work overflow"))?;
                vertex_invocations = vertex_invocations
                    .checked_add(invocations)
                    .filter(|count| *count <= MAX_VERTEX_INVOCATIONS_V3)
                    .ok_or_else(|| invalid("draw work limit exceeded"))?;
                if context.protocol_major != Some(SUBMIT_V3) {
                    return Err(invalid("indexed draw requires submit version three"));
                }
                if instances > MAX_INSTANCES_V3 {
                    return Err(invalid("instance limit exceeded"));
                }
                draw_count += 1;
                if draw_count > MAX_DRAWS {
                    return Err(invalid("draw limit exceeded"));
                }
                pass.draws.push(Draw {
                    pipeline_id,
                    viewport,
                    scissor,
                    vertex_buffers: vertex_buffers.clone(),
                    bindings: bindings.clone(),
                    command: DrawCommand3D::Indexed {
                        index_buffer,
                        indices,
                        first_index,
                        base_vertex,
                    },
                    instances,
                    first_instance,
                });
            },
            Record::EndRenderPass => {
                let pass = current_pass
                    .take()
                    .ok_or_else(|| invalid("end without render pass"))?;
                if pass.draws.is_empty() {
                    return Err(invalid("render pass contains no draws"));
                }
                passes.push(pass);
            },
            _ => return Err(invalid("object record in render submit")),
        }
    }
    if current_pass.is_some() || passes.is_empty() {
        return Err(invalid("unterminated or empty render submit"));
    }
    let validation_scope = renderer
        .device
        .push_error_scope(wgpu::ErrorFilter::Validation);

    let mut encoder = renderer
        .device
        .create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("v86 guest submit encoder"),
        });
    for plan in passes {
        let prepared_bind_groups = plan
            .draws
            .iter()
            .map(|draw| {
                let pipeline = context.pipelines.get(&draw.pipeline_id).unwrap();
                create_bind_group(renderer, pipeline, &draw.bindings)
            })
            .collect::<Result<Vec<_>, _>>()?;
        let resource = renderer.resources.get(&plan.resource_id).unwrap();
        let view = resource
            .texture
            .as_ref()
            .unwrap()
            .create_view(&wgpu::TextureViewDescriptor::default());
        let color_attachment = wgpu::RenderPassColorAttachment {
            view: &view,
            depth_slice: None,
            resolve_target: None,
            ops: wgpu::Operations {
                load: if plan.load {
                    wgpu::LoadOp::Load
                } else {
                    wgpu::LoadOp::Clear(wgpu::Color {
                        r: plan.clear[0],
                        g: plan.clear[1],
                        b: plan.clear[2],
                        a: plan.clear[3],
                    })
                },
                store: wgpu::StoreOp::Store,
            },
        };
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("v86 guest render pass"),
            color_attachments: &[Some(color_attachment)],
            depth_stencil_attachment: None,
            timestamp_writes: None,
            occlusion_query_set: None,
            multiview_mask: None,
        });
        for (draw, bind_group) in plan.draws.iter().zip(&prepared_bind_groups) {
            let pipeline = context.pipelines.get(&draw.pipeline_id).unwrap();
            pass.set_pipeline(
                pipeline
                    .pipeline
                    .as_ref()
                    .unwrap_or(&renderer.guest_pipeline),
            );
            for vertex_buffer in draw.vertex_buffers.iter().flatten() {
                let resource = renderer.resources.get(&vertex_buffer.resource_id).unwrap();
                let buffer = resource.buffer.as_ref().unwrap();
                pass.set_vertex_buffer(
                    vertex_buffer.slot,
                    buffer.slice(vertex_buffer.offset..vertex_buffer.offset + vertex_buffer.size),
                );
            }
            if let Some(bind_group) = bind_group {
                pass.set_bind_group(0, bind_group, &[]);
            }
            if let Some(viewport) = draw.viewport {
                pass.set_viewport(
                    viewport.x,
                    viewport.y,
                    viewport.width,
                    viewport.height,
                    viewport.min_depth,
                    viewport.max_depth,
                );
            }
            if let Some(scissor) = draw.scissor {
                pass.set_scissor_rect(scissor.x, scissor.y, scissor.width, scissor.height);
            }
            match draw.command {
                DrawCommand3D::NonIndexed {
                    vertices,
                    first_vertex,
                } => {
                    pass.draw(
                        first_vertex..first_vertex + vertices,
                        draw.first_instance..draw.first_instance + draw.instances,
                    );
                },
                DrawCommand3D::Indexed {
                    index_buffer,
                    indices,
                    first_index,
                    base_vertex,
                } => {
                    let resource = renderer.resources.get(&index_buffer.resource_id).unwrap();
                    let buffer = resource.buffer.as_ref().unwrap();
                    pass.set_index_buffer(
                        buffer.slice(index_buffer.offset..index_buffer.offset + index_buffer.size),
                        index_buffer.format,
                    );
                    pass.draw_indexed(
                        first_index..first_index + indices,
                        base_vertex,
                        draw.first_instance..draw.first_instance + draw.instances,
                    );
                },
            }
        }
    }
    renderer.queue.submit([encoder.finish()]);
    if matches!(context.protocol_major, Some(SUBMIT_V2 | SUBMIT_V3)) {
        await_with_timeout(
            renderer,
            renderer.wait_idle(),
            "WebGPU render work",
            GPU_WORK_TIMEOUT_MS,
        )
        .await??;
    } else {
        renderer.wait_idle().await?;
    }
    if let Some(error) = await_compilation(renderer, validation_scope).await? {
        return Err(invalid(format!("render validation failed: {error}")));
    }
    renderer.check_fault()?;
    Ok(())
}

fn create_bind_group(
    renderer: &Renderer,
    pipeline: &Pipeline3D,
    bindings: &[Binding3D],
) -> Result<Option<wgpu::BindGroup>, String> {
    if bindings.is_empty() {
        return Ok(None);
    }
    let layout = pipeline
        .bind_group_layout
        .as_ref()
        .ok_or_else(|| invalid("bindings require a version-three pipeline"))?;
    let texture_views = bindings
        .iter()
        .filter_map(|binding| match *binding {
            Binding3D::Texture {
                binding,
                resource_id,
            } => Some((
                binding,
                renderer.resources[&resource_id]
                    .texture
                    .as_ref()
                    .unwrap()
                    .create_view(&wgpu::TextureViewDescriptor::default()),
            )),
            _ => None,
        })
        .collect::<HashMap<_, _>>();
    let mut inline_buffers = HashMap::new();
    for binding in bindings {
        if let Binding3D::InlineBuffer { binding, words } = binding {
            let bytes = bytemuck::cast_slice(words.as_ref());
            let size = (bytes.len() as u64 + 15) & !15;
            let buffer = renderer.device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("v86 Mesa inline constant buffer"),
                size,
                usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
                mapped_at_creation: false,
            });
            renderer.queue.write_buffer(&buffer, 0, bytes);
            inline_buffers.insert(*binding, (buffer, size));
        }
    }
    let mut entries = Vec::with_capacity(bindings.len());
    for binding in bindings {
        let (binding_id, resource) = match *binding {
            Binding3D::Buffer {
                binding,
                resource_id,
                offset,
                size,
            } => (
                binding,
                wgpu::BindingResource::Buffer(wgpu::BufferBinding {
                    buffer: renderer.resources[&resource_id].buffer.as_ref().unwrap(),
                    offset,
                    size: std::num::NonZeroU64::new(size),
                }),
            ),
            Binding3D::InlineBuffer { binding, .. } => {
                let (buffer, size) = &inline_buffers[&binding];
                (
                    binding,
                    wgpu::BindingResource::Buffer(wgpu::BufferBinding {
                        buffer,
                        offset: 0,
                        size: std::num::NonZeroU64::new(*size),
                    }),
                )
            },
            Binding3D::Texture { binding, .. } => (
                binding,
                wgpu::BindingResource::TextureView(&texture_views[&binding]),
            ),
            Binding3D::Sampler { binding } => {
                (binding, wgpu::BindingResource::Sampler(&renderer.sampler))
            },
        };
        entries.push(wgpu::BindGroupEntry {
            binding: binding_id,
            resource,
        });
    }
    Ok(Some(renderer.device.create_bind_group(
        &wgpu::BindGroupDescriptor {
            label: Some("v86 guest bind group"),
            layout,
            entries: &entries,
        },
    )))
}
fn decode(bytes: &[u8]) -> Result<Submit, String> {
    if bytes.len() < SUBMIT_HEADER_SIZE || bytes.len() > MAX_SUBMIT_BYTES {
        return Err("submit size is out of range".into());
    }
    let major = read_u16(bytes, 4)?;
    if read_u32(bytes, 0)? != SUBMIT_MAGIC
        || !matches!(major, SUBMIT_V1 | SUBMIT_V2 | SUBMIT_V3)
        || read_u16(bytes, 6)? != SUBMIT_MINOR
        || read_u32(bytes, 8)? as usize != bytes.len()
        || read_u32(bytes, 20)? != 0
        || read_u32(bytes, 24)? != 0
        || read_u32(bytes, 28)? != 0
    {
        return Err("invalid submit envelope".into());
    }
    let command_count = read_u32(bytes, 12)? as usize;
    let resource_count = read_u32(bytes, 16)? as usize;
    if command_count == 0 || command_count > MAX_COMMANDS || resource_count > MAX_RESOURCES {
        return Err("submit count limit exceeded".into());
    }

    let table_size = resource_count
        .checked_mul(4)
        .ok_or_else(|| "resource table overflow".to_owned())?;
    let table_end = SUBMIT_HEADER_SIZE
        .checked_add(table_size)
        .ok_or_else(|| "resource table overflow".to_owned())?;
    let records_offset = table_end
        .checked_add(7)
        .map(|offset| offset & !7)
        .filter(|offset| *offset <= bytes.len())
        .ok_or_else(|| "resource table is truncated".to_owned())?;
    if bytes[table_end..records_offset]
        .iter()
        .any(|byte| *byte != 0)
    {
        return Err("nonzero resource table padding".into());
    }
    let mut resource_ids = Vec::with_capacity(resource_count);
    let mut resources = HashSet::with_capacity(resource_count);
    for index in 0..resource_count {
        let resource_id = read_u32(bytes, SUBMIT_HEADER_SIZE + index * 4)?;
        if resource_id == 0 || !resources.insert(resource_id) {
            return Err("invalid resource table".into());
        }
        resource_ids.push(resource_id);
    }

    let mut records = Vec::with_capacity(command_count);
    let mut used_resources = HashSet::new();
    let mut offset = records_offset;
    for _ in 0..command_count {
        let opcode = read_u16(bytes, offset)?;
        let dwords = read_u16(bytes, offset + 2)? as usize;
        let flags = read_u32(bytes, offset + 4)?;
        if dwords < 2 || dwords & 1 != 0 || flags != 0 {
            return Err("invalid record header".into());
        }
        let record_size = dwords
            .checked_mul(4)
            .ok_or_else(|| "record size overflow".to_owned())?;
        let end = offset
            .checked_add(record_size)
            .filter(|end| *end <= bytes.len())
            .ok_or_else(|| "truncated record".to_owned())?;
        let record = decode_record(major, opcode, &bytes[offset..end], &resource_ids)?;
        match &record {
            Record::BeginRenderPass { resource_id, .. }
            | Record::SetVertexBuffer(VertexBuffer3D { resource_id, .. })
            | Record::SetIndexBuffer(IndexBuffer3D { resource_id, .. }) => {
                used_resources.insert(*resource_id);
            },
            Record::SetBindGroup(bindings) => {
                for binding in bindings {
                    match binding {
                        Binding3D::Buffer { resource_id, .. }
                        | Binding3D::Texture { resource_id, .. } => {
                            used_resources.insert(*resource_id);
                        },
                        Binding3D::Sampler { .. } | Binding3D::InlineBuffer { .. } => {},
                    }
                }
            },
            _ => {},
        }
        records.push(record);
        offset = end;
    }
    if offset != bytes.len() {
        return Err("submit has trailing data".into());
    }
    if used_resources != resources {
        return Err("every resource table entry must be used".into());
    }
    Ok(Submit {
        major,
        records,
        resources,
    })
}
fn decode_record(
    major: u16,
    opcode: u16,
    bytes: &[u8],
    resources: &[u32],
) -> Result<Record, String> {
    let exact = |size| {
        if bytes.len() == size { Ok(()) } else { Err("record has invalid size".to_owned()) }
    };
    match opcode {
        OP_CREATE_SHADER => {
            if bytes.len() < 24 {
                return Err("shader record is truncated".into());
            }
            let id = read_u32(bytes, 8)?;
            let stage = read_u32(bytes, 12)?;
            let ir_kind = read_u32(bytes, 16)?;
            let source_length = read_u32(bytes, 20)? as usize;
            let max_shader_bytes = match major {
                SUBMIT_V1 => MAX_SHADER_BYTES_V1,
                SUBMIT_V2 => MAX_SHADER_BYTES_V2,
                SUBMIT_V3 => MAX_SHADER_BYTES_PER_CONTEXT_V3,
                _ => unreachable!(),
            };
            let expected_ir = if major == SUBMIT_V3 { SHADER_IR_SPIRV } else { SHADER_IR_WGSL };
            if id == 0
                || !matches!(stage, SHADER_STAGE_VERTEX | SHADER_STAGE_FRAGMENT)
                || ir_kind != expected_ir
                || source_length == 0
                || source_length > max_shader_bytes
                || (major == SUBMIT_V3 && source_length & 3 != 0)
            {
                return Err("invalid shader descriptor".into());
            }
            let padded_length = source_length
                .checked_add(7)
                .ok_or_else(|| "shader length overflow".to_owned())?
                & !7;
            if bytes.len() != 24 + padded_length {
                return Err("invalid shader record size".into());
            }
            let source_bytes = &bytes[24..24 + source_length];
            if bytes[24 + source_length..].iter().any(|byte| *byte != 0) {
                return Err("nonzero shader padding".into());
            }
            let source = match major {
                SUBMIT_V1 => {
                    if source_bytes != pinned_source(stage).as_bytes() {
                        return Err("unsupported shader source".into());
                    }
                    None
                },
                SUBMIT_V2 => Some(ShaderSource3D::Wgsl(
                    std::str::from_utf8(source_bytes)
                        .map_err(|_| "shader source is not UTF-8".to_owned())?
                        .to_owned(),
                )),
                SUBMIT_V3 => Some(ShaderSource3D::Spirv(source_bytes.to_vec())),
                _ => unreachable!(),
            };
            Ok(Record::CreateShader { id, stage, source })
        },
        OP_DESTROY_SHADER => {
            exact(16)?;
            let id = read_u32(bytes, 8)?;
            if id == 0 || read_u32(bytes, 12)? != 0 {
                return Err("invalid shader id".into());
            }
            Ok(Record::DestroyShader(id))
        },
        OP_CREATE_PIPELINE => {
            if major < SUBMIT_V3 {
                exact(40)?;
            } else if bytes.len() < 48 {
                return Err("pipeline record has invalid size".into());
            }
            let id = read_u32(bytes, 8)?;
            let vertex_shader = read_u32(bytes, 12)?;
            let fragment_shader = read_u32(bytes, 16)?;
            let topology = read_u32(bytes, 20)?;
            let format = read_u32(bytes, 24)?;
            let sample_count = read_u32(bytes, 28)?;
            if id == 0
                || vertex_shader == 0
                || fragment_shader == 0
                || topology != TOPOLOGY_TRIANGLE_LIST
                || sample_count != 1
            {
                return Err("invalid pipeline descriptor".into());
            }
            let (blend, vertex_strides, attributes) = if major < SUBMIT_V3 {
                if read_u32(bytes, 32)? != 0 || read_u32(bytes, 36)? != 0 {
                    return Err("invalid pipeline descriptor".into());
                }
                (BLEND_REPLACE, Vec::new(), Vec::new())
            } else {
                let blend = read_u32(bytes, 32)?;
                let buffer_count = read_u32(bytes, 36)? as usize;
                let attribute_count = read_u32(bytes, 40)? as usize;
                let stride_bytes = buffer_count
                    .checked_mul(8)
                    .ok_or_else(|| "vertex buffer table overflow".to_owned())?;
                let attribute_bytes = attribute_count
                    .checked_mul(16)
                    .ok_or_else(|| "vertex attribute table overflow".to_owned())?;
                if buffer_count > MAX_VERTEX_BUFFERS_V3
                    || attribute_count > MAX_VERTEX_ATTRIBUTES_V3
                    || bytes.len() != 48 + stride_bytes + attribute_bytes
                    || read_u32(bytes, 44)? != 0
                {
                    return Err("invalid pipeline vertex layout".into());
                }
                let mut vertex_strides = Vec::with_capacity(buffer_count);
                for index in 0..buffer_count {
                    let offset = 48 + index * 8;
                    vertex_strides.push(u64::from(read_u32(bytes, offset)?));
                    if read_u32(bytes, offset + 4)? != 0 {
                        return Err("nonzero vertex buffer padding".into());
                    }
                }
                let mut attributes = Vec::with_capacity(attribute_count);
                let attributes_offset = 48 + stride_bytes;
                for index in 0..attribute_count {
                    let offset = attributes_offset + index * 16;
                    attributes.push(VertexAttribute3D {
                        location: read_u32(bytes, offset)?,
                        offset: u64::from(read_u32(bytes, offset + 4)?),
                        format: vertex_format(read_u32(bytes, offset + 8)?)?,
                        buffer_slot: read_u32(bytes, offset + 12)?,
                        step_mode: wgpu::VertexStepMode::Vertex,
                    });
                }
                (blend, vertex_strides, attributes)
            };
            Ok(Record::CreatePipeline {
                id,
                vertex_shader,
                fragment_shader,
                format,
                blend,
                topology: wgpu::PrimitiveTopology::TriangleList,
                vertex_strides,
                attributes,
            })
        },
        OP_DESTROY_PIPELINE => {
            exact(16)?;
            let id = read_u32(bytes, 8)?;
            if id == 0 || read_u32(bytes, 12)? != 0 {
                return Err("invalid pipeline id".into());
            }
            Ok(Record::DestroyPipeline(id))
        },
        OP_BEGIN_RENDER_PASS => {
            exact(40)?;
            let resource_index = read_u32(bytes, 8)? as usize;
            let resource_id = *resources
                .get(resource_index)
                .ok_or_else(|| "render target index is out of range".to_owned())?;
            let clear = [
                f64::from(read_f32(bytes, 20)?),
                f64::from(read_f32(bytes, 24)?),
                f64::from(read_f32(bytes, 28)?),
                f64::from(read_f32(bytes, 32)?),
            ];
            if read_u32(bytes, 12)? != LOAD_OP_CLEAR
                || read_u32(bytes, 16)? != STORE_OP_STORE
                || clear
                    .iter()
                    .any(|value| !value.is_finite() || *value < 0.0 || *value > 1.0)
                || read_u32(bytes, 36)? != 0
            {
                return Err("invalid render pass descriptor".into());
            }
            Ok(Record::BeginRenderPass {
                resource_id,
                clear,
                load: false,
            })
        },
        OP_SET_PIPELINE => {
            exact(16)?;
            let id = read_u32(bytes, 8)?;
            if id == 0 || read_u32(bytes, 12)? != 0 {
                return Err("invalid pipeline id".into());
            }
            Ok(Record::SetPipeline(id))
        },
        OP_SET_VIEWPORT => {
            exact(32)?;
            let values = [
                read_f32(bytes, 8)?,
                read_f32(bytes, 12)?,
                read_f32(bytes, 16)?,
                read_f32(bytes, 20)?,
                read_f32(bytes, 24)?,
                read_f32(bytes, 28)?,
            ];
            if values.iter().any(|value| !value.is_finite()) {
                return Err("non-finite viewport".into());
            }
            Ok(Record::SetViewport {
                x: values[0],
                y: values[1],
                width: values[2],
                height: values[3],
                min_depth: values[4],
                max_depth: values[5],
            })
        },
        OP_SET_SCISSOR => {
            exact(24)?;
            Ok(Record::SetScissor {
                x: read_u32(bytes, 8)?,
                y: read_u32(bytes, 12)?,
                width: read_u32(bytes, 16)?,
                height: read_u32(bytes, 20)?,
            })
        },
        OP_DRAW => {
            exact(24)?;
            Ok(Record::Draw {
                vertices: read_u32(bytes, 8)?,
                instances: read_u32(bytes, 12)?,
                first_vertex: read_u32(bytes, 16)?,
                first_instance: read_u32(bytes, 20)?,
            })
        },
        OP_SET_VERTEX_BUFFER => {
            if major != SUBMIT_V3 {
                return Err("vertex buffers require submit version three".into());
            }
            exact(32)?;
            let resource_id = *resources
                .get(read_u32(bytes, 8)? as usize)
                .ok_or_else(|| "vertex buffer index is out of range".to_owned())?;
            let offset = read_u64(bytes, 12)?;
            let size = read_u64(bytes, 20)?;
            let slot = read_u32(bytes, 28)?;
            Ok(Record::SetVertexBuffer(VertexBuffer3D {
                slot,
                resource_id,
                offset,
                size,
            }))
        },
        OP_SET_BIND_GROUP => {
            if major != SUBMIT_V3 || bytes.len() < 16 {
                return Err("bind groups require submit version three".into());
            }
            let count = read_u32(bytes, 8)? as usize;
            if count > MAX_BINDINGS_V3
                || bytes.len() != 16 + count * 32
                || read_u32(bytes, 12)? != 0
            {
                return Err("invalid bind group record".into());
            }
            let mut bindings = Vec::with_capacity(count);
            for index in 0..count {
                let offset = 16 + index * 32;
                let binding = read_u32(bytes, offset)?;
                let kind = read_u32(bytes, offset + 4)?;
                let resource_index = read_u32(bytes, offset + 8)?;
                let reserved = read_u32(bytes, offset + 12)?;
                let byte_offset = read_u64(bytes, offset + 16)?;
                let size = read_u64(bytes, offset + 24)?;
                if reserved != 0 {
                    return Err("nonzero bind group padding".into());
                }
                let value = match kind {
                    1 => Binding3D::Buffer {
                        binding,
                        resource_id: *resources
                            .get(resource_index as usize)
                            .ok_or_else(|| "binding buffer index is out of range".to_owned())?,
                        offset: byte_offset,
                        size,
                    },
                    2 if byte_offset == 0 && size == 0 => Binding3D::Texture {
                        binding,
                        resource_id: *resources
                            .get(resource_index as usize)
                            .ok_or_else(|| "binding texture index is out of range".to_owned())?,
                    },
                    3 if resource_index == u32::MAX && byte_offset == 0 && size == 0 => {
                        Binding3D::Sampler { binding }
                    },
                    _ => return Err("invalid binding descriptor".into()),
                };
                bindings.push(value);
            }
            Ok(Record::SetBindGroup(bindings))
        },
        OP_SET_INDEX_BUFFER => {
            if major != SUBMIT_V3 {
                return Err("index buffers require submit version three".into());
            }
            exact(32)?;
            let resource_id = *resources
                .get(read_u32(bytes, 8)? as usize)
                .ok_or_else(|| "index buffer index is out of range".to_owned())?;
            let offset = read_u64(bytes, 12)?;
            let size = read_u64(bytes, 20)?;
            let format = match read_u32(bytes, 28)? {
                INDEX_FORMAT_UINT16 => wgpu::IndexFormat::Uint16,
                INDEX_FORMAT_UINT32 => wgpu::IndexFormat::Uint32,
                _ => return Err("unsupported index format".into()),
            };
            Ok(Record::SetIndexBuffer(IndexBuffer3D {
                resource_id,
                offset,
                size,
                format,
            }))
        },
        OP_DRAW_INDEXED => {
            if major != SUBMIT_V3 {
                return Err("indexed draws require submit version three".into());
            }
            exact(32)?;
            if read_u32(bytes, 28)? != 0 {
                return Err("nonzero indexed draw padding".into());
            }
            Ok(Record::DrawIndexed {
                indices: read_u32(bytes, 8)?,
                instances: read_u32(bytes, 12)?,
                first_index: read_u32(bytes, 16)?,
                base_vertex: read_u32(bytes, 20)? as i32,
                first_instance: read_u32(bytes, 24)?,
            })
        },
        OP_END_RENDER_PASS => {
            exact(8)?;
            Ok(Record::EndRenderPass)
        },
        _ => Err("unknown opcode".into()),
    }
}

fn read_u16(bytes: &[u8], offset: usize) -> Result<u16, String> {
    let value = bytes
        .get(offset..offset + 2)
        .ok_or_else(|| "truncated u16".to_owned())?;
    Ok(u16::from_le_bytes(value.try_into().unwrap()))
}

fn read_u32(bytes: &[u8], offset: usize) -> Result<u32, String> {
    let value = bytes
        .get(offset..offset + 4)
        .ok_or_else(|| "truncated u32".to_owned())?;
    Ok(u32::from_le_bytes(value.try_into().unwrap()))
}

fn read_f32(bytes: &[u8], offset: usize) -> Result<f32, String> {
    Ok(f32::from_bits(read_u32(bytes, offset)?))
}
fn read_u64(bytes: &[u8], offset: usize) -> Result<u64, String> {
    let low = u64::from(read_u32(bytes, offset)?);
    let high = u64::from(read_u32(bytes, offset + 4)?);
    Ok(low | high << 32)
}

fn vertex_format(value: u32) -> Result<wgpu::VertexFormat, String> {
    match value {
        VERTEX_FORMAT_FLOAT32 => Ok(wgpu::VertexFormat::Float32),
        VERTEX_FORMAT_FLOAT32X2 => Ok(wgpu::VertexFormat::Float32x2),
        VERTEX_FORMAT_FLOAT32X3 => Ok(wgpu::VertexFormat::Float32x3),
        VERTEX_FORMAT_FLOAT32X4 => Ok(wgpu::VertexFormat::Float32x4),
        VERTEX_FORMAT_UNORM8X4 => Ok(wgpu::VertexFormat::Unorm8x4),
        _ => Err("unsupported vertex format".into()),
    }
}

fn vertex_format_size(format: wgpu::VertexFormat) -> u64 {
    match format {
        wgpu::VertexFormat::Float32 => 4,
        wgpu::VertexFormat::Float32x2 => 8,
        wgpu::VertexFormat::Float32x3 => 12,
        wgpu::VertexFormat::Float32x4 => 16,
        wgpu::VertexFormat::Unorm8x4 => 4,
        _ => unreachable!(),
    }
}

fn invalid(message: impl ToString) -> String {
    format!("invalid: {}", message.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use wasm_bindgen_test::wasm_bindgen_test;

    fn header(command_count: u32, resource_count: u32, total_size: u32) -> Vec<u8> {
        header_version(SUBMIT_V1, command_count, resource_count, total_size)
    }

    fn header_version(
        major: u16,
        command_count: u32,
        resource_count: u32,
        total_size: u32,
    ) -> Vec<u8> {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&SUBMIT_MAGIC.to_le_bytes());
        bytes.extend_from_slice(&major.to_le_bytes());
        bytes.extend_from_slice(&SUBMIT_MINOR.to_le_bytes());
        bytes.extend_from_slice(&total_size.to_le_bytes());
        bytes.extend_from_slice(&command_count.to_le_bytes());
        bytes.extend_from_slice(&resource_count.to_le_bytes());
        bytes.extend_from_slice(&0_u32.to_le_bytes());
        bytes.extend_from_slice(&0_u32.to_le_bytes());
        bytes.extend_from_slice(&0_u32.to_le_bytes());
        bytes
    }

    fn record(bytes: &mut Vec<u8>, opcode: u16, payload: &[u32]) {
        let dwords = 2 + payload.len();
        assert_eq!(dwords & 1, 0);
        bytes.extend_from_slice(&opcode.to_le_bytes());
        bytes.extend_from_slice(&(dwords as u16).to_le_bytes());
        bytes.extend_from_slice(&0_u32.to_le_bytes());
        for value in payload {
            bytes.extend_from_slice(&value.to_le_bytes());
        }
    }

    fn shader_submit(stage: u32, source: &str) -> Vec<u8> {
        shader_submit_version(SUBMIT_V1, stage, source.as_bytes())
    }

    fn shader_submit_version(major: u16, stage: u32, source: &[u8]) -> Vec<u8> {
        let padded_length = (source.len() + 7) & !7;
        let record_size = 24 + padded_length;
        let mut bytes = header_version(major, 1, 0, (SUBMIT_HEADER_SIZE + record_size) as u32);
        bytes.extend_from_slice(&OP_CREATE_SHADER.to_le_bytes());
        bytes.extend_from_slice(&((record_size / 4) as u16).to_le_bytes());
        bytes.extend_from_slice(&0_u32.to_le_bytes());
        bytes.extend_from_slice(&1_u32.to_le_bytes());
        bytes.extend_from_slice(&stage.to_le_bytes());
        bytes.extend_from_slice(
            &(if major == SUBMIT_V3 { SHADER_IR_SPIRV } else { SHADER_IR_WGSL }).to_le_bytes(),
        );
        bytes.extend_from_slice(&(source.len() as u32).to_le_bytes());
        bytes.extend_from_slice(source);
        bytes.resize(SUBMIT_HEADER_SIZE + record_size, 0);
        bytes
    }

    #[wasm_bindgen_test]
    fn version_one_accepts_only_the_pinned_shader_sources() {
        assert!(decode(&shader_submit(SHADER_STAGE_VERTEX, VERTEX_SHADER_SOURCE)).is_ok());
        assert!(
            decode(&shader_submit(
                SHADER_STAGE_FRAGMENT,
                FRAGMENT_SHADER_SOURCE
            ))
            .is_ok()
        );

        let mut changed = shader_submit(SHADER_STAGE_VERTEX, VERTEX_SHADER_SOURCE);
        changed[SUBMIT_HEADER_SIZE + 24] ^= 1;
        assert!(decode(&changed).is_err());
    }

    #[wasm_bindgen_test]
    fn version_two_accepts_bounded_utf8_shader_sources() {
        const SOURCE: &str = "@vertex fn main() -> @builtin(position) vec4f { return vec4f(0.0); }";
        let submit = decode(&shader_submit_version(
            SUBMIT_V2,
            SHADER_STAGE_VERTEX,
            SOURCE.as_bytes(),
        ))
        .unwrap();
        assert_eq!(submit.major, SUBMIT_V2);
        assert!(matches!(
            &submit.records[0],
            Record::CreateShader {
                source: Some(ShaderSource3D::Wgsl(source)),
                ..
            } if source == SOURCE
        ));
        assert!(
            decode(&shader_submit_version(
                SUBMIT_V2,
                SHADER_STAGE_VERTEX,
                &[0xFF],
            ))
            .is_err()
        );
        assert!(
            decode(&shader_submit_version(
                SUBMIT_V2,
                SHADER_STAGE_VERTEX,
                &vec![b'x'; MAX_SHADER_BYTES_V2 + 1],
            ))
            .is_err()
        );
    }
    #[wasm_bindgen_test]
    fn mesa_color_pipeline_formats_are_supported() {
        assert!(is_color_target_format(FORMAT_R8_UNORM));
        assert!(is_color_target_format(FORMAT_R8G8B8A8_UNORM));
        assert!(is_color_target_format(FORMAT_B8G8R8A8_UNORM));
        assert!(is_color_target_format(FORMAT_R8G8B8A8_SRGB));
        assert!(is_color_target_format(FORMAT_B8G8R8A8_SRGB));
        assert!(is_color_target_format(FORMAT_B8G8R8X8_SRGB));
        assert_eq!(
            color_target_format(FORMAT_R8_UNORM).unwrap(),
            wgpu::TextureFormat::R8Unorm
        );
        assert_eq!(
            color_target_format(FORMAT_R8G8B8A8_UNORM).unwrap(),
            wgpu::TextureFormat::Rgba8Unorm
        );
        assert_eq!(
            color_target_format(FORMAT_R8G8B8A8_SRGB).unwrap(),
            wgpu::TextureFormat::Rgba8UnormSrgb
        );
        assert!(!is_color_target_format(0));
        assert!(color_target_format(0).is_err());
    }

    #[wasm_bindgen_test]
    fn mesa_rectangle_scaled_vertex_formats_are_supported() {
        assert_eq!(
            mesa_vertex_format(VIRGL_FORMAT_R16G16_USCALED).unwrap(),
            wgpu::VertexFormat::Uint16x2
        );
        assert_eq!(
            mesa_vertex_format(VIRGL_FORMAT_R16G16_SSCALED).unwrap(),
            wgpu::VertexFormat::Sint16x2
        );
        validate_internal_shader(
            MESA_RECTANGLE_VERTEX_SHADER_SOURCE,
            naga::ShaderStage::Vertex,
        )
        .unwrap();
    }

    #[wasm_bindgen_test]
    fn version_three_accepts_aligned_spirv_payloads() {
        const SPIRV_MAGIC: &[u8] = &[0x03, 0x02, 0x23, 0x07];
        let submit = decode(&shader_submit_version(
            SUBMIT_V3,
            SHADER_STAGE_VERTEX,
            SPIRV_MAGIC,
        ))
        .unwrap();
        assert!(matches!(
            &submit.records[0],
            Record::CreateShader {
                source: Some(ShaderSource3D::Spirv(source)),
                ..
            } if source == SPIRV_MAGIC
        ));
        assert!(
            decode(&shader_submit_version(
                SUBMIT_V3,
                SHADER_STAGE_VERTEX,
                &[0x03, 0x02, 0x23],
            ))
            .is_err()
        );
    }

    #[wasm_bindgen_test]
    fn version_three_decodes_vertex_and_index_buffer_state() {
        let mut pipeline = Vec::new();
        record(
            &mut pipeline,
            OP_CREATE_PIPELINE,
            &[
                3,
                1,
                2,
                TOPOLOGY_TRIANGLE_LIST,
                FORMAT_R8G8B8A8_UNORM,
                1,
                BLEND_PREMULTIPLIED_ALPHA,
                2,
                2,
                0,
                8,
                0,
                8,
                0,
                0,
                0,
                VERTEX_FORMAT_FLOAT32X2,
                0,
                1,
                0,
                VERTEX_FORMAT_FLOAT32X2,
                1,
            ],
        );
        let decoded = decode_record(SUBMIT_V3, OP_CREATE_PIPELINE, &pipeline, &[]).unwrap();
        let Record::CreatePipeline {
            vertex_strides,
            attributes,
            ..
        } = decoded
        else {
            panic!("expected pipeline record");
        };
        assert_eq!(vertex_strides, vec![8, 8]);
        assert_eq!(attributes.len(), 2);
        assert_eq!(attributes[0].buffer_slot, 0);
        assert_eq!(attributes[1].buffer_slot, 1);

        let mut vertex_buffer = Vec::new();
        record(
            &mut vertex_buffer,
            OP_SET_VERTEX_BUFFER,
            &[0, 0, 0, 24, 0, 1],
        );
        let decoded =
            decode_record(SUBMIT_V3, OP_SET_VERTEX_BUFFER, &vertex_buffer, &[41]).unwrap();
        assert!(matches!(
            decoded,
            Record::SetVertexBuffer(VertexBuffer3D {
                slot: 1,
                resource_id: 41,
                offset: 0,
                size: 24,
            })
        ));

        let mut index_buffer = Vec::new();
        record(
            &mut index_buffer,
            OP_SET_INDEX_BUFFER,
            &[0, 0, 0, 12, 0, INDEX_FORMAT_UINT32],
        );
        let decoded = decode_record(SUBMIT_V3, OP_SET_INDEX_BUFFER, &index_buffer, &[42]).unwrap();
        assert!(matches!(
            decoded,
            Record::SetIndexBuffer(IndexBuffer3D {
                resource_id: 42,
                offset: 0,
                size: 12,
                format: wgpu::IndexFormat::Uint32,
            })
        ));

        let mut draw = Vec::new();
        record(&mut draw, OP_DRAW_INDEXED, &[3, 1, 0, 0, 0, 0]);
        let decoded = decode_record(SUBMIT_V3, OP_DRAW_INDEXED, &draw, &[]).unwrap();
        assert!(matches!(
            decoded,
            Record::DrawIndexed {
                indices: 3,
                instances: 1,
                first_index: 0,
                base_vertex: 0,
                first_instance: 0,
            }
        ));
    }

    #[wasm_bindgen_test]
    fn immutable_object_handles_preserve_pipeline_ownership() {
        let mut context = Context3D::new();
        context.protocol_major = Some(SUBMIT_V1);
        context.shader_bytes = VERTEX_SHADER_SOURCE.len() + FRAGMENT_SHADER_SOURCE.len();
        context.shaders.insert(
            1,
            Shader3D {
                stage: SHADER_STAGE_VERTEX,
                byte_length: VERTEX_SHADER_SOURCE.len(),
                module: None,
            },
        );
        context.shaders.insert(
            2,
            Shader3D {
                stage: SHADER_STAGE_FRAGMENT,
                byte_length: FRAGMENT_SHADER_SOURCE.len(),
                module: None,
            },
        );
        context.pipelines.insert(
            3,
            Pipeline3D {
                vertex_shader: 1,
                fragment_shader: 2,
                pipeline: None,
                bind_group_layout: None,
                vertex_strides: Vec::new(),
            },
        );
        assert!(apply_destroys(&mut context, vec![Record::DestroyShader(1)]).is_err());
        apply_destroys(
            &mut context,
            vec![
                Record::DestroyPipeline(3),
                Record::DestroyShader(1),
                Record::DestroyShader(2),
            ],
        )
        .unwrap();
        assert!(context.shaders.is_empty());
        assert!(context.pipelines.is_empty());
        assert_eq!(context.shader_bytes, 0);
    }

    #[wasm_bindgen_test]
    fn guest_shaders_pass_synchronous_naga_validation() {
        validate_guest_shader(VERTEX_SHADER_SOURCE, naga::ShaderStage::Vertex).unwrap();
        validate_guest_shader(FRAGMENT_SHADER_SOURCE, naga::ShaderStage::Fragment).unwrap();
        assert!(validate_guest_shader("@vertex fn main(", naga::ShaderStage::Vertex).is_err());
        assert!(
            validate_guest_shader(
                "@vertex fn main() -> @builtin(position) vec4f { return vec4f(true); }",
                naga::ShaderStage::Vertex,
            )
            .is_err()
        );
        assert!(
            validate_guest_shader(
                "@fragment fn main() -> @location(0) vec4f { return vec4f(1.0); }",
                naga::ShaderStage::Vertex,
            )
            .is_err()
        );
        assert!(
            validate_guest_shader(
                concat!(
                    "@group(0) @binding(0) var<uniform> data: vec4f;",
                    "@vertex fn main() -> @builtin(position) vec4f { return data; }"
                ),
                naga::ShaderStage::Vertex,
            )
            .is_err()
        );
    }

    #[wasm_bindgen_test]
    fn decodes_reference_triangle_stream() {
        let mut bytes = header(6, 1, 0);
        bytes.extend_from_slice(&7_u32.to_le_bytes());
        bytes.extend_from_slice(&0_u32.to_le_bytes());
        record(
            &mut bytes,
            OP_BEGIN_RENDER_PASS,
            &[
                0,
                LOAD_OP_CLEAR,
                STORE_OP_STORE,
                0.02_f32.to_bits(),
                0.04_f32.to_bits(),
                0.10_f32.to_bits(),
                1.0_f32.to_bits(),
                0,
            ],
        );
        record(&mut bytes, OP_SET_PIPELINE, &[1, 0]);
        record(
            &mut bytes,
            OP_SET_VIEWPORT,
            &[
                0.0_f32.to_bits(),
                0.0_f32.to_bits(),
                1024.0_f32.to_bits(),
                768.0_f32.to_bits(),
                0.0_f32.to_bits(),
                1.0_f32.to_bits(),
            ],
        );
        record(&mut bytes, OP_SET_SCISSOR, &[0, 0, 1024, 768]);
        record(&mut bytes, OP_DRAW, &[3, 1, 0, 0]);
        record(&mut bytes, OP_END_RENDER_PASS, &[]);
        let total_size = bytes.len() as u32;
        bytes[8..12].copy_from_slice(&total_size.to_le_bytes());

        let submit = decode(&bytes).unwrap();
        assert_eq!(bytes.len(), 184);
        assert_eq!(submit.major, SUBMIT_V1);
        assert_eq!(submit.records.len(), 6);
        assert_eq!(submit.resources, HashSet::from([7]));
    }

    #[wasm_bindgen_test]
    fn rejects_invalid_envelopes() {
        assert!(decode(&[]).is_err());
        assert!(decode(&vec![0; MAX_SUBMIT_BYTES + 1]).is_err());
        let mut version = header_version(4, 1, 0, 40);
        record(&mut version, OP_END_RENDER_PASS, &[]);
        assert!(decode(&version).is_err());
        let mut truncated = header(1, 0, 40);
        truncated.extend_from_slice(&OP_END_RENDER_PASS.to_le_bytes());
        truncated.extend_from_slice(&3_u16.to_le_bytes());
        truncated.extend_from_slice(&0_u32.to_le_bytes());
        assert!(decode(&truncated).is_err());
    }

    #[wasm_bindgen_test]
    fn rejects_unknown_opcode_and_nonzero_flags() {
        let mut unknown = header(1, 0, 40);
        unknown.extend_from_slice(&99_u16.to_le_bytes());
        unknown.extend_from_slice(&2_u16.to_le_bytes());
        unknown.extend_from_slice(&0_u32.to_le_bytes());
        assert!(decode(&unknown).is_err());

        let mut flagged = header(1, 0, 40);
        flagged.extend_from_slice(&OP_END_RENDER_PASS.to_le_bytes());
        flagged.extend_from_slice(&2_u16.to_le_bytes());
        flagged.extend_from_slice(&1_u32.to_le_bytes());
        assert!(decode(&flagged).is_err());
    }

    #[wasm_bindgen_test]
    fn rejects_duplicate_resources_and_nonzero_shader_padding() {
        let mut resources = header(1, 2, 48);
        resources.extend_from_slice(&7_u32.to_le_bytes());
        resources.extend_from_slice(&7_u32.to_le_bytes());
        resources.extend_from_slice(&OP_END_RENDER_PASS.to_le_bytes());
        resources.extend_from_slice(&2_u16.to_le_bytes());
        resources.extend_from_slice(&0_u32.to_le_bytes());
        assert!(decode(&resources).is_err());

        let mut shader = header(1, 0, 64);
        shader.extend_from_slice(&OP_CREATE_SHADER.to_le_bytes());
        shader.extend_from_slice(&8_u16.to_le_bytes());
        shader.extend_from_slice(&0_u32.to_le_bytes());
        shader.extend_from_slice(&1_u32.to_le_bytes());
        shader.extend_from_slice(&SHADER_STAGE_VERTEX.to_le_bytes());
        shader.extend_from_slice(&SHADER_IR_WGSL.to_le_bytes());
        shader.extend_from_slice(&1_u32.to_le_bytes());
        shader.extend_from_slice(b"x\0\0\0\0\0\0\x01");
        assert!(decode(&shader).is_err());
    }

    #[wasm_bindgen_test]
    fn fuzzes_bounded_decoder_without_panics() {
        let mut seed = 0xC0DE_15A5_u32;
        for case in 0..1024 {
            seed ^= seed << 13;
            seed ^= seed >> 17;
            seed ^= seed << 5;
            let length = seed as usize % 2048;
            let mut bytes = vec![0_u8; length];
            for byte in &mut bytes {
                seed ^= seed << 13;
                seed ^= seed >> 17;
                seed ^= seed << 5;
                *byte = seed as u8;
            }
            if case % 2 == 0 && length >= SUBMIT_HEADER_SIZE {
                bytes[0..4].copy_from_slice(&SUBMIT_MAGIC.to_le_bytes());
                let major = match case % 6 {
                    0 => SUBMIT_V1,
                    2 => SUBMIT_V2,
                    _ => SUBMIT_V3,
                };
                bytes[4..6].copy_from_slice(&major.to_le_bytes());
                bytes[6..8].copy_from_slice(&SUBMIT_MINOR.to_le_bytes());
                bytes[8..12].copy_from_slice(&(length as u32).to_le_bytes());
                bytes[20..32].fill(0);
            }
            if let Ok(submit) = decode(&bytes) {
                assert!(matches!(submit.major, SUBMIT_V1 | SUBMIT_V2 | SUBMIT_V3));
                assert!(!submit.records.is_empty());
                assert!(submit.records.len() <= MAX_COMMANDS);
                assert!(submit.resources.len() <= MAX_RESOURCES);
            }
        }

        let valid = shader_submit_version(
            SUBMIT_V2,
            SHADER_STAGE_VERTEX,
            b"@vertex fn main() -> @builtin(position) vec4f { return vec4f(0.0); }",
        );
        for _ in 0..512 {
            seed ^= seed << 13;
            seed ^= seed >> 17;
            seed ^= seed << 5;
            let mut mutated = valid.clone();
            let index = seed as usize % mutated.len();
            mutated[index] ^= 1 << (seed % 8);
            let _ = decode(&mutated);
        }

        assert!(decode(&vec![0; MAX_SUBMIT_BYTES]).is_err());
        assert!(decode(&vec![0; MAX_SUBMIT_BYTES + 1]).is_err());
    }
}
