// Headless software Chromium can't allocate a WebGPU swap chain: the first present loses the device.
// This init script gives the canvas an ordinary GPU texture instead, so every shader and pipeline
// still runs on real WebGPU, and window.__grab() reads the finished frame back.
export function offscreenCanvas() {
  if (typeof GPUCanvasContext === 'undefined') return;
  const proto = GPUCanvasContext.prototype;
  proto.configure = function (config) {
    this.__config = config;
  };
  proto.unconfigure = () => {};
  proto.getCurrentTexture = function () {
    const { canvas, __config: config } = this;
    if (this.__texture?.width !== canvas.width || this.__texture?.height !== canvas.height) {
      this.__texture?.destroy();
      this.__texture = config.device.createTexture({
        size: [canvas.width, canvas.height],
        format: config.format,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC | GPUTextureUsage.TEXTURE_BINDING,
      });
    }
    return this.__texture;
  };
  /** The last frame as base64 RGBA, row-aligned, with its size. */
  window.__grab = async () => {
    const context = document.querySelector('canvas.viewport').getContext('webgpu');
    const { device, format } = context.__config;
    const texture = context.__texture;
    const { width, height } = texture;
    const bytesPerRow = Math.ceil((width * 4) / 256) * 256;
    const buffer = device.createBuffer({ size: bytesPerRow * height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const encoder = device.createCommandEncoder();
    encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow }, [width, height]);
    device.queue.submit([encoder.finish()]);
    await buffer.mapAsync(GPUMapMode.READ);
    const bytes = new Uint8Array(buffer.getMappedRange()).slice();
    buffer.unmap();
    buffer.destroy();
    const rgba = new Uint8Array(width * height * 4);
    const bgra = format.startsWith('bgra');
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const from = y * bytesPerRow + x * 4;
        const to = (y * width + x) * 4;
        rgba[to] = bytes[from + (bgra ? 2 : 0)];
        rgba[to + 1] = bytes[from + 1];
        rgba[to + 2] = bytes[from + (bgra ? 0 : 2)];
        rgba[to + 3] = 255;
      }
    let text = '';
    for (let i = 0; i < rgba.length; i += 0x8000) text += String.fromCharCode(...rgba.subarray(i, i + 0x8000));
    return { width, height, format, data: btoa(text) };
  };
}

/** A software WebGPU browser: Vulkan through SwiftShader, without the watchdog killing slow shader compiles. */
export const WEBGPU_FLAGS = [
  '--enable-unsafe-webgpu',
  '--enable-features=Vulkan',
  '--use-vulkan=swiftshader',
  '--use-webgpu-adapter=swiftshader',
  '--ignore-gpu-blocklist',
  '--disable-gpu-watchdog',
];
