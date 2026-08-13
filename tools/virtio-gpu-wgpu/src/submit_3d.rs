use std::collections::{HashMap, HashSet};

use super::{FORMAT_R8G8B8A8_UNORM, Renderer};

const SUBMIT_MAGIC: u32 = 0x5336_3856; // "V86S"
const SUBMIT_MAJOR: u16 = 1;
const SUBMIT_MINOR: u16 = 0;
const SUBMIT_HEADER_SIZE: usize = 32;
const MAX_SUBMIT_BYTES: usize = 256 * 1024;
const MAX_COMMANDS: usize = 64;
const MAX_RESOURCES: usize = 128;
const MAX_SHADER_BYTES: usize = VERTEX_SHADER_SOURCE.len();
const MAX_SHADERS: usize = 32;
const MAX_PIPELINES: usize = 64;
const MAX_DRAWS: usize = 256;

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

const SHADER_IR_WGSL: u32 = 1;
const TOPOLOGY_TRIANGLE_LIST: u32 = 3;
const LOAD_OP_CLEAR: u32 = 1;
const STORE_OP_STORE: u32 = 1;
const SHADER_STAGE_VERTEX: u32 = 1;
const SHADER_STAGE_FRAGMENT: u32 = 2;
const VERTEX_SHADER_SOURCE: &str = concat!(
    "@vertex fn main(@builtin(vertex_index) i: u32) -> ",
    "@builtin(position) vec4f {",
    "let p = array<vec2f, 3>(vec2f(0.0, 0.72), ",
    "vec2f(-0.72, -0.72), vec2f(0.72, -0.72));",
    "return vec4f(p[i], 0.0, 1.0);}",
);
const FRAGMENT_SHADER_SOURCE: &str = concat!(
    "@fragment fn main() -> @location(0) vec4f {",
    "return vec4f(1.0, 0.08, 0.04, 1.0);}",
);

pub(crate) fn create_pinned_pipeline(
    device: &wgpu::Device,
) -> Result<wgpu::RenderPipeline, String> {
    validate_pinned_shader(VERTEX_SHADER_SOURCE, naga::ShaderStage::Vertex)?;
    validate_pinned_shader(FRAGMENT_SHADER_SOURCE, naga::ShaderStage::Fragment)?;

    let vertex = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some("v86 pinned guest vertex shader"),
        source: wgpu::ShaderSource::Wgsl(VERTEX_SHADER_SOURCE.into()),
    });
    let fragment = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some("v86 pinned guest fragment shader"),
        source: wgpu::ShaderSource::Wgsl(FRAGMENT_SHADER_SOURCE.into()),
    });
    let layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
        label: Some("v86 pinned guest pipeline layout"),
        bind_group_layouts: &[],
        immediate_size: 0,
    });
    Ok(
        device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("v86 pinned guest pipeline"),
            layout: Some(&layout),
            vertex: wgpu::VertexState {
                module: &vertex,
                entry_point: Some("main"),
                compilation_options: Default::default(),
                buffers: &[],
            },
            primitive: wgpu::PrimitiveState::default(),
            depth_stencil: None,
            multisample: wgpu::MultisampleState::default(),
            fragment: Some(wgpu::FragmentState {
                module: &fragment,
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
        }),
    )
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

fn validate_pinned_shader(source: &str, expected_stage: naga::ShaderStage) -> Result<(), String> {
    let module = naga::front::wgsl::parse_str(source)
        .map_err(|error| format!("Pinned WGSL parse failed: {}", error.emit_to_string(source)))?;
    naga::valid::Validator::new(
        naga::valid::ValidationFlags::all(),
        naga::valid::Capabilities::all(),
    )
    .validate(&module)
    .map_err(|error| format!("Pinned WGSL validation failed: {error}"))?;
    if module.entry_points.len() != 1
        || module.entry_points[0].name != "main"
        || module.entry_points[0].stage != expected_stage
    {
        return Err("Pinned WGSL has an unexpected entry point".into());
    }
    Ok(())
}

pub(crate) struct Context3D {
    pub(crate) attachments: HashSet<u32>,
    shaders: HashMap<u32, Shader3D>,
    pipelines: HashMap<u32, Pipeline3D>,
}

