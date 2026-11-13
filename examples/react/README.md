# React camera example

Version 0.9.0 includes the reusable **Camera and targeting** controls. Flashlight and zoom are enabled only when the active camera/browser exposes them; camera choice, capture detail and adaptive frame selection use the SDK's public methods. Use **Aim at centre**, tap an area in the contained video, or choose **Scan full view**. Suggestions are possible barcode regions, not confirmed results. Conflicts inside the selected target still reject the scan.

This runnable React/Vite app uses the local camera SDK. It needs no API key or Python server. Keep this directory inside the source project for the asset-copy script.

Use Node 22.12 or newer. From the project root:

```powershell
cd examples/react
npm install
npm run dev
```

Open the localhost address Vite prints. Start the camera explicitly. Two distinct matching frames confirm a result by default. Choose **Scan another** for the next intentional scan. **Unmount scanner** demonstrates releasing the worker and camera; remounting creates a fresh controller. The demo runs React StrictMode.

To create a static deployment:

```powershell
npm run build
npm run preview
```

Deploy the contents of `dist/` on HTTPS, preserving the `scanner-assets/` files. The build copies the SDK, worker, local WebAssembly engine, styles and third-party notices; it never copies server secrets. `base: './'` supports deployment below a path. Camera access over a plain HTTP phone LAN address will not work; use HTTPS on the phone or localhost on that device.

`src/BarcodeScanner.jsx` is the reusable component. Supply `onScan`, optional `formats`, `confirmationFrames`, and an absolute `assetBaseUrl` ending in `/` when assets live somewhere else. Worker assets should be served from the same origin as the page. Updates to the callback do not recreate the scanner. Option changes reset confirmation evidence. Cleanup cancels an unfinished module load and destroys the controller, including when React StrictMode probes setup/cleanup in development.

The callback receives `{ scanId, text, format, bytesBase64, position }`. Do an exact lookup in your own catalogue and persist transaction idempotency on your backend. A confirmed value is not a verified product or a transaction. Keep API secrets on your backend; the camera SDK does not need one.

This example does not install a service worker. Offline integration requires your application's cache to include its app shell and all copied scanner assets. Offline product lookup, payment and synchronization are separate business workflows.

The component lifecycle follows [React's effect cleanup guidance](https://react.dev/reference/react/useEffect); the build uses [Vite](https://vite.dev/guide/). Neither this example nor simulations establish actual Android/iPhone camera performance.
