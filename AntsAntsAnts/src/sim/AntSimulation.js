import { SIM_CONFIG } from "../config.js";
import { createWebGpuContext, resizeCanvasToDisplaySize } from "../gpu/webgpu.js";
import { antComputeShader } from "../shaders/antComputeShader.js";
import { decayComputeShader, foodTrailDecayComputeShader } from "../shaders/decayComputeShader.js";
import { renderShader } from "../shaders/renderShader.js";

const PARAM_BUFFER_SIZE = 160;
const RENDER_PARAM_BUFFER_SIZE = 32;
const ANT_STRIDE_FLOATS = 8;
const DEFAULT_BRUSH_SIZE = 22;
const FIELD_PIXEL_STRIDE = 4;
const FLOAT_TEXTURE_FORMAT = "rgba16float";
const FLOAT_TEXTURE_BYTES_PER_PIXEL = 8;
const HALF_FLOAT_ONE = 0x3c00;
const MAX_FRAME_DELTA = 0.033;
const MAX_SIMULATION_STEP = 1 / 60;
const MAX_SIMULATION_STEPS_PER_RENDER = 12;
const LEVEL_CACHE_KEY = "lazy-queen-level-editor-death-spray-v1";
const DEFAULT_MAP_URL = new URL("../../DefaultMap/DefaultMap.png", import.meta.url);
const MAP_CHANNEL_THRESHOLD = 127;
const EDITOR_PAINT_TARGETS = new Set(["poison", "food"]);
const RENDER_INTENSITY_KEYS = [
  "death",
  "poison",
  "crowd",
  "trail",
  "food",
  "foodTrail",
  "antsWithoutFood",
  "antsWithFood",
];

export class AntSimulation {
  constructor(canvas, statusElement) {
    this.canvas = canvas;
    this.statusElement = statusElement;
    this.frame = 0;
    this.lastTime = performance.now();
    this.textureIndex = 0;
    this.animationFrame = 0;
    this.nextAntToSpawn = 0;
    this.spawnAccumulator = 0;
    this.targetTimeScale = 1;
    this.editorEnabled = false;
    this.editorPaintTarget = "poison";
    this.brushSize = DEFAULT_BRUSH_SIZE;
    this.isPainting = false;
    this.renderIntensities = {
      death: 1,
      poison: 1,
      crowd: 1,
      trail: 1,
      food: 1,
      foodTrail: 1,
      antsWithoutFood: 1,
      antsWithFood: 1,
    };
  }

  async init() {
    const { device, context, canvasFormat } = await createWebGpuContext(this.canvas);
    this.device = device;
    this.context = context;
    this.canvasFormat = canvasFormat;

    await this.createResources();
    this.createPipelines();
    this.attachEditorInput();
    this.reset();
    this.start();
  }

  reset() {
    this.frame = 0;
    this.textureIndex = 0;
    this.lastTime = performance.now();
    this.nextAntToSpawn = 0;
    this.spawnAccumulator = 0;
    this.device.queue.writeBuffer(this.antBuffer, 0, this.createAntData());
    this.clearFieldTextures();
  }

  setTargetTimeScale(value) {
    this.targetTimeScale = Math.min(6, Math.max(0.25, Number.isFinite(value) ? value : 1));
  }

  start() {
    const tick = (time) => {
      this.animationFrame = requestAnimationFrame(tick);
      this.step(time);
    };

    this.animationFrame = requestAnimationFrame(tick);
  }