struct Shader3D {
    stage: u32,
}

struct Pipeline3D {
    vertex_shader: u32,
    fragment_shader: u32,
}

impl Context3D {
    pub(crate) fn new() -> Self {
        Self {
            attachments: HashSet::new(),
            shaders: HashMap::new(),
            pipelines: HashMap::new(),
        }
    }
}

enum Record {
    CreateShader {
        id: u32,
        stage: u32,
    },
    DestroyShader(u32),
    CreatePipeline {
        id: u32,
        vertex_shader: u32,
        fragment_shader: u32,
        format: u32,
    },
    DestroyPipeline(u32),
    BeginRenderPass {
        resource_id: u32,
        clear: [f64; 4],
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
    Draw {
        vertices: u32,
        instances: u32,
        first_vertex: u32,
        first_instance: u32,
    },
    EndRenderPass,
}

struct Submit {
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

struct Draw {
    pipeline_id: u32,
    viewport: Option<Viewport>,
    scissor: Option<Scissor>,
    vertices: u32,
    instances: u32,
    first_vertex: u32,
    first_instance: u32,
}

struct Pass {
    resource_id: u32,
    clear: [f64; 4],
    draws: Vec<Draw>,
}

pub(crate) async fn submit(
    renderer: &mut Renderer,
    context_id: u32,
    bytes: &[u8],
    allowed_resources: &[u32],
) -> Result<(), String> {
    renderer.check_fault()?;
    let submit = decode(bytes).map_err(invalid)?;
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
    let result = submit_inner(renderer, &mut context, submit, &allowed).await;
    renderer.contexts.insert(context_id, context);
    result
}

async fn submit_inner(
    renderer: &mut Renderer,
    context: &mut Context3D,
    submit: Submit,
    allowed_resources: &HashSet<u32>,
) -> Result<(), String> {
    if !submit.resources.is_subset(allowed_resources)
        || !submit.resources.is_subset(&context.attachments)
    {
        return Err(invalid("submit resource is not attached to the context"));
    }

    let has_mutation = submit.records.iter().any(|record| {
        matches!(
            record,
            Record::CreateShader { .. }
                | Record::DestroyShader(_)
                | Record::CreatePipeline { .. }
                | Record::DestroyPipeline(_)
        )
    });
    let has_render = submit.records.iter().any(|record| {
        matches!(
            record,
            Record::BeginRenderPass { .. }
                | Record::SetPipeline(_)
                | Record::SetViewport { .. }
                | Record::SetScissor { .. }
                | Record::Draw { .. }
                | Record::EndRenderPass
        )
    });
    if has_mutation && has_render {
        return Err(invalid("object and render records cannot share a submit"));
    }
    if has_mutation {
        apply_mutations(context, submit.records)
    } else if has_render {
        render(renderer, context, submit.records, &submit.resources).await
    } else {
        Err(invalid("empty submit"))
    }
}

fn apply_mutations(context: &mut Context3D, records: Vec<Record>) -> Result<(), String> {
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
                    context.shaders.remove(&id);
                },
                Record::DestroyPipeline(id) => {
                    context.pipelines.remove(&id);
                },
                _ => unreachable!(),
            }
        }
        return Ok(());
    }

    let mut shader_ids = context.shaders.keys().copied().collect::<HashSet<_>>();
    let mut pipeline_ids = context.pipelines.keys().copied().collect::<HashSet<_>>();
    for record in &records {
        match record {
            Record::CreateShader { id, .. } => {
                if shader_ids.len() >= MAX_SHADERS || !shader_ids.insert(*id) {
                    return Err(invalid("duplicate shader or shader limit exceeded"));
                }
            },
            Record::CreatePipeline {
                id,
                vertex_shader,
                fragment_shader,
                format,
            } => {
                if pipeline_ids.len() >= MAX_PIPELINES || !pipeline_ids.insert(*id) {
                    return Err(invalid("duplicate pipeline or pipeline limit exceeded"));
                }
                if !shader_ids.contains(vertex_shader) || !shader_ids.contains(fragment_shader) {
                    return Err(invalid("pipeline references an unknown shader"));
                }
                if *format != FORMAT_R8G8B8A8_UNORM {
                    return Err(invalid("unsupported render target format"));
                }
            },
            _ => return Err(invalid("invalid mutation record")),
        }
    }

    let mut staged_shaders = HashMap::new();
    for record in &records {
        if let Record::CreateShader { id, stage } = record {
            staged_shaders.insert(*id, Shader3D { stage: *stage });
        }
    }
    let mut staged_pipelines = HashMap::new();
    for record in records {
        if let Record::CreatePipeline {
            id,
            vertex_shader,
            fragment_shader,
            ..
        } = record
        {
            let vertex = staged_shaders
                .get(&vertex_shader)
                .or_else(|| context.shaders.get(&vertex_shader))
                .ok_or_else(|| invalid("unknown vertex shader"))?;
            let fragment = staged_shaders
                .get(&fragment_shader)
                .or_else(|| context.shaders.get(&fragment_shader))
                .ok_or_else(|| invalid("unknown fragment shader"))?;
            if vertex.stage != SHADER_STAGE_VERTEX || fragment.stage != SHADER_STAGE_FRAGMENT {
                return Err(invalid("pipeline shader stage mismatch"));
            }
            staged_pipelines.insert(
                id,
                Pipeline3D {
                    vertex_shader,
                    fragment_shader,
                },
            );
        }
    }

    context.shaders.extend(staged_shaders);
    context.pipelines.extend(staged_pipelines);
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
    let mut draw_count = 0;

    for record in records {
        match record {
            Record::BeginRenderPass { resource_id, clear } => {
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
                    draws: Vec::new(),
                });
                current_pipeline = None;
                viewport = None;
                scissor = None;
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
                if vertices == 0 || instances == 0 {
                    return Err(invalid("empty draw"));
                }
                if first_vertex.checked_add(vertices).is_none()
                    || first_instance.checked_add(instances).is_none()
                {
                    return Err(invalid("draw range overflow"));
                }
                draw_count += 1;
                if draw_count > MAX_DRAWS {
                    return Err(invalid("draw limit exceeded"));
                }
                pass.draws.push(Draw {
                    pipeline_id,
                    viewport,
                    scissor,
                    vertices,
                    instances,
                    first_vertex,
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

    let mut encoder = renderer
        .device
        .create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("v86 guest submit encoder"),
        });
    for plan in passes {
        let resource = renderer.resources.get(&plan.resource_id).unwrap();
        let view = resource
            .texture
            .create_view(&wgpu::TextureViewDescriptor::default());
        let color_attachment = wgpu::RenderPassColorAttachment {
            view: &view,
            depth_slice: None,
            resolve_target: None,
            ops: wgpu::Operations {
                load: wgpu::LoadOp::Clear(wgpu::Color {
                    r: plan.clear[0],
                    g: plan.clear[1],
                    b: plan.clear[2],
                    a: plan.clear[3],
                }),
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
        for draw in plan.draws {
            debug_assert!(context.pipelines.contains_key(&draw.pipeline_id));
            pass.set_pipeline(&renderer.guest_pipeline);
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
            pass.draw(
                draw.first_vertex..draw.first_vertex + draw.vertices,
                draw.first_instance..draw.first_instance + draw.instances,
            );
        }
    }
    renderer.queue.submit([encoder.finish()]);
    renderer.wait_idle().await?;
    Ok(())
}
fn decode(bytes: &[u8]) -> Result<Submit, String> {
    if bytes.len() < SUBMIT_HEADER_SIZE || bytes.len() > MAX_SUBMIT_BYTES {
        return Err("submit size is out of range".into());
    }
    if read_u32(bytes, 0)? != SUBMIT_MAGIC
        || read_u16(bytes, 4)? != SUBMIT_MAJOR
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
        let record = decode_record(opcode, &bytes[offset..end], &resource_ids)?;
        if let Record::BeginRenderPass { resource_id, .. } = &record {
            used_resources.insert(*resource_id);
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
    Ok(Submit { records, resources })
}
fn decode_record(opcode: u16, bytes: &[u8], resources: &[u32]) -> Result<Record, String> {
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
            if id == 0
                || !matches!(stage, SHADER_STAGE_VERTEX | SHADER_STAGE_FRAGMENT)
                || ir_kind != SHADER_IR_WGSL
                || source_length == 0
                || source_length > MAX_SHADER_BYTES
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
            let expected_source = match stage {
                SHADER_STAGE_VERTEX => VERTEX_SHADER_SOURCE.as_bytes(),
                SHADER_STAGE_FRAGMENT => FRAGMENT_SHADER_SOURCE.as_bytes(),
                _ => unreachable!(),
            };
            if source_bytes != expected_source {
                return Err("unsupported shader source".into());
            }
            Ok(Record::CreateShader { id, stage })
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
            exact(40)?;
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
                || read_u32(bytes, 32)? != 0
                || read_u32(bytes, 36)? != 0
            {
                return Err("invalid pipeline descriptor".into());
            }
            Ok(Record::CreatePipeline {
                id,
                vertex_shader,
                fragment_shader,
                format,
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
            Ok(Record::BeginRenderPass { resource_id, clear })
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

fn invalid(message: impl ToString) -> String {
    format!("invalid: {}", message.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use wasm_bindgen_test::wasm_bindgen_test;

    fn header(command_count: u32, resource_count: u32, total_size: u32) -> Vec<u8> {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&SUBMIT_MAGIC.to_le_bytes());
        bytes.extend_from_slice(&SUBMIT_MAJOR.to_le_bytes());
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
        let padded_length = (source.len() + 7) & !7;
        let record_size = 24 + padded_length;
        let mut bytes = header(1, 0, (SUBMIT_HEADER_SIZE + record_size) as u32);
        bytes.extend_from_slice(&OP_CREATE_SHADER.to_le_bytes());
        bytes.extend_from_slice(&((record_size / 4) as u16).to_le_bytes());
        bytes.extend_from_slice(&0_u32.to_le_bytes());
        bytes.extend_from_slice(&1_u32.to_le_bytes());
        bytes.extend_from_slice(&stage.to_le_bytes());
        bytes.extend_from_slice(&SHADER_IR_WGSL.to_le_bytes());
        bytes.extend_from_slice(&(source.len() as u32).to_le_bytes());
        bytes.extend_from_slice(source.as_bytes());
        bytes.resize(SUBMIT_HEADER_SIZE + record_size, 0);
        bytes
    }

    #[wasm_bindgen_test]
    fn accepts_only_the_pinned_shader_sources() {
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
    fn immutable_object_handles_preserve_pipeline_ownership() {
        let mut context = Context3D::new();
        apply_mutations(
            &mut context,
            vec![
                Record::CreateShader {
                    id: 1,
                    stage: SHADER_STAGE_VERTEX,
                },
                Record::CreateShader {
                    id: 2,
                    stage: SHADER_STAGE_FRAGMENT,
                },
                Record::CreatePipeline {
                    id: 3,
                    vertex_shader: 1,
                    fragment_shader: 2,
                    format: FORMAT_R8G8B8A8_UNORM,
                },
            ],
        )
        .unwrap();
        assert!(apply_mutations(&mut context, vec![Record::DestroyShader(1)]).is_err());
        apply_mutations(
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
    }

    #[wasm_bindgen_test]
    fn pinned_shaders_pass_naga_validation() {
        validate_pinned_shader(VERTEX_SHADER_SOURCE, naga::ShaderStage::Vertex).unwrap();
        validate_pinned_shader(FRAGMENT_SHADER_SOURCE, naga::ShaderStage::Fragment).unwrap();
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
        assert_eq!(submit.records.len(), 6);
        assert_eq!(submit.resources, HashSet::from([7]));
    }

    #[wasm_bindgen_test]
    fn rejects_truncated_and_oversized_envelopes() {
        assert!(decode(&[]).is_err());
        assert!(decode(&vec![0; MAX_SUBMIT_BYTES + 1]).is_err());
        let mut bytes = header(1, 0, 40);
        bytes.extend_from_slice(&OP_END_RENDER_PASS.to_le_bytes());
        bytes.extend_from_slice(&3_u16.to_le_bytes());
        bytes.extend_from_slice(&0_u32.to_le_bytes());
        assert!(decode(&bytes).is_err());
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
}
