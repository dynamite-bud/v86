use std::collections::HashMap;
use std::sync::{Arc, Mutex};

mod submit_3d;

use futures_channel::oneshot;
use wasm_bindgen::prelude::*;
use web_sys::HtmlCanvasElement;

const TARGET_BUFFER: u32 = 0;
const TARGET_TEXTURE_2D: u32 = 2;
const TARGET_TEXTURE_RECT: u32 = 5;
const FORMAT_R8_UNORM: u32 = 64;
const FORMAT_R8_UINT: u32 = 177;
const BIND_RENDER_TARGET: u32 = 1 << 1;
const FORMAT_B8G8R8A8_UNORM: u32 = 1;
const FORMAT_B8G8R8X8_UNORM: u32 = 2;
const FORMAT_R8G8B8A8_UNORM: u32 = 67;
const FORMAT_R8G8B8X8_UNORM: u32 = 134;
const FORMAT_B8G8R8A8_SRGB: u32 = 100;
const FORMAT_B8G8R8X8_SRGB: u32 = 101;
const FORMAT_R8G8B8A8_SRGB: u32 = 104;
const BYTES_PER_PIXEL: u32 = 4;
const PRESENT_PARAM_WORDS: usize = 8;
const RESOURCE_READBACK_TIMEOUT_MS: i32 = 5000;

#[derive(Clone, Copy)]
struct Rect {
    x: u32,
    y: u32,
    width: u32,
    height: u32,
}

#[derive(Clone, Copy)]
struct Scanout {
    resource_id: u32,
    rect: Rect,
}

struct Resource {
    target: u32,
    format: u32,
    width: u32,
    height: u32,
    byte_length: usize,
    bytes_per_pixel: u32,
    texture: Option<wgpu::Texture>,
    buffer: Option<wgpu::Buffer>,
    bind_group: Option<wgpu::BindGroup>,
    renderable: bool,
}

struct Renderer {
    canvas: HtmlCanvasElement,
    instance: wgpu::Instance,
    surface: wgpu::Surface<'static>,
    device: wgpu::Device,
    queue: wgpu::Queue,
    surface_config: wgpu::SurfaceConfiguration,
    pipeline: wgpu::RenderPipeline,
    blit_pipeline: wgpu::RenderPipeline,
    guest_pipeline_layout: wgpu::PipelineLayout,
    guest_pipeline: wgpu::RenderPipeline,
    bind_group_layout: wgpu::BindGroupLayout,
    sampler: wgpu::Sampler,
    zero_storage_buffer: wgpu::Buffer,
    present_params: wgpu::Buffer,
    resources: HashMap<u32, Resource>,
    contexts: HashMap<u32, submit_3d::Context3D>,
    scanout: Option<Scanout>,
    max_host_memory_bytes: usize,
    host_memory_bytes: usize,
    upload_scratch: Vec<u8>,
    fault: Arc<Mutex<Option<String>>>,
}

#[wasm_bindgen]
pub struct WgpuRenderer {
    inner: Option<Renderer>,
}

#[wasm_bindgen]
pub async fn create_renderer(
    canvas: HtmlCanvasElement,
    width: u32,
    height: u32,
    max_host_memory_bytes: f64,
) -> Result<WgpuRenderer, JsValue> {
    let max_host_memory_bytes = checked_host_limit(max_host_memory_bytes)?;
    let inner = Renderer::new(canvas, width, height, max_host_memory_bytes)
        .await
        .map_err(js_error)?;
    Ok(WgpuRenderer { inner: Some(inner) })
}

#[wasm_bindgen]
impl WgpuRenderer {
    pub fn create_resource_2d(
        &mut self,
        resource_id: u32,
        format: u32,
        width: u32,
        height: u32,
    ) -> Result<(), JsValue> {
        self.inner_mut()?
            .create_resource_2d(resource_id, format, width, height)
            .map_err(js_error)
    }

    pub fn capabilities_3d(&self) -> Result<Box<[u32]>, JsValue> {
        let renderer = self.inner()?;
        renderer.check_fault().map_err(js_error)?;
        let limits = renderer.device.limits();
        Ok(vec![
            limits.max_texture_dimension_2d,
            limits.max_bind_groups,
            limits.max_color_attachments,
        ]
        .into_boxed_slice())
    }

    pub fn object_stats_3d(&self) -> Result<Box<[u32]>, JsValue> {
        let renderer = self.inner()?;
        renderer.check_fault().map_err(js_error)?;
        let mut shaders = 0_usize;
        let mut pipelines = 0_usize;
        let mut shader_bytes = 0_usize;
        for context in renderer.contexts.values() {
            let stats = context.object_stats();
            shaders += stats.0;
            pipelines += stats.1;
            shader_bytes += stats.2;
        }
        Ok(vec![
            renderer.contexts.len() as u32,
            shaders as u32,
            pipelines as u32,
            shader_bytes as u32,
        ]
        .into_boxed_slice())
    }