  async createResources() {
    const { antCount, fieldWidth, fieldHeight } = SIM_CONFIG;

    this.paramsBuffer = this.device.createBuffer({
      label: "Simulation params",
      size: PARAM_BUFFER_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.renderParamsBuffer = this.device.createBuffer({
      label: "Render intensity params",
      size: RENDER_PARAM_BUFFER_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.writeRenderParams();

    this.antBuffer = this.device.createBuffer({
      label: "Ant storage",
      size: antCount * ANT_STRIDE_FLOATS * Float32Array.BYTES_PER_ELEMENT,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    this.fieldTextures = Array.from({ length: 2 }, (_, index) =>
      this.device.createTexture({
        label: `Pheromone field ${index}`,
        size: [fieldWidth, fieldHeight],
        format: FLOAT_TEXTURE_FORMAT,
        usage:
          GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.STORAGE_BINDING |
          GPUTextureUsage.COPY_DST,
      }),
    );
    this.foodTrailTextures = Array.from({ length: 2 }, (_, index) =>
      this.device.createTexture({
        label: `Food found trail ${index}`,
        size: [fieldWidth, fieldHeight],
        format: FLOAT_TEXTURE_FORMAT,
        usage:
          GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.STORAGE_BINDING |
          GPUTextureUsage.COPY_DST,
      }),
    );

    this.deathSprayTexture = this.createPaintTexture("Painted death spray");
    this.foodTexture = this.createPaintTexture("Painted food");
    this.deathSprayData = new Uint8Array(fieldWidth * fieldHeight * FIELD_PIXEL_STRIDE);
    this.foodData = new Uint8Array(fieldWidth * fieldHeight * FIELD_PIXEL_STRIDE);
    await this.loadDefaultLevel();
    this.loadCachedLevel();

    this.sampler = this.device.createSampler({
      magFilter: "linear",
      minFilter: "linear",
    });
  }

  createPaintTexture(label) {
    return this.device.createTexture({
      label,
      size: [SIM_CONFIG.fieldWidth, SIM_CONFIG.fieldHeight],
      format: FLOAT_TEXTURE_FORMAT,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
  }

  createPipelines() {
    this.decayPipeline = this.device.createComputePipeline({
      label: "Pheromone decay pipeline",
      layout: "auto",
      compute: {
        module: this.device.createShaderModule({ code: decayComputeShader }),
        entryPoint: "main",
      },
    });

    this.foodTrailDecayPipeline = this.device.createComputePipeline({
      label: "Food trail decay pipeline",
      layout: "auto",
      compute: {
        module: this.device.createShaderModule({ code: foodTrailDecayComputeShader }),
        entryPoint: "main",
      },
    });

    this.antPipeline = this.device.createComputePipeline({
      label: "Ant update pipeline",
      layout: "auto",
      compute: {
        module: this.device.createShaderModule({ code: antComputeShader }),
        entryPoint: "main",
      },
    });

    this.renderPipeline = this.device.createRenderPipeline({
      label: "Field render pipeline",
      layout: "auto",
      vertex: {
        module: this.device.createShaderModule({ code: renderShader }),
        entryPoint: "vertexMain",
      },
      fragment: {
        module: this.device.createShaderModule({ code: renderShader }),
        entryPoint: "fragmentMain",
        targets: [{ format: this.canvasFormat }],
      },
      primitive: {
        topology: "triangle-list",
      },
    });
  }

  step(time) {
    resizeCanvasToDisplaySize(this.canvas);

    if (this.editorEnabled) {
      this.lastTime = time;
      const encoder = this.device.createCommandEncoder({ label: "Editor frame" });
      this.runRenderPass(encoder, this.fieldTextures[this.textureIndex], this.foodTrailTextures[this.textureIndex]);
      this.device.queue.submit([encoder.finish()]);
      this.statusElement.textContent = `Level editor paused. Paint ${this.editorPaintTarget} on the field.`;
      return;
    }

    const realDeltaTime = Math.min((time - this.lastTime) / 1000, MAX_FRAME_DELTA);
    this.lastTime = time;
    const scaledDeltaTime = realDeltaTime * this.targetTimeScale;
    const stepCount = Math.max(
      1,
      Math.min(MAX_SIMULATION_STEPS_PER_RENDER, Math.ceil(scaledDeltaTime / MAX_SIMULATION_STEP)),
    );
    const deltaTime = scaledDeltaTime / stepCount;

    for (let step = 0; step < stepCount; step += 1) {
      this.runSimulationStep(deltaTime);
    }

    const encoder = this.device.createCommandEncoder({ label: "Render frame" });
    this.runRenderPass(
      encoder,
      this.fieldTextures[this.textureIndex],
      this.foodTrailTextures[this.textureIndex],
    );
    this.device.queue.submit([encoder.finish()]);
    this.statusElement.textContent =
      `Spawned ${this.nextAntToSpawn.toLocaleString()} / ${SIM_CONFIG.antCount.toLocaleString()} ants`;
  }

  runSimulationStep(deltaTime) {
    this.frame += 1;
    this.spawnAnts(deltaTime);
    this.writeParams(deltaTime);

    const sourceTexture = this.fieldTextures[this.textureIndex];
    const destinationTexture = this.fieldTextures[1 - this.textureIndex];
    const foodTrailSourceTexture = this.foodTrailTextures[this.textureIndex];
    const foodTrailDestinationTexture = this.foodTrailTextures[1 - this.textureIndex];
    const encoder = this.device.createCommandEncoder({ label: "Simulation frame" });

    this.runFieldDecayPass(encoder, sourceTexture, destinationTexture, foodTrailSourceTexture);
    this.runDecayPass(
      encoder,
      foodTrailSourceTexture,
      foodTrailDestinationTexture,
      this.foodTrailDecayPipeline,
    );
    this.runAntPass(
      encoder,
      sourceTexture,
      destinationTexture,
      foodTrailSourceTexture,
      foodTrailDestinationTexture,
    );

    this.textureIndex = 1 - this.textureIndex;
    this.device.queue.submit([encoder.finish()]);
  }

  runFieldDecayPass(encoder, sourceTexture, destinationTexture, foodTrailTexture) {
    const bindGroup = this.device.createBindGroup({
      layout: this.decayPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: sourceTexture.createView() },
        { binding: 1, resource: destinationTexture.createView() },
        { binding: 2, resource: { buffer: this.paramsBuffer } },
        { binding: 3, resource: foodTrailTexture.createView() },
      ],
    });

    const pass = encoder.beginComputePass({ label: "Decay pheromones" });
    pass.setPipeline(this.decayPipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(Math.ceil(SIM_CONFIG.fieldWidth / 8), Math.ceil(SIM_CONFIG.fieldHeight / 8));
    pass.end();
  }

  runDecayPass(encoder, sourceTexture, destinationTexture, pipeline) {
    const bindGroup = this.device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: sourceTexture.createView() },
        { binding: 1, resource: destinationTexture.createView() },
        { binding: 2, resource: { buffer: this.paramsBuffer } },
      ],
    });

    const pass = encoder.beginComputePass({ label: "Decay pheromones" });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(Math.ceil(SIM_CONFIG.fieldWidth / 8), Math.ceil(SIM_CONFIG.fieldHeight / 8));
    pass.end();
  }

  runAntPass(
    encoder,
    sourceTexture,
    destinationTexture,
    foodTrailSourceTexture,
    foodTrailDestinationTexture,
  ) {
    const bindGroup = this.device.createBindGroup({
      layout: this.antPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.antBuffer } },
        { binding: 1, resource: sourceTexture.createView() },
        { binding: 2, resource: destinationTexture.createView() },
        { binding: 3, resource: { buffer: this.paramsBuffer } },
        { binding: 4, resource: this.deathSprayTexture.createView() },
        { binding: 5, resource: this.foodTexture.createView() },
        { binding: 6, resource: foodTrailSourceTexture.createView() },
        { binding: 7, resource: foodTrailDestinationTexture.createView() },
      ],
    });

    const pass = encoder.beginComputePass({ label: "Move ants" });
    pass.setPipeline(this.antPipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(Math.ceil(SIM_CONFIG.antCount / 128));
    pass.end();
  }

  runRenderPass(encoder, fieldTexture, foodTrailTexture) {
    const bindGroup = this.device.createBindGroup({
      layout: this.renderPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: this.sampler },
        { binding: 1, resource: fieldTexture.createView() },
        { binding: 2, resource: this.deathSprayTexture.createView() },
        { binding: 3, resource: this.foodTexture.createView() },
        { binding: 4, resource: { buffer: this.renderParamsBuffer } },
        { binding: 5, resource: foodTrailTexture.createView() },
      ],
    });

