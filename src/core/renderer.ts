import type { Anime4KPipeline } from 'anime4k-webgpu';
import type { Anime4KClass, Dimensions, EnhancementEffect, ModeClasses } from '../types';

/**
 * 全屏纹理四边形顶点着色器
 * 定义顶点位置和UV坐标，用于渲染全屏纹理
 */
const fullscreenTexturedQuadWGSL = `
struct VertexOutput {
  @builtin(position) Position : vec4<f32>,
  @location(0) fragUV : vec2<f32>,
}

@vertex
fn vert_main(@builtin(vertex_index) VertexIndex : u32) -> VertexOutput {
  const pos = array(
    vec2( 1.0,  1.0),  // 右上
    vec2( 1.0, -1.0),  // 右下
    vec2(-1.0, -1.0),  // 左下
    vec2( 1.0,  1.0),  // 右上 (重复)
    vec2(-1.0, -1.0),  // 左下 (重复)
    vec2(-1.0,  1.0),  // 左上
  );

  const uv = array(
    vec2(1.0, 0.0),  // 右上UV
    vec2(1.0, 1.0),  // 右下UV
    vec2(0.0, 1.0),  // 左下UV
    vec2(1.0, 0.0),  // 右上UV (重复)
    vec2(0.0, 1.0),  // 左下UV (重复)
    vec2(0.0, 0.0),  // 左上UV
  );

  var output : VertexOutput;
  output.Position = vec4(pos[VertexIndex], 0.0, 1.0);
  output.fragUV = uv[VertexIndex];
  return output;
}
`;

/**
 * 纹理采样片段着色器
 * 从纹理中采样颜色值并输出到屏幕
 */
const sampleExternalTextureWGSL = `
@group(0) @binding(1) var mySampler: sampler;
@group(0) @binding(2) var myTexture: texture_2d<f32>;

@fragment
fn main(@location(0) fragUV : vec2f) -> @location(0) vec4f {
  // 使用基础边缘钳制采样纹理
  return textureSampleBaseClampToEdge(myTexture, mySampler, fragUV);
}
`;

/**
 * RendererOptions 定义了创建 Renderer 实例所需的配置项
 */
export interface RendererOptions {
  /** 视频播放器元素 */
  video: HTMLVideoElement;
  /** 用于渲染的 Canvas 元素 */
  canvas: HTMLCanvasElement;
  /** 要应用的增强效果数组 */
  effects: EnhancementEffect[];
  /** 动态加载的 Anime4K 效果类模块 */
  modeClasses: ModeClasses;
  /** 渲染的目标分辨率 */
  targetDimensions: Dimensions;
  /** 发生运行时错误时的回调函数 */
  onError?: (error: Error) => void;
  /** 成功渲染第一帧时的回调函数 */
  onFirstFrameRendered?: () => void;
}

/**
 * Renderer 类封装了所有与 WebGPU 相关的渲染逻辑。
 * 它负责管理 GPU 设备、上下文、渲染管线、纹理和渲染循环。
 */
export class Renderer {
  // --- 核心属性 ---
  private video: HTMLVideoElement;
  private canvas: HTMLCanvasElement;
  private effects: EnhancementEffect[];
  private modeClasses: ModeClasses;
  private targetDimensions: Dimensions;
  private onError?: (error: Error) => void;
  private onFirstFrameRendered?: () => void;

  // --- 状态标志 ---
  private destroyed = false;
  private animationFrameId: number | null = null;

  // --- WebGPU 对象 ---
  private device!: GPUDevice;
  private context!: GPUCanvasContext;
  private presentationFormat!: GPUTextureFormat;
  /** 用于从视频帧复制图像数据的中间纹理 */
  private videoFrameTexture!: GPUTexture;
  /** 效果处理管线链 */
  private pipelines: Anime4KPipeline[] = [];

  // --- 最终渲染阶段的对象 ---
  private renderBindGroupLayout!: GPUBindGroupLayout;
  private renderPipeline!: GPURenderPipeline;
  private sampler!: GPUSampler;
  private renderBindGroup!: GPUBindGroup;

  /**
   * Renderer 的构造函数是私有的，请使用 `Renderer.create()` 静态方法来创建实例。
   * @param options - 初始化渲染器所需的配置
   */
  private constructor(options: RendererOptions) {
    this.video = options.video;
    this.canvas = options.canvas;
    this.effects = options.effects;
    this.modeClasses = options.modeClasses;
    this.targetDimensions = options.targetDimensions;
    this.onError = options.onError;
    this.onFirstFrameRendered = options.onFirstFrameRendered;
  }

