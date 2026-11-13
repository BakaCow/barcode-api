---
name: Barcode Camera
description: A clear, camera-first utility for reading codes on the device.
colors:
  paper: "#f3f5ef"
  white: "#ffffff"
  ink: "#142d28"
  secondary: "#52675e"
  line: "#d4ddd3"
  green: "#226748"
  green-dark: "#184d35"
  mint: "#b7efc8"
  muted-surface: "#e7ede4"
  error: "#8d2e24"
  error-bg: "#fff0e9"
  focus: "#477bdf"
typography:
  headline:
    fontFamily: "Public Sans, system-ui, sans-serif"
    fontSize: "36px"
    fontWeight: 650
    lineHeight: 1.15
    letterSpacing: "-0.035em"
  title:
    fontFamily: "Public Sans, system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 650
    letterSpacing: "-0.015em"
  body:
    fontFamily: "Public Sans, system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.5
  button:
    fontFamily: "Public Sans, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 600
    lineHeight: 1.25
rounded:
  label: "4px"
  field: "6px"
  control: "9px"
  panel: "14px"
spacing:
  small: "8px"
  medium: "16px"
  large: "24px"
  page: "40px"
components:
  button-primary:
    backgroundColor: "{colors.green}"
    textColor: "{colors.white}"
    typography: "{typography.button}"
    rounded: "{rounded.control}"
    padding: "12px 17px"
  button-secondary:
    backgroundColor: "{colors.white}"
    textColor: "{colors.ink}"
    typography: "{typography.button}"
    rounded: "{rounded.control}"
    padding: "12px 17px"
  format-label:
    backgroundColor: "{colors.muted-surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.label}"
    padding: "4px 7px"
  results-panel:
    backgroundColor: "{colors.white}"
    textColor: "{colors.ink}"
    rounded: "{rounded.panel}"
    padding: "24px"
  camera-field:
    backgroundColor: "{colors.white}"
    textColor: "{colors.ink}"
    rounded: "{rounded.field}"
    padding: "8px"
---

# Design System: Barcode Camera

## Overview

**Creative North Star: "Quiet utility"**

A restrained, legible interface that gives the camera and decoded values priority. Pale green paper surrounds a dark camera surface; green actions and mint scan outlines make the active operation easy to identify. The shipped interface uses this system on phone and desktop.

**Key Characteristics:**

- Clear controls and readable results.
- Flat surfaces with soft corners and thin dividers.
- Visible readiness, permission, empty, scanning, and error states.

## Colors

Green is the primary action and ready-state color; its darker variant is the hover state. Mint marks detected codes and active controls. Paper, white, ink, secondary text, and line colors separate the work area without decorative gradients. Error foreground and surface colors carry recoverable failures. The blue focus outline remains distinct from scan feedback.

## Typography

Public Sans is self-hosted for offline use. Headings use a compact weight and restrained negative tracking; body text and labels use the same family. The main headline steps down to 30px at the tablet breakpoint and 29px on phones. Decoded values use 21px text, wrap long payloads, and become 20px on phones. Data counts use tabular numerals.

## Layout

The page is capped at 1280px. Desktop uses a two-column workspace with a larger camera column, a 34px gap, and 40px page padding. At 900px the gap becomes 20px and side padding becomes 24px. At 680px the workspace stacks, side padding becomes 20px, and camera controls remain at least 48px high. Results follow the scanner in document order. Help remains a compact disclosure below the preferences.

## Elevation & Depth

There are no box shadows. Tonal contrast, a thin results-panel border, and section dividers establish depth. Live camera status text uses a translucent dark backing so it remains readable over video.

## Shapes

Large camera and results surfaces share gently rounded panel corners. Buttons use smaller control corners; compact labels and fields are tighter. Icons use consistent outline strokes. The viewfinder is simple scanner geometry rather than illustration.

## Components

Primary actions use green and white; secondary actions use white, a thin line border, and a muted hover fill. Disabled controls visibly reduce opacity and use the unavailable cursor. Focusable controls use a 3px blue outline with 4px offset. Button color transitions last 150ms; reduced-motion mode removes transitions.

The camera stage contains the preview, detected-code outlines, state labels, and the initial permission explanation. Result and history areas preserve arbitrary payload text, distinguish format from value, and expose explicit copy/export actions. Camera selection and zoom appear only when applicable. Status and errors use live-region semantics; the skip link provides direct access to the scanner.

## Live POS controls

The regular scanner places an optional POS-mode checkbox above the camera. A nearby new-scan action clears the current attempt, while an inline status beneath the toolbar explains confirmation or conflicts. A Scanning options disclosure holds frame-selection and region-retry toggles plus the POS format and confirmation controls. Existing paper/green colors, focus outlines and native inputs are preserved. Format checkboxes use two columns; the confirmation selector fills the phone width. The results panel keeps its natural height when the disclosure expands.

## Experimental lab flow

The Code 128 lab reuses the same self-hosted typography, paper and green palette, camera surface, buttons, field styling and focus treatment. An Experimental label identifies its scope and a persistent Back to scanner link returns to the regular app. The wider desktop layout pairs capture controls with label details, then places comparison results below; phone layouts stack these sections in the same reading order.

The primary sequence is open camera, enter a known value and group, capture a sample, then save its media and label file. Dataset split, device and conditions stay visible next to the value. Prepared samples show explicit download actions and a notice that unsaved files disappear on leaving. Collection does not silently accept a scanner prediction as the expected value.

A separate Start comparison action begins a bounded trial with label details locked. The results table aligns the custom engine and ZXing by measurement, retains misses and wrong readings, and exposes report download. Empty, loading, camera-off, recording, comparison and offline-readiness states use plain text. Long barcode values wrap, tables scroll within their container on phones, and errors remain actionable. Timing and experimental limits are explained beside the measurements without interrupting the capture flow.

## Do's and Don'ts

- **Do** use the established green, paper, and ink roles consistently.
- **Do** preserve keyboard focus, long-value wrapping, and phone-sized controls.
- **Do** distinguish cached offline readiness from network connectivity.
- **Don't** hide camera or decoding errors behind decorative feedback.
- **Don't** introduce remote fonts or assets that bypass the offline bundle.
- **Don't** turn scanned text into an automatically opened URL.