    const pass = encoder.beginRenderPass({
      label: "Render field",
      colorAttachments: [
        {
          view: this.context.getCurrentTexture().createView(),
          loadOp: "clear",
          clearValue: { r: 0.01, g: 0.015, b: 0.025, a: 1 },
          storeOp: "store",
        },
      ],
    });

    pass.setPipeline(this.renderPipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(3);
    pass.end();
  }

  writeParams(deltaTime) {
    const buffer = new ArrayBuffer(PARAM_BUFFER_SIZE);
    const view = new DataView(buffer);
    view.setFloat32(0, SIM_CONFIG.fieldWidth, true);
    view.setFloat32(4, SIM_CONFIG.fieldHeight, true);
    view.setUint32(8, SIM_CONFIG.antCount, true);
    view.setUint32(12, this.frame, true);
    view.setFloat32(16, SIM_CONFIG.sensorDistance, true);
    view.setFloat32(20, SIM_CONFIG.sensorAngle, true);
    view.setFloat32(24, SIM_CONFIG.turnSpeed, true);
    view.setFloat32(28, SIM_CONFIG.moveSpeed, true);
    view.setFloat32(32, SIM_CONFIG.trailDeposit, true);
    view.setFloat32(36, SIM_CONFIG.crowdDeposit, true);
    view.setFloat32(40, SIM_CONFIG.deathDeposit, true);
    view.setFloat32(44, SIM_CONFIG.trailDecay, true);
    view.setFloat32(48, SIM_CONFIG.trailDiffusion, true);
    view.setFloat32(52, SIM_CONFIG.crowdDecay, true);
    view.setFloat32(56, SIM_CONFIG.crowdDiffusion, true);
    view.setFloat32(60, SIM_CONFIG.deathDecay, true);
    view.setFloat32(64, SIM_CONFIG.deathDiffusion, true);
    view.setFloat32(68, SIM_CONFIG.minTrailFollow, true);
    view.setFloat32(72, SIM_CONFIG.minCrowdAvoid, true);
    view.setFloat32(76, deltaTime, true);
    view.setFloat32(80, SIM_CONFIG.fieldWidth * SIM_CONFIG.anthillX, true);
    view.setFloat32(84, SIM_CONFIG.fieldHeight * SIM_CONFIG.anthillY, true);
    view.setFloat32(88, SIM_CONFIG.anthillRadius, true);
    view.setFloat32(92, SIM_CONFIG.spawnAngleVariation, true);
    view.setFloat32(96, SIM_CONFIG.deathAvoidStrength, true);
    view.setFloat32(100, SIM_CONFIG.minDeathAvoid, true);
    view.setFloat32(104, SIM_CONFIG.foodTrailDeposit, true);
    view.setFloat32(108, SIM_CONFIG.foodTrailFollowStrength, true);
    view.setFloat32(112, SIM_CONFIG.homePullStrength, true);
    view.setFloat32(116, SIM_CONFIG.foodPickupThreshold, true);
    view.setFloat32(120, SIM_CONFIG.foodTrailCarryFullStrengthTime, true);
    view.setFloat32(124, SIM_CONFIG.foodTrailCarryFalloff, true);
    view.setFloat32(128, SIM_CONFIG.foodTrailMinCarryDepositRatio, true);
    view.setFloat32(132, SIM_CONFIG.sensorSize, true);
    view.setFloat32(136, SIM_CONFIG.trailAttractionStrength, true);
    view.setFloat32(140, SIM_CONFIG.crowdAvoidStrength, true);
    view.setFloat32(144, SIM_CONFIG.foodTrailDecay, true);
    view.setFloat32(148, SIM_CONFIG.foodTrailDiffusion, true);
    view.setFloat32(152, SIM_CONFIG.clearOtherTrails, true);

    this.device.queue.writeBuffer(this.paramsBuffer, 0, buffer);
  }

