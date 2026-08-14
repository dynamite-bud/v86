struct BlitParams {
    source_origin: vec2<i32>,
    source_size: vec2<i32>,
    resource_size: vec2<u32>,
    _padding: vec2<u32>,
}

@group(0) @binding(0) var source_texture: texture_2d<f32>;
@group(0) @binding(1) var source_sampler: sampler;
@group(0) @binding(2) var<uniform> params: BlitParams;

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
    let source_position = vec2<f32>(params.source_origin)
        + input.uv * vec2<f32>(params.source_size);
    let source_uv = source_position / vec2<f32>(params.resource_size);
    return textureSample(source_texture, source_sampler, source_uv);
}
