export async function createWebGpuContext(canvas) {
  if (!navigator.gpu) {
    throw new Error("WebGPU is not available in this browser.");
  }

  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) {
    throw new Error("No compatible WebGPU adapter was found.");
  }

  const device = await adapter.requestDevice();
  const context = canvas.getContext("webgpu");
  const canvasFormat = navigator.gpu.getPreferredCanvasFormat();

  context.configure({
    device,
    format: canvasFormat,
    alphaMode: "opaque",
  });

  return { device, context, canvasFormat };
}

export function resizeCanvasToDisplaySize(canvas) {
  const devicePixelRatio = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.max(1, Math.floor(canvas.clientWidth * devicePixelRatio));
  const height = Math.max(1, Math.floor(canvas.clientHeight * devicePixelRatio));

  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
}