  createAntData() {
    const data = new Float32Array(SIM_CONFIG.antCount * ANT_STRIDE_FLOATS);
    const anthill = this.getAnthillPosition();

    for (let index = 0; index < SIM_CONFIG.antCount; index += 1) {
      const offset = index * ANT_STRIDE_FLOATS;
      data[offset] = anthill.x;
      data[offset + 1] = anthill.y;
      data[offset + 2] = Math.PI;
      data[offset + 3] = 0;
      data[offset + 4] = 0;
    }

    return data;
  }

  spawnAnts(deltaTime) {
    if (this.nextAntToSpawn >= SIM_CONFIG.antCount) {
      return;
    }

    this.spawnAccumulator += SIM_CONFIG.spawnRate * deltaTime;
    const spawnCount = Math.min(
      Math.floor(this.spawnAccumulator),
      SIM_CONFIG.antCount - this.nextAntToSpawn,
    );

    if (spawnCount === 0) {
      return;
    }

    this.spawnAccumulator -= spawnCount;
    const spawnedAnts = new Float32Array(spawnCount * ANT_STRIDE_FLOATS);
    const anthill = this.getAnthillPosition();

    for (let index = 0; index < spawnCount; index += 1) {
      const spawnAngle = Math.random() * Math.PI * 2;
      const spawnRadius = Math.sqrt(Math.random()) * SIM_CONFIG.anthillRadius;
      const offset = index * ANT_STRIDE_FLOATS;
      spawnedAnts[offset] = anthill.x + Math.cos(spawnAngle) * spawnRadius;
      spawnedAnts[offset + 1] = anthill.y + Math.sin(spawnAngle) * spawnRadius;
      spawnedAnts[offset + 2] =
        Math.PI + (Math.random() - 0.5) * SIM_CONFIG.spawnAngleVariation;
      spawnedAnts[offset + 3] = 1;
      spawnedAnts[offset + 4] = 0;
    }

    this.device.queue.writeBuffer(
      this.antBuffer,
      this.nextAntToSpawn * ANT_STRIDE_FLOATS * Float32Array.BYTES_PER_ELEMENT,
      spawnedAnts,
    );
    this.nextAntToSpawn += spawnCount;
  }

