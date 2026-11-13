/** Synthetic desktop Node measurement of analysis CPU placement, not phone FPS or accuracy. */
import { Worker, isMainThread, parentPort } from 'node:worker_threads';
import { once } from 'node:events';
import Analysis from '../web/frame-analysis.js';

if (!isMainThread) {
  parentPort.on('message', image => {
    const started = performance.now();
    const analysis = Analysis.analyze(image);
    parentPort.postMessage({ image, fingerprint: analysis.fingerprint, computeMs: performance.now() - started }, [image.data]);
  });
} else {
  const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
  const summary = values => ({ medianMs: +median(values).toFixed(3), maxMs: +Math.max(...values).toFixed(3) });
  const results = [];
  const worker = new Worker(new URL(import.meta.url));
  await once(worker, 'online');
  try {
    for (const [width, height] of [[1920, 1080], [2666, 1500]]) {
      const pixels = new Uint8ClampedArray(width * height * 4).fill(255);
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4, value = Math.floor(x / 4) % 2 ? 20 : 240;
        pixels[i] = pixels[i + 1] = pixels[i + 2] = value;
      }
      let image = { width, height, data: pixels.buffer };
      const synchronous = [], dispatch = [], compute = [], roundTrip = [];
      for (let i = 0; i < 15; i++) {
        const start = performance.now(), original = Analysis.analyze(image);
        const directTime = performance.now() - start;
        const response = once(worker, 'message');
        const sending = performance.now(); worker.postMessage(image, [image.data]);
        const dispatchTime = performance.now() - sending;
        const [reply] = await response;
        const elapsed = performance.now() - sending;
        if (reply.fingerprint !== original.fingerprint) throw new Error('Transferred image identity changed.');
        image = reply.image;
        if (i >= 3) {
          synchronous.push(directTime); dispatch.push(dispatchTime); compute.push(reply.computeMs); roundTrip.push(elapsed);
        }
      }
      results.push({ width, height, synchronousMainThread: summary(synchronous), workerDispatchMainThread: summary(dispatch),
        workerCompute: summary(compute), workerRoundTrip: summary(roundTrip) });
    }
  } finally { await worker.terminate(); }
  console.log(JSON.stringify({ runtime: process.version, platform: process.platform, iterations: 15, warmupDiscarded: 3,
    scope: 'Generated stripe images; identical analysis function and transferable buffers. Excludes browser camera capture, bitmap creation, canvas readback, WASM decoding and rendering. Does not measure phone performance or recognition accuracy.', results }, null, 2));
}