    pub fn create_context_3d(&mut self, context_id: u32) -> Result<(), JsValue> {
        let renderer = self.inner_mut()?;
        renderer.check_fault().map_err(js_error)?;
        if context_id == 0 || renderer.contexts.contains_key(&context_id) {
            return Err(js_error("invalid: duplicate or zero context id"));
        }
        renderer
            .contexts
            .insert(context_id, submit_3d::Context3D::new());
        Ok(())
    }

    pub fn destroy_context_3d(&mut self, context_id: u32) -> Result<(), JsValue> {
        let renderer = self.inner_mut()?;
        renderer.check_fault().map_err(js_error)?;
        renderer
            .contexts
            .remove(&context_id)
            .ok_or_else(|| js_error("invalid: unknown context"))?;
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    pub fn create_resource_3d(
        &mut self,
        resource_id: u32,
        target: u32,
        bind: u32,
        format: u32,
        width: u32,
        height: u32,
        byte_length: u32,
    ) -> Result<(), JsValue> {
        self.inner_mut()?
            .create_resource_3d(
                resource_id,
                target,
                bind,
                format,
                width,
                height,
                byte_length,
            )
            .map_err(js_error)
    }

    pub fn attach_resource_3d(&mut self, context_id: u32, resource_id: u32) -> Result<(), JsValue> {
        let renderer = self.inner_mut()?;
        renderer.check_fault().map_err(js_error)?;
        if !renderer.resources.contains_key(&resource_id) {
            return Err(js_error("invalid: unknown resource"));
        }
        let context = renderer
            .contexts
            .get_mut(&context_id)
            .ok_or_else(|| js_error("invalid: unknown context"))?;
        if !context.attachments.insert(resource_id) {
            return Err(js_error("invalid: resource is already attached"));
        }
        Ok(())
    }

    pub fn detach_resource_3d(&mut self, context_id: u32, resource_id: u32) -> Result<(), JsValue> {
        let renderer = self.inner_mut()?;
        renderer.check_fault().map_err(js_error)?;
        let context = renderer
            .contexts
            .get_mut(&context_id)
            .ok_or_else(|| js_error("invalid: unknown context"))?;
        if !context.attachments.remove(&resource_id) {
            return Err(js_error("invalid: resource is not attached"));
        }
        Ok(())
    }

    pub async fn submit_3d(
        &mut self,
        context_id: u32,
        commands: &[u8],
        resource_ids: &[u32],
    ) -> Result<(), JsValue> {
        let renderer = self.inner_mut()?;
        submit_3d::submit(renderer, context_id, commands, resource_ids)
            .await
            .map_err(js_error)
    }

    pub fn destroy_resource(&mut self, resource_id: u32) -> Result<(), JsValue> {
        self.inner_mut()?
            .destroy_resource(resource_id)
            .map_err(js_error)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn upload_resource_2d(
        &mut self,
        resource_id: u32,
        x: u32,
        y: u32,
        width: u32,
        height: u32,
        stride: u32,
        data: &[u8],
    ) -> Result<(), JsValue> {
        self.inner_mut()?
            .upload_resource_2d(
                resource_id,
                Rect {
                    x,
                    y,
                    width,
                    height,
                },
                stride,
                data,
            )
            .map_err(js_error)
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn download_resource_2d(
        &mut self,
        resource_id: u32,
        x: u32,
        y: u32,
        width: u32,
        height: u32,
        stride: u32,
    ) -> Result<Vec<u8>, JsValue> {
        self.inner_mut()?
            .download_resource_2d(
                resource_id,
                Rect {
                    x,
                    y,
                    width,
                    height,
                },
                stride,
            )
            .await
            .map_err(js_error)
    }

    pub fn set_scanout(
        &mut self,
        resource_id: u32,
        x: u32,
        y: u32,
        width: u32,
        height: u32,
    ) -> Result<(), JsValue> {
        self.inner_mut()?
            .set_scanout(Scanout {
                resource_id,
                rect: Rect {
                    x,
                    y,
                    width,
                    height,
                },
            })
            .map_err(js_error)
    }

    pub fn clear_scanout(&mut self) -> Result<(), JsValue> {
        let renderer = self.inner_mut()?;
        renderer.check_fault().map_err(js_error)?;
        renderer.scanout = None;
        Ok(())
    }

    pub fn flush(
        &mut self,
        resource_id: u32,
        x: u32,
        y: u32,
        width: u32,
        height: u32,
    ) -> Result<bool, JsValue> {
        self.inner_mut()?
            .flush(
                resource_id,
                Rect {
                    x,
                    y,
                    width,
                    height,
                },
            )
            .map_err(js_error)
    }

    pub async fn wait_idle(&self) -> Result<(), JsValue> {
        self.inner()?.wait_idle().await.map_err(js_error)
    }

    pub fn reset(&mut self) -> Result<(), JsValue> {
        let renderer = self.inner_mut()?;
        renderer.check_fault().map_err(js_error)?;
        renderer.reset();
        Ok(())
    }

    pub fn device_status(&self) -> Result<(), JsValue> {
        self.inner()?.check_fault().map_err(js_error)
    }

    pub fn dispose(&mut self) {
        if let Some(mut renderer) = self.inner.take() {
            renderer.reset();
            renderer.device.destroy();
        }
    }

    fn inner(&self) -> Result<&Renderer, JsValue> {
        self.inner
            .as_ref()
            .ok_or_else(|| js_error("WebGPU renderer is disposed"))
    }

    fn inner_mut(&mut self) -> Result<&mut Renderer, JsValue> {
        self.inner
            .as_mut()
            .ok_or_else(|| js_error("WebGPU renderer is disposed"))
    }
}

impl Renderer {
    async fn new(
        canvas: HtmlCanvasElement,
        width: u32,
        height: u32,
        max_host_memory_bytes: usize,
    ) -> Result<Self, String> {
        if width == 0 || height == 0 {
            return Err("WebGPU surface dimensions must not be zero".into());
        }

        let instance = wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle());
        let surface = create_surface(&instance, &canvas)?;
        let adapter = instance
            .request_adapter(&wgpu::RequestAdapterOptions {
                power_preference: wgpu::PowerPreference::HighPerformance,
                force_fallback_adapter: false,
                compatible_surface: Some(&surface),
                apply_limit_buckets: false,
            })
            .await
            .map_err(|error| format!("Failed to request WebGPU adapter: {error}"))?;
        let (device, queue) = adapter
            .request_device(&wgpu::DeviceDescriptor {
                label: Some("v86 virtio-gpu device"),
                required_features: wgpu::Features::empty(),
                required_limits: wgpu::Limits::downlevel_webgl2_defaults()
                    .using_resolution(adapter.limits()),
                experimental_features: wgpu::ExperimentalFeatures::default(),
                memory_hints: wgpu::MemoryHints::MemoryUsage,
                trace: wgpu::Trace::Off,
            })
            .await
            .map_err(|error| format!("Failed to request WebGPU device: {error}"))?;

        let fault = Arc::new(Mutex::new(None));
        let device_fault = Arc::clone(&fault);
        device.set_device_lost_callback(move |reason, message| {
            record_fault(
                &device_fault,
                format!("WebGPU device lost ({reason:?}): {message}"),
            );
        });
        let validation_fault = Arc::clone(&fault);
        device.on_uncaptured_error(Arc::new(move |error| {
            record_fault(
                &validation_fault,
                format!("Uncaptured WebGPU error: {error}"),
            );
        }));

        let mut surface_config = surface
            .get_default_config(&adapter, width, height)
            .ok_or_else(|| "WebGPU adapter cannot present to the renderer canvas".to_owned())?;
        surface_config.usage = wgpu::TextureUsages::RENDER_ATTACHMENT;
        surface.configure(&device, &surface_config);

        let bind_group_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("v86 virtio-gpu present bind group layout"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Float { filterable: true },
                        view_dimension: wgpu::TextureViewDimension::D2,
                        multisampled: false,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 2,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
            ],
        });
        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("v86 virtio-gpu present pipeline layout"),
            bind_group_layouts: &[Some(&bind_group_layout)],
            immediate_size: 0,
        });
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("v86 virtio-gpu present shader"),
            source: wgpu::ShaderSource::Wgsl(include_str!("present.wgsl").into()),
        });
        let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("v86 virtio-gpu present pipeline"),
            layout: Some(&pipeline_layout),
            vertex: wgpu::VertexState {
                module: &shader,
                entry_point: Some("vertex_main"),
                compilation_options: Default::default(),
                buffers: &[],
            },
            primitive: wgpu::PrimitiveState::default(),
            depth_stencil: None,
            multisample: wgpu::MultisampleState::default(),
            fragment: Some(wgpu::FragmentState {
                module: &shader,
                entry_point: Some("fragment_main"),
                compilation_options: Default::default(),
                targets: &[Some(wgpu::ColorTargetState {
                    format: surface_config.format,
                    blend: None,
                    write_mask: wgpu::ColorWrites::ALL,
                })],
            }),
            multiview_mask: None,
            cache: None,
        });
        let blit_shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("v86 virtio-gpu blit shader"),
            source: wgpu::ShaderSource::Wgsl(include_str!("blit.wgsl").into()),
        });
        let blit_pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("v86 virtio-gpu blit pipeline"),
            layout: Some(&pipeline_layout),
            vertex: wgpu::VertexState {
                module: &blit_shader,
                entry_point: Some("vertex_main"),
                compilation_options: Default::default(),
                buffers: &[],
            },
            primitive: wgpu::PrimitiveState::default(),
            depth_stencil: None,
            multisample: wgpu::MultisampleState::default(),
            fragment: Some(wgpu::FragmentState {
                module: &blit_shader,
                entry_point: Some("fragment_main"),
                compilation_options: Default::default(),
                targets: &[Some(wgpu::ColorTargetState {
                    format: wgpu::TextureFormat::Rgba8Unorm,
                    blend: None,
                    write_mask: wgpu::ColorWrites::ALL,
                })],
            }),
            multiview_mask: None,
            cache: None,
        });
        let (guest_pipeline_layout, guest_pipeline) = submit_3d::create_pinned_pipeline(&device)?;
        queue.submit([submit_3d::encode_pinned_pipeline_probe(
            &device,
            &guest_pipeline,
        )]);
        let (probe_sender, probe_receiver) = oneshot::channel();
        queue.on_submitted_work_done(move || {
            let _ = probe_sender.send(());
        });
        probe_receiver
            .await
            .map_err(|_| "WebGPU pipeline probe callback was dropped".to_owned())?;
        if let Some(message) = fault
            .lock()
            .map_err(|_| "WebGPU fault lock was poisoned")?
            .clone()
        {
            return Err(message);
        }
        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("v86 virtio-gpu nearest sampler"),
            mag_filter: wgpu::FilterMode::Nearest,
            min_filter: wgpu::FilterMode::Nearest,
            mipmap_filter: wgpu::MipmapFilterMode::Nearest,
            address_mode_u: wgpu::AddressMode::ClampToEdge,
            address_mode_v: wgpu::AddressMode::ClampToEdge,
            ..Default::default()
        });
        let present_params = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("v86 virtio-gpu present parameters"),
            size: (PRESENT_PARAM_WORDS * size_of::<u32>()) as u64,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let zero_storage_buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("v86 virtio-gpu zero storage buffer"),
            size: 4,
            usage: wgpu::BufferUsages::STORAGE,
            mapped_at_creation: false,
        });

        Ok(Self {
            canvas,
            instance,
            surface,
            device,
            queue,
            surface_config,
            pipeline,
            blit_pipeline,
            guest_pipeline,
            guest_pipeline_layout,
            bind_group_layout,
            sampler,
            present_params,
            resources: HashMap::new(),
            contexts: HashMap::new(),
            scanout: None,
            max_host_memory_bytes,
            host_memory_bytes: 0,
            upload_scratch: Vec::new(),
            zero_storage_buffer,
            fault,
        })
    }

    fn create_resource_2d(
        &mut self,
        resource_id: u32,
        format: u32,
        width: u32,
        height: u32,
    ) -> Result<(), String> {
        let byte_length = checked_resource_size(width, height, BYTES_PER_PIXEL)?;
        self.create_resource(
            resource_id,
            TARGET_TEXTURE_2D,
            0,
            format,
            width,
            height,
            byte_length,
            false,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn create_resource_3d(
        &mut self,
        resource_id: u32,
        target: u32,
        bind: u32,
        format: u32,
        width: u32,
        height: u32,
        byte_length: u32,
    ) -> Result<(), String> {
        let renderable = bind & BIND_RENDER_TARGET != 0;
        self.create_resource(
            resource_id,
            target,
            bind,
            format,
            width,
            height,
            byte_length as usize,
            renderable,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn create_resource(
        &mut self,
        resource_id: u32,
        target: u32,
        _bind: u32,
        format: u32,
        width: u32,
        height: u32,
        byte_length: usize,
        renderable: bool,
    ) -> Result<(), String> {
        self.check_fault()?;
        if resource_id == 0 {
            return Err("resource_id must not be zero".into());
        }
        if self.resources.contains_key(&resource_id) {
            return Err(format!("Duplicate resource {resource_id}"));
        }
        if byte_length > self.max_host_memory_bytes - self.host_memory_bytes {
            return Err("GPU host memory limit exceeded".into());
        }

        if target == TARGET_BUFFER {
            if format != FORMAT_R8_UNORM || height != 1 || width as usize != byte_length {
                return Err("Invalid WebGPU buffer resource".into());
            }
            let allocation_size = byte_length
                .checked_add(3)
                .map(|size| size & !3)
                .ok_or_else(|| "Buffer resource size overflow".to_owned())?;
            let buffer = self.device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("v86 virtio-gpu buffer resource"),
                size: allocation_size as u64,
                usage: wgpu::BufferUsages::COPY_DST
                    | wgpu::BufferUsages::COPY_SRC
                    | wgpu::BufferUsages::STORAGE
                    | wgpu::BufferUsages::UNIFORM
                    | wgpu::BufferUsages::VERTEX
                    | wgpu::BufferUsages::INDEX,
                mapped_at_creation: false,
            });
            self.resources.insert(
                resource_id,
                Resource {
                    target,
                    format,
                    width,
                    height,
                    byte_length,
                    bytes_per_pixel: 1,
                    texture: None,
                    buffer: Some(buffer),
                    bind_group: None,
                    renderable: false,
                },
            );
            self.host_memory_bytes += byte_length;
            return Ok(());
        }

        if !matches!(target, TARGET_TEXTURE_2D | TARGET_TEXTURE_RECT) {
            return Err("Unsupported WebGPU resource target".into());
        }
        validate_texture_format(format)?;
        if width == 0 || height == 0 {
            return Err("Resource dimensions must not be zero".into());
        }
        if width > self.device.limits().max_texture_dimension_2d
            || height > self.device.limits().max_texture_dimension_2d
        {
            return Err("Resource dimensions exceed WebGPU limits".into());
        }
        let bytes_per_pixel =
            if matches!(format, FORMAT_R8_UNORM | FORMAT_R8_UINT) { 1 } else { BYTES_PER_PIXEL };
        if checked_resource_size(width, height, bytes_per_pixel)? != byte_length {
            return Err("Resource byte length does not match its dimensions".into());
        }
        // The pinned Ghostty translation consumes its R8UI atlas as normalized alpha.
        let texture_format = match format {
            FORMAT_R8_UNORM | FORMAT_R8_UINT => wgpu::TextureFormat::R8Unorm,
            FORMAT_B8G8R8A8_SRGB | FORMAT_B8G8R8X8_SRGB | FORMAT_R8G8B8A8_SRGB => {
                wgpu::TextureFormat::Rgba8UnormSrgb
            },
            _ => wgpu::TextureFormat::Rgba8Unorm,
        };
        let compatible_view_formats = [wgpu::TextureFormat::Rgba8Unorm];
        let view_formats = if texture_format == wgpu::TextureFormat::Rgba8UnormSrgb {
            compatible_view_formats.as_slice()
        } else {
            &[]
        };
        let texture = self.device.create_texture(&wgpu::TextureDescriptor {
            label: Some("v86 virtio-gpu texture resource"),
            size: wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: texture_format,
            usage: wgpu::TextureUsages::COPY_DST
                | wgpu::TextureUsages::COPY_SRC
                | wgpu::TextureUsages::TEXTURE_BINDING
                | if renderable {
                    wgpu::TextureUsages::RENDER_ATTACHMENT
                } else {
                    wgpu::TextureUsages::empty()
                },
            view_formats,
        });
        let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
        let bind_group = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("v86 virtio-gpu resource bind group"),
            layout: &self.bind_group_layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(&view),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::Sampler(&self.sampler),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: self.present_params.as_entire_binding(),
                },
            ],
        });
        self.resources.insert(
            resource_id,
            Resource {
                target,
                format,
                width,
                height,
                byte_length,
                bytes_per_pixel,
                texture: Some(texture),
                buffer: None,
                bind_group: Some(bind_group),
                renderable,
            },
        );
        self.host_memory_bytes += byte_length;
        Ok(())
    }

    fn destroy_resource(&mut self, resource_id: u32) -> Result<(), String> {
        self.check_fault()?;
        let resource = self
            .resources
            .remove(&resource_id)
            .ok_or_else(|| format!("Unknown resource {resource_id}"))?;
        for context in self.contexts.values_mut() {
            context.attachments.remove(&resource_id);
        }
        self.host_memory_bytes -= resource.byte_length;
        if self
            .scanout
            .is_some_and(|scanout| scanout.resource_id == resource_id)
        {
            self.scanout = None;
        }
        Ok(())
    }

    fn upload_resource_2d(
        &mut self,
        resource_id: u32,
        rect: Rect,
        stride: u32,
        data: &[u8],
    ) -> Result<(), String> {
        self.check_fault()?;
        let resource = self
            .resources
            .get(&resource_id)
            .ok_or_else(|| format!("Unknown resource {resource_id}"))?;
        validate_rect(rect, resource.width, resource.height)?;
        let row_bytes = rect
            .width
            .checked_mul(resource.bytes_per_pixel)
            .ok_or_else(|| "Upload row size overflow".to_owned())?;
        if stride < row_bytes {
            return Err("Upload stride is smaller than a row".into());
        }
        let required_length = stride as usize * (rect.height as usize - 1) + row_bytes as usize;
        if data.len() < required_length {
            return Err("Upload data is truncated".into());
        }

        if resource.target == TARGET_BUFFER {
            if rect.y != 0
                || rect.height != 1
                || rect.x & 3 != 0
                || row_bytes & 3 != 0
                || stride != row_bytes
            {
                return Err("Buffer uploads must be aligned and contiguous".into());
            }
            self.queue.write_buffer(
                resource.buffer.as_ref().unwrap(),
                rect.x as u64,
                &data[..row_bytes as usize],
            );
            self.queue.submit([]);
            return Ok(());
        }

        let aligned_row_bytes = row_bytes
            .checked_add(wgpu::COPY_BYTES_PER_ROW_ALIGNMENT - 1)
            .ok_or_else(|| "Upload row alignment overflow".to_owned())?
            / wgpu::COPY_BYTES_PER_ROW_ALIGNMENT
            * wgpu::COPY_BYTES_PER_ROW_ALIGNMENT;
        let upload_data = if stride == aligned_row_bytes {
            data
        } else {
            let upload_length = aligned_row_bytes as usize * rect.height as usize;
            self.upload_scratch.resize(upload_length, 0);
            for row in 0..rect.height as usize {
                let source_offset = row * stride as usize;
                let target_offset = row * aligned_row_bytes as usize;
                self.upload_scratch[target_offset..target_offset + row_bytes as usize]
                    .copy_from_slice(&data[source_offset..source_offset + row_bytes as usize]);
            }
            &self.upload_scratch
        };

        self.queue.write_texture(
            wgpu::TexelCopyTextureInfo {
                texture: resource.texture.as_ref().unwrap(),
                mip_level: 0,
                origin: wgpu::Origin3d {
                    x: rect.x,
                    y: rect.y,
                    z: 0,
                },
                aspect: wgpu::TextureAspect::All,
            },
            upload_data,
            wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(aligned_row_bytes),
                rows_per_image: Some(rect.height),
            },
            wgpu::Extent3d {
                width: rect.width,
                height: rect.height,
                depth_or_array_layers: 1,
            },
        );
        self.queue.submit([]);
        Ok(())
    }

    async fn download_resource_2d(
        &mut self,
        resource_id: u32,
        rect: Rect,
        stride: u32,
    ) -> Result<Vec<u8>, String> {
        self.check_fault()?;
        let resource = self
            .resources
            .get(&resource_id)
            .ok_or_else(|| format!("Unknown resource {resource_id}"))?;
        validate_rect(rect, resource.width, resource.height)?;
        let row_bytes = rect
            .width
            .checked_mul(resource.bytes_per_pixel)
            .ok_or_else(|| "Download row size overflow".to_owned())?;
        if stride < row_bytes {
            return Err("Download stride is smaller than a row".into());
        }
        let output_length = (stride as usize)
            .checked_mul(rect.height as usize - 1)
            .and_then(|length| length.checked_add(row_bytes as usize))
            .ok_or_else(|| "Download size overflow".to_owned())?;

        let aligned_row_bytes = if resource.target == TARGET_BUFFER {
            if rect.y != 0
                || rect.height != 1
                || rect.x & 3 != 0
                || row_bytes & 3 != 0
                || stride != row_bytes
            {
                return Err("Buffer downloads must be aligned and contiguous".into());
            }
            row_bytes
        } else {
            row_bytes
                .checked_add(wgpu::COPY_BYTES_PER_ROW_ALIGNMENT - 1)
                .ok_or_else(|| "Download row alignment overflow".to_owned())?
                / wgpu::COPY_BYTES_PER_ROW_ALIGNMENT
                * wgpu::COPY_BYTES_PER_ROW_ALIGNMENT
        };
        let staging_length = u64::from(aligned_row_bytes)
            .checked_mul(u64::from(rect.height))
            .ok_or_else(|| "Download staging size overflow".to_owned())?;
        let staging = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("v86 virtio-gpu readback staging buffer"),
            size: staging_length,
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        let mut encoder = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("v86 virtio-gpu readback encoder"),
            });
        if resource.target == TARGET_BUFFER {
            encoder.copy_buffer_to_buffer(
                resource.buffer.as_ref().unwrap(),
                u64::from(rect.x),
                &staging,
                0,
                u64::from(row_bytes),
            );
        } else {
            encoder.copy_texture_to_buffer(
                wgpu::TexelCopyTextureInfo {
                    texture: resource.texture.as_ref().unwrap(),
                    mip_level: 0,
                    origin: wgpu::Origin3d {
                        x: rect.x,
                        y: rect.y,
                        z: 0,
                    },
                    aspect: wgpu::TextureAspect::All,
                },
                wgpu::TexelCopyBufferInfo {
                    buffer: &staging,
                    layout: wgpu::TexelCopyBufferLayout {
                        offset: 0,
                        bytes_per_row: Some(aligned_row_bytes),
                        rows_per_image: Some(rect.height),
                    },
                },
                wgpu::Extent3d {
                    width: rect.width,
                    height: rect.height,
                    depth_or_array_layers: 1,
                },
            );
        }
        self.queue.submit([encoder.finish()]);

        let slice = staging.slice(..);
        let (sender, receiver) = oneshot::channel();
        slice.map_async(wgpu::MapMode::Read, move |result| {
            let _ = sender.send(result);
        });
        submit_3d::await_with_timeout(
            self,
            receiver,
            "WebGPU resource readback",
            RESOURCE_READBACK_TIMEOUT_MS,
        )
        .await?
        .map_err(|_| "WebGPU resource readback callback was canceled".to_owned())?
        .map_err(|error| format!("WebGPU resource readback failed: {error}"))?;

        let mapped = slice
            .get_mapped_range()
            .map_err(|error| format!("WebGPU resource readback mapping failed: {error}"))?;
        let mut result = vec![0; output_length];
        for row in 0..rect.height as usize {
            let source_offset = row * aligned_row_bytes as usize;
            let target_offset = row * stride as usize;
            result[target_offset..target_offset + row_bytes as usize]
                .copy_from_slice(&mapped[source_offset..source_offset + row_bytes as usize]);
        }
        drop(mapped);
        staging.unmap();
        Ok(result)
    }

    fn set_scanout(&mut self, scanout: Scanout) -> Result<(), String> {
        self.check_fault()?;
        let resource = self
            .resources
            .get(&scanout.resource_id)
            .ok_or_else(|| format!("Unknown resource {}", scanout.resource_id))?;
        if resource.texture.is_none() {
            return Err("Scanout resource is not a texture".into());
        }
        validate_rect(scanout.rect, resource.width, resource.height)?;
        self.scanout = Some(scanout);
        Ok(())
    }

    fn flush(&mut self, resource_id: u32, flush_rect: Rect) -> Result<bool, String> {
        self.check_fault()?;
        let resource = self
            .resources
            .get(&resource_id)
            .ok_or_else(|| format!("Unknown resource {resource_id}"))?;
        validate_rect(flush_rect, resource.width, resource.height)?;
        let Some(scanout) = self.scanout else {
            return Ok(false);
        };
        if scanout.resource_id != resource_id {
            return Ok(false);
        }

        let format = resource.format;
        let resource_width = resource.width;
        let resource_height = resource.height;
        let bind_group = resource
            .bind_group
            .clone()
            .ok_or_else(|| "Scanout resource is not presentable".to_owned())?;
        let params = [
            scanout.rect.x,
            scanout.rect.y,
            scanout.rect.width,
            scanout.rect.height,
            resource_width,
            resource_height,
            format,
            0,
        ];
        self.queue
            .write_buffer(&self.present_params, 0, bytemuck::cast_slice(&params));

        self.configure_surface(scanout.rect.width, scanout.rect.height);
        let Some((surface_texture, suboptimal)) = self.acquire_surface_texture()? else {
            self.queue.submit([]);
            return Ok(false);
        };
        let view = surface_texture
            .texture
            .create_view(&wgpu::TextureViewDescriptor::default());
        let mut encoder = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("v86 virtio-gpu present encoder"),
            });
        {
            let color_attachment = wgpu::RenderPassColorAttachment {
                view: &view,
                depth_slice: None,
                resolve_target: None,
                ops: wgpu::Operations {
                    load: wgpu::LoadOp::Clear(wgpu::Color::BLACK),
                    store: wgpu::StoreOp::Store,
                },
            };
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("v86 virtio-gpu present pass"),
                color_attachments: &[Some(color_attachment)],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
                multiview_mask: None,
            });
            pass.set_pipeline(&self.pipeline);
            pass.set_bind_group(0, &bind_group, &[]);
            pass.draw(0..3, 0..1);
        }
        self.queue.submit([encoder.finish()]);
        self.queue.present(surface_texture);
        if suboptimal {
            self.surface.configure(&self.device, &self.surface_config);
        }
        self.check_fault()?;
        Ok(true)
    }

    async fn wait_idle(&self) -> Result<(), String> {
        self.check_fault()?;
        let (sender, receiver) = oneshot::channel();
        self.queue.on_submitted_work_done(move || {
            let _ = sender.send(());
        });
        receiver
            .await
            .map_err(|_| "WebGPU completion callback was dropped".to_owned())?;
        self.check_fault()
    }

    fn configure_surface(&mut self, width: u32, height: u32) {
        if self.surface_config.width != width || self.surface_config.height != height {
            self.surface_config.width = width;
            self.surface_config.height = height;
            self.surface.configure(&self.device, &self.surface_config);
        }
    }

    fn acquire_surface_texture(&mut self) -> Result<Option<(wgpu::SurfaceTexture, bool)>, String> {
        for _ in 0..2 {
            match self.surface.get_current_texture() {
                wgpu::CurrentSurfaceTexture::Success(texture) => return Ok(Some((texture, false))),
                wgpu::CurrentSurfaceTexture::Suboptimal(texture) => {
                    return Ok(Some((texture, true)));
                },
                wgpu::CurrentSurfaceTexture::Timeout | wgpu::CurrentSurfaceTexture::Occluded => {
                    return Ok(None);
                },
                wgpu::CurrentSurfaceTexture::Outdated => {
                    self.surface.configure(&self.device, &self.surface_config);
                },
                wgpu::CurrentSurfaceTexture::Lost => {
                    self.surface = create_surface(&self.instance, &self.canvas)?;
                    self.surface.configure(&self.device, &self.surface_config);
                },
                wgpu::CurrentSurfaceTexture::Validation => {
                    return Err("WebGPU surface acquisition failed validation".into());
                },
            }
        }
        Err("WebGPU surface could not be recovered".into())
    }

    fn reset(&mut self) {
        self.resources.clear();
        self.contexts.clear();
        self.scanout = None;
        self.host_memory_bytes = 0;
        self.upload_scratch.clear();
    }

    fn check_fault(&self) -> Result<(), String> {
        let fault = self
            .fault
            .lock()
            .map_err(|_| "WebGPU fault state is unavailable".to_owned())?;
        match fault.as_ref() {
            Some(message) => Err(message.clone()),
            None => Ok(()),
        }
    }
}