  getAnthillPosition() {
    return {
      x: SIM_CONFIG.fieldWidth * SIM_CONFIG.anthillX,
      y: SIM_CONFIG.fieldHeight * SIM_CONFIG.anthillY,
    };
  }

  setEditorEnabled(isEnabled) {
    this.editorEnabled = isEnabled;
    this.isPainting = false;
    this.lastTime = performance.now();
    this.canvas.classList.toggle("is-editing", isEnabled);
    return this.editorEnabled;
  }

  setBrushSize(size) {
    this.brushSize = Math.max(1, size);
  }

  setEditorPaintTarget(target) {
    if (!EDITOR_PAINT_TARGETS.has(target)) {
      return this.editorPaintTarget;
    }

    this.editorPaintTarget = target;
    return this.editorPaintTarget;
  }

  setRenderIntensity(key, value) {
    if (!RENDER_INTENSITY_KEYS.includes(key)) {
      return;
    }

    this.renderIntensities[key] = Math.max(0, value);
    this.writeRenderParams();
  }

  writeRenderParams() {
    if (!this.renderParamsBuffer) {
      return;
    }

    const data = new Float32Array(RENDER_PARAM_BUFFER_SIZE / Float32Array.BYTES_PER_ELEMENT);
    data[0] = this.renderIntensities.death;
    data[1] = this.renderIntensities.poison;
    data[2] = this.renderIntensities.crowd;
    data[3] = this.renderIntensities.trail;
    data[4] = this.renderIntensities.food;
    data[5] = this.renderIntensities.foodTrail;
    data[6] = this.renderIntensities.antsWithoutFood;
    data[7] = this.renderIntensities.antsWithFood;
    this.device.queue.writeBuffer(this.renderParamsBuffer, 0, data);
  }

