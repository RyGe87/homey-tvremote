# TV Remote Widget for Homey

A Homey dashboard widget with a proper remote control layout for an Android TV
— a touchpad instead of an endless scrolling list of buttons.

## Why

The excellent [Android TV app](https://github.com/drenso/homey-android-tv)
exposes 39 separate capabilities and defines no tile layout of its own, so
Homey falls back to a generic list: six buttons per screen, and scrolling for
the rest. That is fine for flows, but poor for actually operating a
television.

This app now speaks the Android TV Remote v2 protocol itself, in
`lib/androidtv/`: keys, power, volume, app links and typed text all go straight
to the television over one paired connection. No second app in between.

## Two things a television will not tell you

**Only one remote may own the keyboard.** Every client announces what it can do
as a bit mask, and the IME bit is what makes the television report which text
field is selected. With two such clients connected — this app and another
Android TV app, say — text edits from the loser are silently dropped: no error,
no acknowledgement, nothing. Running one is not optional.

**The field is named by its own counter.** A text edit must quote
`RemoteTextFieldStatus.counter_field`, which rises with every change made to the
field, including changes made with the physical remote. Quote a stale one and
the edit is ignored just as quietly, so this app treats a missing confirmation
as a stale counter, reconnects, and tries once more.

A side effect worth knowing: while an IME client is connected, the television's
own on-screen keyboard stops doing multi-tap on the number keys, so the number
keys type digits. There is no way to have both.

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
- An Android TV on the same network, and its IP address

Pair once from the widget: enter the address, then type over the six-character
code the television puts on screen. Give the television a fixed address in your
router — the pairing survives a change of address, but nothing can reach it
until you correct the address in the widget.

**Do not run a second Android TV app alongside this one.** Only one client may
own the television's keyboard, and the loser's text edits are dropped without
any error at all.

## Credits and licensing

The code in this repository is **[MIT](LICENSE)** licensed and was written from
scratch. Two protocol schema files were not, and they are redistributed here
under their own terms — see **[NOTICE](NOTICE)** for the full texts.

| What | Where | Licence |
|---|---|---|
| This app, including `lib/androidtv/*.js` | written here | MIT |
| `lib/androidtv/pairingmessage.proto` | [louis49/androidtv-remote](https://github.com/louis49/androidtv-remote) | MIT |
| `lib/androidtv/remotemessage.proto` | [tronikos/androidtvremote2](https://github.com/tronikos/androidtvremote2) | Apache-2.0 |
| `node-forge` (bundled at install) | npm | BSD-3-Clause, chosen from its BSD-or-GPL-2.0 offer |
| `protobufjs` (bundled at install) | npm | BSD-3-Clause, with a separate Google notice under `google/` |
| `long` (bundled at install) | npm | Apache-2.0 |

Two notes on the schema files, because their heritage is layered.
**louis49/androidtv-remote** is MIT: its LICENSE file governs, and the stray
`"license": "ISC"` in its `package.json` is an npm default, not a decision. Its
JavaScript is ESM and drags in dependencies this app does not need, so
`lib/androidtv/` was written fresh instead of vendored — but its pairing
handshake was the working specification, and its `pairingmessage.proto` is
included unchanged. **tronikos/androidtvremote2** is Apache-2.0 and supplied the
complete `remotemessage.proto`; the MIT project's copy is missing
`RemoteImeObject` and the text field inside `RemoteEditInfo`, which is precisely
what typing needs. Its `send_text` and its feature bit mask
(`PING 1, KEY 2, IME 4, POWER 32, VOLUME 64, APP_LINK 512`) documented how that
message is assembled. That project notes in turn that its schema began as a copy
of the MIT one, extended with comments from the Android Open Source Project
(Apache-2.0).

Nothing GPL or proprietary is left in the chain. Earlier versions drove the
device created by the GPL-3.0 [Android TV app](https://github.com/drenso/homey-android-tv)
through `homey-api`, which is proprietary to Athom B.V.; both were dropped when
this app started speaking the protocol itself. `node-forge` offers a choice
between BSD-3-Clause and GPL-2.0, and the BSD option is the one taken here.

The `homey` module comes from the Homey firmware itself: not declared as a
dependency, not redistributed.