  /**
   * 创建并异步初始化一个新的 Renderer 实例。
   * 这是实例化 Renderer 的首选方法。
   * @param options - 初始化渲染器所需的配置
   * @returns 返回一个 Promise，解析为一个完全初始化的 Renderer 实例
   */
  public static async create(options: RendererOptions): Promise<Renderer> {
    const renderer = new Renderer(options);
    await renderer.initialize();
    return renderer;
  }

  /**
   * 初始化 WebGPU 设备、上下文和所有必要的渲染资源。
   */
  private async initialize(): Promise<void> {
    // 等待视频数据加载完成
    if (this.video.readyState < this.video.HAVE_FUTURE_DATA) {
      await new Promise((resolve) => {
        this.video.onloadeddata = resolve;
      });
    }

    // 请求 GPU 适配器，并根据平台设置能效偏好
    const adapterOptions: GPURequestAdapterOptions = {};
    // 在 Windows 上设置 powerPreference 会产生警告，因此仅在非 Windows 平台使用
    if (!navigator.platform.startsWith('Win')) {
      adapterOptions.powerPreference = 'high-performance';
    }
    const adapter = await navigator.gpu.requestAdapter(adapterOptions);
    if (!adapter) {
      throw new Error('WebGPU not supported');
    }

    // 请求 GPU 设备并配置 Canvas 上下文
    this.device = await adapter.requestDevice();
    this.context = this.canvas.getContext('webgpu')!;
    this.presentationFormat = navigator.gpu.getPreferredCanvasFormat();
    this.context.configure({
      device: this.device,
      format: this.presentationFormat,
      alphaMode: 'premultiplied',
    });

    // 创建初始资源
    this.createResources();
    this.buildPipelines();
    await this.createRenderPipeline();
    this.createRenderBindGroup();

    // 启动渲染循环，尝试渲染第一帧并启动持续渲染
    this.animationFrameId = this.video.requestVideoFrameCallback(this.renderFirstFrameAndStartLoop);
  }

  /**
   * 创建处理所需的 GPU 资源，主要是用于接收视频帧的纹理。
   * 当视频源分辨率变化时，此方法会被调用以重新创建纹理。
   */
  private createResources(): void {
    this.videoFrameTexture?.destroy(); // 销毁旧纹理
    this.videoFrameTexture = this.device.createTexture({
      size: [this.video.videoWidth, this.video.videoHeight, 1],
      format: 'rgba16float', // 使用 float 格式以获得更高精度
      usage:
        GPUTextureUsage.TEXTURE_BINDING | // 可以作为着色器输入
        GPUTextureUsage.COPY_DST |        // 可以作为拷贝目的地
        GPUTextureUsage.RENDER_ATTACHMENT, // 可以作为渲染目标
    });
  }

  /**
   * 根据当前的效果链（this.effects）构建 Anime4K 处理管线。
   * 此方法会销毁旧管线并创建新管线。
   */
  private buildPipelines(): void {
    this.pipelines.forEach(p => (p as any).destroy?.());

    const pipelines: Anime4KPipeline[] = [];
    let currentTexture = this.videoFrameTexture;
    let curWidth = this.video.videoWidth;
    let curHeight = this.video.videoHeight;
    const DownscaleClass = this.modeClasses['Downscale' as keyof typeof this.modeClasses] as Anime4KClass;

    const upscaleFactors = this.effects.map(e => e.upscaleFactor ?? 1);
    const remainingUpscaleFactors = upscaleFactors.map((_, i) =>
      upscaleFactors.slice(i + 1).reduce((acc, val) => acc * val, 1)
    );

    for (let i = 0; i < this.effects.length; i++) {
      const effect = this.effects[i];
      const EffectClass = this.modeClasses[effect.className as keyof typeof this.modeClasses] as Anime4KClass;
      if (EffectClass) {
        const pipeline = new EffectClass({
          device: this.device,
          inputTexture: currentTexture,
          nativeDimensions: { width: curWidth, height: curHeight },
          targetDimensions: this.targetDimensions,
        });
        pipelines.push(pipeline);
        currentTexture = pipeline.getOutputTexture();

        if (effect.upscaleFactor) {
          curWidth *= effect.upscaleFactor;
          curHeight *= effect.upscaleFactor;

          const remainingFactor = remainingUpscaleFactors[i];
          if (DownscaleClass && remainingFactor > 1) {
            const idealIntermediateWidth = this.targetDimensions.width / remainingFactor;
            const idealIntermediateHeight = this.targetDimensions.height / remainingFactor;

            if (curWidth > idealIntermediateWidth * 1.1) {
              const intermediateDownscale = new DownscaleClass({
                device: this.device,
                inputTexture: currentTexture,
                nativeDimensions: { width: curWidth, height: curHeight },
                targetDimensions: {
                  width: Math.ceil(idealIntermediateWidth),
                  height: Math.ceil(idealIntermediateHeight),
                },
              });
              pipelines.push(intermediateDownscale);
              currentTexture = intermediateDownscale.getOutputTexture();
              curWidth = Math.ceil(idealIntermediateWidth);
              curHeight = Math.ceil(idealIntermediateHeight);
            }
          }
        }
      }
    }

    if (pipelines.length === 0) {
      pipelines.push({
        pass: () => {},
        getOutputTexture: () => this.videoFrameTexture,
        updateParam: () => {},
      });
    }
    this.pipelines = pipelines;
  }