  setConfigValue(key, value) {
    if (!Object.hasOwn(SIM_CONFIG, key)) {
      return;
    }

    SIM_CONFIG[key] = value;
  }

  attachEditorInput() {
    this.canvas.addEventListener("pointerdown", (event) => {
      if (!this.editorEnabled) {
        return;
      }

      event.preventDefault();
      this.isPainting = true;
      this.canvas.setPointerCapture(event.pointerId);
      this.paintCurrentMap(event);
    });

    this.canvas.addEventListener("pointermove", (event) => {
      if (!this.editorEnabled || !this.isPainting) {
        return;
      }

      event.preventDefault();
      this.paintCurrentMap(event);
    });

    const stopPainting = (event) => {
      if (!this.isPainting) {
        return;
      }

      this.isPainting = false;
      this.persistLevel();
      if (this.canvas.hasPointerCapture(event.pointerId)) {
        this.canvas.releasePointerCapture(event.pointerId);
      }
    };

    this.canvas.addEventListener("pointerup", stopPainting);
    this.canvas.addEventListener("pointercancel", stopPainting);
    this.canvas.addEventListener("pointerleave", () => {
      if (this.isPainting) {
        this.persistLevel();
      }
      this.isPainting = false;
    });
  }

  paintCurrentMap(event) {
    const position = this.getFieldPosition(event);
    const radius = this.brushSize;
    const radiusSquared = radius * radius;
    const startX = Math.max(0, Math.floor(position.x - radius));
    const endX = Math.min(SIM_CONFIG.fieldWidth - 1, Math.ceil(position.x + radius));
    const startY = Math.max(0, Math.floor(position.y - radius));
    const endY = Math.min(SIM_CONFIG.fieldHeight - 1, Math.ceil(position.y + radius));

    for (let y = startY; y <= endY; y += 1) {
      for (let x = startX; x <= endX; x += 1) {
        const dx = x - position.x;
        const dy = y - position.y;

        if (dx * dx + dy * dy > radiusSquared) {
          continue;
        }

        this.paintPixel(this.editorPaintTarget, y * SIM_CONFIG.fieldWidth + x);
      }
    }

    this.uploadPaintMap(this.editorPaintTarget);
  }

  paintPixel(target, pixel) {
    const data = this.getPaintData(target);
    const offset = pixel * FIELD_PIXEL_STRIDE;
    data[offset] = 255;
    data[offset + 1] = target === "food" ? 255 : 0;
    data[offset + 2] = target === "food" ? 255 : 0;
    data[offset + 3] = 255;
  }

  getFieldPosition(event) {
    const bounds = this.canvas.getBoundingClientRect();
    return {
      x: ((event.clientX - bounds.left) / bounds.width) * SIM_CONFIG.fieldWidth,
      y: ((event.clientY - bounds.top) / bounds.height) * SIM_CONFIG.fieldHeight,
    };
  }

  clearDeathSpray() {
    this.clearPaintMap("poison");
  }

  clearFood() {
    this.clearPaintMap("food");
  }

  clearPaintMap(target) {
    const data = this.getPaintData(target);
    if (!data) {
      return;
    }

    data.fill(0);
    this.uploadPaintMap(target);
    this.persistLevel();
  }

  getPaintData(target) {
    return target === "food" ? this.foodData : this.deathSprayData;
  }

  getPaintTexture(target) {
    return target === "food" ? this.foodTexture : this.deathSprayTexture;
  }

