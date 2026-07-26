# TV Remote Widget for Homey

A Homey dashboard widget with a proper remote control layout for an Android TV
— a touchpad instead of an endless scrolling list of buttons.

## Why

The excellent [Android TV app](https://github.com/drenso/homey-android-tv)
exposes 39 separate capabilities and defines no tile layout of its own, so
Homey falls back to a generic list: six buttons per screen, and scrolling for
the rest. That is fine for flows, but poor for actually operating a
television.

This widget does not reimplement anything. It simply drives the capabilities
of the device that app already created, through Homey's own API — so there is
no protocol work, no pairing, and no licence entanglement.

## Layout

- Power, mute, volume down, volume up
- A touchpad: swipe to move through menus, tap to confirm. Dragging further
  keeps stepping, so long lists scroll naturally.
- Back, Exit, and an info button
- Previous and Next

## Key mapping

Android TV has no dedicated *exit* or *info* key, and the Android TV app does
not expose one either. The nearest real keys are used instead:

| Button | Sends |
|---|---|
| Exit | `key_home` — leaves the running app |
| ⓘ | `key_options` — the contextual options/menu key |

Everything else maps one-to-one onto the device's own capabilities.

## Requirements

- Homey firmware 12.3 or newer (widgets)
- The Android TV app installed, with a paired television

The widget finds the television by itself: it picks the first device from the
Android TV app. With one television in the house there is nothing to
configure.

## Credits and licensing

The code in this repository is **[MIT](LICENSE)** licensed and was written
from scratch. Two things it builds on deserve a precise word, because their
terms differ:

- **[drenso/homey-android-tv](https://github.com/drenso/homey-android-tv)**
  (GPL-3.0) does the real work: pairing with the television and speaking the
  Android TV Remote protocol. This widget contains **no code from that
  project**. It only operates the Homey device that app creates, through
  Homey's public API — the way any Homey app may control any device. The
  capability and key names used here (`key_confirm`, `key_options`, …) are
  interface identifiers read from its public flow cards, not copied source.
  Install that app; this widget is useless without it.
- **`homey-api`**, the npm package used to reach Homey's API, is
  **proprietary to Athom B.V.** and free to use with Homey products. It is a
  declared dependency, not redistributed here (`node_modules` is ignored), so
  installing this app fetches it from npm under Athom's terms.

In short: this repository is MIT, but the stack it runs on is not entirely —
and neither the GPL app nor the Athom package is relicensed by anything here.