  /**
   * 创建最终的渲染管线，该管线负责将处理完成的纹理绘制到 Canvas 上。
   */
  private async createRenderPipeline(): Promise<void> {
    // 定义绑定组布局，描述着色器所需的资源
    this.renderBindGroupLayout = this.device.createBindGroupLayout({
      entries: [
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: {} }, // 采样器
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: {} }, // 输入纹理
      ],
    });

    // 异步创建渲染管线以提高性能
    this.renderPipeline = await this.device.createRenderPipelineAsync({
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.renderBindGroupLayout] }),
      vertex: {
        module: this.device.createShaderModule({ code: fullscreenTexturedQuadWGSL }),
        entryPoint: 'vert_main',
      },
      fragment: {
        module: this.device.createShaderModule({ code: sampleExternalTextureWGSL }),
        entryPoint: 'main',
        targets: [{ format: this.presentationFormat }],
      },
      primitive: { topology: 'triangle-list' },
    });

    this.sampler = this.device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
  }

  /**
   * 创建渲染绑定组，它将实际的资源（采样器和最终纹理）绑定到渲染管线。
   */
  private createRenderBindGroup(): void {
    this.renderBindGroup = this.device.createBindGroup({
      layout: this.renderBindGroupLayout,
      entries: [
        { binding: 1, resource: this.sampler },
        // 获取效果链中最后一个管线的输出纹理作为最终渲染的输入
        { binding: 2, resource: this.pipelines.at(-1)!.getOutputTexture().createView() },
      ],
    });
  }

  /**
   * 处理单帧渲染的核心逻辑。
   * @returns {boolean} 如果成功渲染了一帧则返回 true，否则返回 false。
   */
  private processFrame(): boolean {
    if (this.destroyed) return false;

    try {
      if (this.video.paused || this.video.readyState < this.video.HAVE_CURRENT_DATA) {
        return false; // 视频未准备好，跳过此帧
      }

      // 检查分辨率是否变化
      if (this.video.videoWidth !== this.videoFrameTexture.width || this.video.videoHeight !== this.videoFrameTexture.height) {
        console.log(`[Anime4KWebExt] Resolution changed: ${this.videoFrameTexture.width}x${this.videoFrameTexture.height} -> ${this.video.videoWidth}x${this.video.videoHeight}`);
        this.handleSourceResize();
        return false; // 分辨率已变，跳过此帧的渲染，等待下一帧
      }

      // --- 执行渲染 ---
      this.device.queue.copyExternalImageToTexture(
        { source: this.video },
        { texture: this.videoFrameTexture },
        [this.video.videoWidth, this.video.videoHeight]
      );

      const commandEncoder = this.device.createCommandEncoder();
      this.pipelines.forEach((pipeline) => pipeline.pass(commandEncoder));
      const passEncoder = commandEncoder.beginRenderPass({
        colorAttachments: [{
          view: this.context.getCurrentTexture().createView(),
          clearValue: { r: 0.0, g: 0.0, b: 0.0, a: 1.0 },
          loadOp: 'clear',
          storeOp: 'store',
        }],
      });
      passEncoder.setPipeline(this.renderPipeline);
      passEncoder.setBindGroup(0, this.renderBindGroup);
      passEncoder.draw(6);
      passEncoder.end();
      this.device.queue.submit([commandEncoder.finish()]);
      
      return true; // 成功渲染

    } catch (error) {
      console.error('[Anime4KWebExt] Frame processing failed:', error);
      if (this.onError) this.onError(error instanceof Error ? error : new Error(String(error)));
      this.destroy();
      return false;
    }
  }

  /**
   * 尝试渲染第一帧。成功后，调用回调并切换到常规渲染循环。
   * 如果不成功（例如视频暂停），则重新调度自身。
   */
  private renderFirstFrameAndStartLoop = (): void => {
    if (this.destroyed) return;

    if (this.processFrame()) {
      // 第一帧成功渲染
      this.onFirstFrameRendered?.();
      // 切换到常规渲染循环
      this.animationFrameId = this.video.requestVideoFrameCallback(this.renderLoop);
    } else {
      // 第一帧未成功渲染（例如暂停、分辨率变更），在下一帧重试
      if (!this.destroyed) {
        this.animationFrameId = this.video.requestVideoFrameCallback(this.renderFirstFrameAndStartLoop);
      }
    }
  };

  /**
   * 常规渲染循环，处理第一帧之后的所有帧。
   */
  private renderLoop = (): void => {
    if (this.destroyed) return;

    this.processFrame();

    // 持续调度自身
    if (!this.destroyed) {
      this.animationFrameId = this.video.requestVideoFrameCallback(this.renderLoop);
    }
  };

  /**
   * 当视频源本身的分辨率发生变化时调用（例如，用户在视频播放器中切换了清晰度）
   * 这将重新创建基于视频原始尺寸的资源
   */
  public handleSourceResize(): void {
    if (this.destroyed) return;
    console.log('[Anime4KWebExt] Resizing renderer due to video source dimension change...');
    this.createResources();
    this.buildPipelines();
    this.createRenderBindGroup();
    console.log('[Anime4KWebExt] Renderer resized for source.');
  }

  /**
   * 根据用户设置（效果或目标分辨率）更新渲染器配置
   * @param options 包含新效果和目标尺寸的对象
   */
  public updateConfiguration(options: { effects: EnhancementEffect[], targetDimensions: Dimensions }): void {
    if (this.destroyed) return;

    const { effects, targetDimensions } = options;

    // 使用JSON字符串比较来检测效果数组是否有实质性变化
    const effectsChanged = JSON.stringify(this.effects) !== JSON.stringify(effects);
    const dimensionsChanged = this.targetDimensions.width !== targetDimensions.width || this.targetDimensions.height !== targetDimensions.height;

    if (!effectsChanged && !dimensionsChanged) {
      console.log('[Anime4KWebExt] Configuration unchanged, skipping pipeline rebuild.');
      return;
    }

    if (dimensionsChanged) {
      console.log(`[Anime4KWebExt] Updating target dimensions to ${targetDimensions.width}x${targetDimensions.height}.`);
      this.targetDimensions = targetDimensions;
    }

    if (effectsChanged) {
      console.log('[Anime4KWebExt] Updating effects.');
      this.effects = effects;
    }

    console.log('[Anime4KWebExt] Rebuilding pipeline due to configuration update.');
    this.buildPipelines();
    this.createRenderBindGroup();
    console.log('[Anime4KWebExt] Renderer configuration updated.');
  }

  /**
   * 销毁渲染器并释放所有 WebGPU 资源。
   * 这是一个关键的清理方法，以防止内存和 GPU 资源泄漏。
   */
  public destroy(): void {
    if (this.destroyed) return;
    // 立即设置销毁标志，以防止任何异步操作（如 device.lost）在销毁过程中执行不必要的操作
    this.destroyed = true;

    // 停止渲染循环
    if (this.animationFrameId) {
      this.video.cancelVideoFrameCallback(this.animationFrameId);
      this.animationFrameId = null;
    }

    // 安全地销毁所有 GPU 资源
    try {
      this.pipelines.forEach(pipeline => {
        if (typeof (pipeline as any).destroy === 'function') {
          (pipeline as any).destroy();
        }
      });
      this.videoFrameTexture?.destroy();
      // 解除画布与GPU设备的关联，这对于后续重新初始化至关重要
      this.context?.unconfigure();
      // 主动销毁设备，这将触发 device.lost Promise
      this.device?.destroy();
      console.log('[Anime4KWebExt] Renderer destroyed.');
    } catch (error) {
      console.error('[Anime4KWebExt] Error during renderer destruction:', error);
    }
  }
}