  uploadPaintMap(target) {
    const texture = this.getPaintTexture(target);
    const data = this.getPaintData(target);
    if (!texture || !data) {
      return;
    }

    const uploadData = new Uint16Array(data.length);
    for (let index = 0; index < data.length; index += 1) {
      uploadData[index] = data[index] > 0 ? HALF_FLOAT_ONE : 0;
    }

    this.device.queue.writeTexture(
      { texture },
      uploadData,
      { bytesPerRow: SIM_CONFIG.fieldWidth * FLOAT_TEXTURE_BYTES_PER_PIXEL, rowsPerImage: SIM_CONFIG.fieldHeight },
      [SIM_CONFIG.fieldWidth, SIM_CONFIG.fieldHeight],
    );
  }

  async loadDefaultLevel() {
    if (!this.deathSprayData || !this.foodData) {
      return;
    }

    try {
      const response = await fetch(DEFAULT_MAP_URL, { cache: "no-store" });

      if (!response.ok) {
        return;
      }

      await this.loadPngLevel(await response.blob());
    } catch (error) {
      if (location.protocol !== "file:") {
        console.warn("Could not load default level map.", error);
      }
    }
  }

  loadCachedLevel() {
    if (!this.deathSprayData || !this.foodData) {
      return;
    }

    try {
      const cachedLevel = localStorage.getItem(LEVEL_CACHE_KEY);

      if (!cachedLevel) {
        return;
      }

      this.loadLevel(JSON.parse(cachedLevel));
    } catch (error) {
      console.warn("Could not restore cached level editor spray.", error);
    }
  }

  loadLevel(level) {
    const expectedPixelCount = SIM_CONFIG.fieldWidth * SIM_CONFIG.fieldHeight;
    if (
      level.width !== SIM_CONFIG.fieldWidth ||
      level.height !== SIM_CONFIG.fieldHeight ||
      (typeof level.mask !== "string" && typeof level.poisonMask !== "string")
    ) {
      return false;
    }

    this.deathSprayData.fill(0);
    this.foodData.fill(0);
    this.loadMaskIntoMap(level.poisonMask ?? level.mask, "poison", expectedPixelCount);
    if (typeof level.foodMask === "string") {
      this.loadMaskIntoMap(level.foodMask, "food", expectedPixelCount);
    }

    this.uploadPaintMap("poison");
    this.uploadPaintMap("food");
    return true;
  }

  async loadPngLevel(blob) {
    const image = await this.loadImageFromBlob(blob);
    if (image.width !== SIM_CONFIG.fieldWidth || image.height !== SIM_CONFIG.fieldHeight) {
      if (typeof image.close === "function") {
        image.close();
      }
      return false;
    }

    const canvas = document.createElement("canvas");
    canvas.width = SIM_CONFIG.fieldWidth;
    canvas.height = SIM_CONFIG.fieldHeight;
    const context = canvas.getContext("2d");
    context.drawImage(image, 0, 0);
    if (typeof image.close === "function") {
      image.close();
    }

    const pixels = context.getImageData(0, 0, SIM_CONFIG.fieldWidth, SIM_CONFIG.fieldHeight).data;
    this.deathSprayData.fill(0);
    this.foodData.fill(0);

    for (let pixel = 0; pixel < SIM_CONFIG.fieldWidth * SIM_CONFIG.fieldHeight; pixel += 1) {
      const offset = pixel * FIELD_PIXEL_STRIDE;
      const alpha = pixels[offset + 3];

      if (alpha === 0) {
        continue;
      }

      if (pixels[offset] > MAP_CHANNEL_THRESHOLD) {
        this.paintPixel("poison", pixel);
      }

      if (pixels[offset + 1] > MAP_CHANNEL_THRESHOLD) {
        this.paintPixel("food", pixel);
      }
    }

    this.uploadPaintMap("poison");
    this.uploadPaintMap("food");
    return true;
  }

  loadImageFromBlob(blob) {
    if ("createImageBitmap" in window) {
      return createImageBitmap(blob);
    }

    return new Promise((resolve, reject) => {
      const image = new Image();
      const url = URL.createObjectURL(blob);

      image.addEventListener("load", () => {
        URL.revokeObjectURL(url);
        resolve(image);
      }, { once: true });
      image.addEventListener("error", () => {
        URL.revokeObjectURL(url);
        reject(new Error("Could not decode map PNG."));
      }, { once: true });
      image.src = url;
    });
  }

