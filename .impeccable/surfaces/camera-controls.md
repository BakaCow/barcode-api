# Camera controls and targeting

Mode: Operate.

This extends the existing integration examples and preserves the committed paper/green/ink visual world. A cashier or integrator should expose camera capabilities, select the intended label, and return to scanning without changing the surrounding checkout. The controls remain in a native disclosure below the camera actions, with existing focus and error treatment.

Selected target state must always agree with the SDK. Region suggestions are never styled or announced as confirmed results. Tap mapping must account for contained-video letterboxing; a centre-aim action and full-view reset remain available to keyboard users. Unsupported hardware functions are disabled with explanations. Lifecycle cleanup must remove overlays/listeners and ignore late camera-list updates.

Validation: pure geometry and controls-lifecycle tests plus the root task's bounded desktop/mobile browser review. No physical-phone performance claim is implied.
