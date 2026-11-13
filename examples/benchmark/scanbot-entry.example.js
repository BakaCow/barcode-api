// Optional local wrapper for the package layout documented in COMPARISON.md.
// Copy as scanbot-entry.js beside your extracted package/ directory.
// Supply your own SDK package and runtime license; this file contains neither.
if (!globalThis.ScanbotSDK) {
  await new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = new URL('./package/bundle/ScanbotSDK.min.js', import.meta.url).href;
    script.onload = resolve;
    script.onerror = () => reject(new Error('The locally hosted Scanbot SDK bundle could not be loaded.'));
    document.head.append(script);
  });
}
if (!globalThis.ScanbotSDK) throw new Error('The local bundle did not expose ScanbotSDK.');
export default globalThis.ScanbotSDK;