  loadMaskIntoMap(encodedMask, target, expectedPixelCount) {
    const mask = this.base64ToBytes(encodedMask);

    for (let pixel = 0; pixel < expectedPixelCount; pixel += 1) {
      if ((mask[pixel >> 3] & (1 << (pixel & 7))) === 0) {
        continue;
      }

      this.paintPixel(target, pixel);
    }
  }

  persistLevel() {
    try {
      localStorage.setItem(LEVEL_CACHE_KEY, JSON.stringify(this.createLevelSnapshot()));
    } catch (error) {
      console.warn("Could not cache level editor spray.", error);
    }
  }

  createLevelSnapshot() {
    const pixelCount = SIM_CONFIG.fieldWidth * SIM_CONFIG.fieldHeight;

    return {
      width: SIM_CONFIG.fieldWidth,
      height: SIM_CONFIG.fieldHeight,
      poisonMask: this.bytesToBase64(this.createMaskFromMap("poison", pixelCount)),
      foodMask: this.bytesToBase64(this.createMaskFromMap("food", pixelCount)),
    };
  }

  createLevelPngBlob() {
    const canvas = document.createElement("canvas");
    canvas.width = SIM_CONFIG.fieldWidth;
    canvas.height = SIM_CONFIG.fieldHeight;
    const context = canvas.getContext("2d");
    const image = context.createImageData(SIM_CONFIG.fieldWidth, SIM_CONFIG.fieldHeight);
    const pixelCount = SIM_CONFIG.fieldWidth * SIM_CONFIG.fieldHeight;

    for (let pixel = 0; pixel < pixelCount; pixel += 1) {
      const offset = pixel * FIELD_PIXEL_STRIDE;
      const poisonPainted = this.deathSprayData[offset + 3] > 0;
      const foodPainted = this.foodData[offset + 3] > 0;

      if (!poisonPainted && !foodPainted) {
        continue;
      }

      image.data[offset] = poisonPainted ? 255 : 0;
      image.data[offset + 1] = foodPainted ? 255 : 0;
      image.data[offset + 2] = 0;
      image.data[offset + 3] = 255;
    }

    context.putImageData(image, 0, 0);

    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) {
          resolve(blob);
          return;
        }

        reject(new Error("Could not encode map PNG."));
      }, "image/png");
    });
  }

  createMaskFromMap(target, pixelCount) {
    const data = this.getPaintData(target);
    const mask = new Uint8Array(Math.ceil(pixelCount / 8));

    for (let pixel = 0; pixel < pixelCount; pixel += 1) {
      const alphaOffset = pixel * FIELD_PIXEL_STRIDE + 3;
      if (data[alphaOffset] === 0) {
        continue;
      }

      mask[pixel >> 3] |= 1 << (pixel & 7);
    }

    return mask;
  }

  bytesToBase64(bytes) {
    let binary = "";
    const chunkSize = 0x8000;

    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      const chunk = bytes.subarray(offset, offset + chunkSize);
      binary += String.fromCharCode(...chunk);
    }

    return btoa(binary);
  }

  base64ToBytes(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);

    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }

    return bytes;
  }

  clearFieldTextures() {
    const emptyField = new Uint8Array(
      SIM_CONFIG.fieldWidth * SIM_CONFIG.fieldHeight * FLOAT_TEXTURE_BYTES_PER_PIXEL,
    );

    for (const texture of [...this.fieldTextures, ...this.foodTrailTextures]) {
      this.device.queue.writeTexture(
        { texture },
        emptyField,
        { bytesPerRow: SIM_CONFIG.fieldWidth * FLOAT_TEXTURE_BYTES_PER_PIXEL, rowsPerImage: SIM_CONFIG.fieldHeight },
        [SIM_CONFIG.fieldWidth, SIM_CONFIG.fieldHeight],
      );
    }
  }
}
