# Hosted camera embed

Mode: Operate.

Extend the existing camera and integration examples. Preserve Public Sans, paper/green/ink tokens, native controls, focus treatment and readable secondary type. This is a compact scanner within a host website, with a demo checkout showing the confirmed event entering an exact-match catalogue. No decorative illustration or new visual identity is needed.

The iframe owns its camera preview, explicit start/stop/next controls, confirmation feedback and optional camera/targeting disclosure. The host owns product lookup and business actions. Empty, permission-pending, stopped, confirmed, ambiguous and unavailable-camera states must fit at 320px without overlapping. No camera starts on load. The preview and widget height adapt to the available width; the parent must retain normal document scrolling.

One script installs the camera panel; a separate application event handler connects it to the customer's business logic. Do not imply hosted reloads work offline or that the embed provides accounts, pricing, product data or payment processing.

Verification: exact origin/source/channel message tests, stale/destroyed lifecycle tests, actual worker decoding on simulated camera frames, and bounded desktop/mobile browser review using two local origins. Physical iOS/Android camera permission behavior remains unverified.
