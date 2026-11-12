# Mobile capability simulations

These tests execute the shipped [scanner app](web/app.js), [lab app](web/lab/lab.js), and their real confirmation policies in Node with simulated browser APIs. They exercise the application's camera, recording and lifecycle logic. They do not run Android Chrome, iPhone Safari, WebKit, a mobile emulator, physical cameras, or a cloud device service.

Run the focused suite with Node 22 or newer:

```powershell
node --test tests/mobile-compatibility.test.mjs
```

The latest focused run passed all **35 mobile simulation tests**. Running them together with the existing lab policy suite passed **49 tests**, with zero failures.

## Profiles exercised

| Simulated profile | Supplied capabilities | Recording and frame identity |
| --- | --- | --- |
| Android Chrome-like | Continuous focus/exposure, torch, zoom, working optional constraints | WebM/VP8; presented-frame callbacks |
| iPhone Safari-like | No camera capability method; optional controls unavailable; actual resolution may differ from requested ideals | MP4; decoded-frame counters from `getVideoPlaybackQuality()` |
| Additional failure profiles | Advertised focus/exposure ignored or rejected, camera enumeration unavailable, permission denied or delayed, insecure origin | Missing MediaRecorder, unsupported MIME types, missing canvas captureStream, recorder construction failure, or no reliable frame counters |

These are explicit feature combinations for testing fallback paths, not a compatibility table for particular operating-system or browser versions. Actual browser support varies.

## What the checks cover

Both main profiles run against both applications. The tests dispatch the real UI event handlers and check their effects:

- Camera permission is requested only after a click. Denial displays recovery guidance, and a later permitted retry opens the camera.
- Startup tolerates a delivered resolution different from its request. Missing capabilities hide or disable unavailable controls. The scanner requests advertised continuous focus; the lab requests advertised continuous focus and exposure. Ignored or rejected optional constraints and failed enumeration do not block capture.
- Working torch and zoom controls send constraints to the selected track. Closing the camera, hiding the page, disconnecting the track or leaving the page stops capture. Late permission grants and stale frame callbacks cannot revive a stopped session.
- Both presented-frame callbacks and decoded-frame counters prevent one frame from being counted twice when playback time advances. A second distinct correct frame can confirm the result through the real confirmation policy.
- The lab selects WebM/VP8 or MP4 from the advertised supported types, requests a 15 fps canvas stream and 2.5 Mbps bitrate, prepares a ten-second recording with its entered label, and releases the recording stream. Photo and video metadata retain the entered expected value, group and split.
- Interrupting recording discards the clip and releases its canvas track and timers. Leaving the lab releases prepared-file object URLs.
- Missing recording APIs, missing supported formats, or failed recorder construction leave photo capture available with an explanatory message. A lab without reliable frame counters declines live comparisons while still allowing photographs.

The recorder-construction simulation found a cleanup bug: a canvas stream could remain active when `new MediaRecorder(...)` threw before the lab recorded ownership of that stream. The lab now stops that pending stream on failure. The regression test also verifies that photo capture still works afterward.

## What these results cannot establish

The camera, video element, DOM, canvas, timers, MediaRecorder and worker transport are simulated. Workers return controlled decoded values so the tests can isolate UI and confirmation behavior; these checks do not measure decoder accuracy. Simulated photo/video blobs are placeholders, so MIME negotiation is tested but actual codec output or playback is not. The tests create no real camera dataset and make no network requests.

There is no mobile rendering, actual permission UI, autofocus quality, exposure behavior, camera orientation, recording codec, thermal/battery, browser suspension, installation, service-worker storage eviction or physical airplane-mode validation here. A 35-test pass in this suite means these application control paths behaved correctly under the specified simulations. It does not certify Android/iPhone compatibility or Scanbot-equivalent performance. See [TESTING.md](TESTING.md) for other verification and [CODE128-LAB.md](CODE128-LAB.md) for the collection and measurement workflow.
