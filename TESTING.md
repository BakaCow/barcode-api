# Verification for the recognition update

Verified on 12 November 2026.

- 51 Python tests pass, covering generation, authentication, upload limits, browser asset serving, actual native-decoder recovery, original coordinate mapping, and bounded retries, including extreme image aspect ratios.
- 49 Node tests pass. These run the shipped WebAssembly decoder on barcode pixels, check retry limits and coordinate mapping, exercise the actual camera loop and frame confirmation, and check offline caching, updates, and partial-cache repair.
- The image worker read 52/64 development barcode images, compared with 40/64 before the update. A separate validation set produced 28/32 reads versus 20/32. All 16 negative images were rejected, with no unexpected results. See [ACCURACY.md](ACCURACY.md) for methodology, timings, limitations, and reproduction commands. These figures do not measure the API or live camera.
- The browser camera loop was exercised with a synthetic video stream containing a low-contrast QR code, a diagonal Code 128, and an inverted EAN-13. All three were confirmed and added to history. The image-import path also decoded the inverted EAN-13 locally. This used an isolated harness containing the shipped app code and test camera controls; the harness is not shipped.
- The shipped app accepted its service-worker update, preserved saved scan history, and reopened with its new scan-policy script after the preview server stopped. Decoder tests separately verify that JavaScript/WASM are loaded locally without external requests.
- During the preceding live/offline release, desktop and 390px layouts, camera stop, simulated permission denial, and image decoding after an offline reload were checked. This update changes scanning logic and guidance without changing the layout.

## Checks still needed on your device

The above does not test your physical camera, autofocus, flashlight, or an installed iPhone/Android home-screen app. Docker deployment was not run locally. It does not establish Scanbot-equivalent speed or accuracy.

1. Deploy over HTTPS and open `/scan/` on your phone.
2. Wait for **Offline ready**, then choose **Start camera** and grant camera permission.
3. Scan actual QR and product labels at different distances and lighting levels.
4. Stop the camera, turn on airplane mode, reopen the same `/scan/` address, and scan again.
5. If you install the app, also open that installed app online once and verify **Offline ready** there before repeating the offline check. Browser and installed-app storage behavior can differ.
6. If cached files have been removed, reconnect and use **How to use it offline → Check offline readiness** to repair the local cache.

The static scanner works offline. The `/v1` HTTP API still needs a server connection.