fn create_surface(
    instance: &wgpu::Instance,
    canvas: &HtmlCanvasElement,
) -> Result<wgpu::Surface<'static>, String> {
    instance
        .create_surface(wgpu::SurfaceTarget::Canvas(canvas.clone()))
        .map_err(|error| format!("Failed to create WebGPU canvas surface: {error}"))
}

fn validate_texture_format(format: u32) -> Result<(), String> {
    match format {
        FORMAT_R8_UNORM
        | FORMAT_R8_UINT
        | FORMAT_B8G8R8A8_UNORM
        | FORMAT_B8G8R8X8_UNORM
        | FORMAT_R8G8B8A8_UNORM
        | FORMAT_R8G8B8X8_UNORM
        | FORMAT_B8G8R8A8_SRGB
        | FORMAT_B8G8R8X8_SRGB
        | FORMAT_R8G8B8A8_SRGB => Ok(()),
        _ => Err(format!("Unsupported virtio-gpu format {format}")),
    }
}

fn validate_rect(rect: Rect, resource_width: u32, resource_height: u32) -> Result<(), String> {
    if rect.width == 0 || rect.height == 0 {
        return Err("Rectangle dimensions must not be zero".into());
    }
    let right = rect
        .x
        .checked_add(rect.width)
        .ok_or_else(|| "Rectangle x extent overflow".to_owned())?;
    let bottom = rect
        .y
        .checked_add(rect.height)
        .ok_or_else(|| "Rectangle y extent overflow".to_owned())?;
    if right > resource_width || bottom > resource_height {
        return Err("Rectangle exceeds resource bounds".into());
    }
    Ok(())
}

fn checked_resource_size(width: u32, height: u32, bytes_per_pixel: u32) -> Result<usize, String> {
    let size = u64::from(width)
        .checked_mul(u64::from(height))
        .and_then(|size| size.checked_mul(u64::from(bytes_per_pixel)))
        .ok_or_else(|| "Resource dimensions overflow host addressing".to_owned())?;
    usize::try_from(size).map_err(|_| "Resource dimensions overflow host addressing".to_owned())
}

fn checked_host_limit(value: f64) -> Result<usize, JsValue> {
    if !value.is_finite() || value < 0.0 || value.fract() != 0.0 || value > usize::MAX as f64 {
        return Err(js_error(
            "max_host_memory_bytes must be a non-negative renderer-sized integer",
        ));
    }
    Ok(value as usize)
}

fn record_fault(fault: &Mutex<Option<String>>, message: String) {
    if let Ok(mut fault) = fault.lock()
        && fault.is_none()
    {
        *fault = Some(message);
    }
}

fn js_error(message: impl ToString) -> JsValue {
    js_sys::Error::new(&message.to_string()).into()
}
