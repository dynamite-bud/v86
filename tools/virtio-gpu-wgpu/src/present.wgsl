struct PresentParams {
    scanout_origin: vec2<u32>,
    scanout_size: vec2<u32>,
    resource_size: vec2<u32>,
    format: u32,
    _padding: u32,
}

@group(0) @binding(0) var source_texture: texture_2d<f32>;
@group(0) @binding(1) var source_sampler: sampler;
@group(0) @binding(2) var<uniform> params: PresentParams;

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
}

@vertex
fn vertex_main(@builtin(vertex_index) vertex_index: u32) -> VertexOutput {
    let positions = array(
        vec2<f32>(-1.0, -1.0),
        vec2<f32>(3.0, -1.0),
        vec2<f32>(-1.0, 3.0),
    );
    let position = positions[vertex_index];
    var output: VertexOutput;
    output.position = vec4<f32>(position, 0.0, 1.0);
    output.uv = position * vec2<f32>(0.5, -0.5) + vec2<f32>(0.5, 0.5);
    return output;
}

@fragment
fn fragment_main(input: VertexOutput) -> @location(0) vec4<f32> {
    let resource_size = vec2<f32>(params.resource_size);
    let scanout_origin = vec2<f32>(params.scanout_origin);
    let scanout_size = vec2<f32>(params.scanout_size);
    let uv = (scanout_origin + input.uv * scanout_size) / resource_size;
    let pixel = textureSample(source_texture, source_sampler, uv);

    if params.format == 1u {
        return vec4<f32>(pixel.b, pixel.g, pixel.r, pixel.a);
    }
    if params.format == 2u {
        return vec4<f32>(pixel.b, pixel.g, pixel.r, 1.0);
    }
    if params.format == 67u {
        return pixel;
    }
    return vec4<f32>(pixel.rgb, 1.0);
}
