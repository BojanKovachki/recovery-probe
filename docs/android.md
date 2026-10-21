# Android WebViews (experimental)

Many Android apps show their screens in a WebView. When the app enables WebView debugging, its pages can be inspected over adb like a desktop debugging endpoint, so the same checks apply: page discovery, `observe`, and HTTP faults inside the page. `recovery-probe android` finds the app's DevTools socket, forwards a local port to it, and prints the URL.

## Requirements

- **adb** from the Android SDK platform-tools. It is looked up in `ANDROID_HOME`, `ANDROID_SDK_ROOT`, the default Windows SDK folder, then `PATH`; `--adb PATH` overrides.
- **USB debugging** on the device, authorized for this computer: `adb devices` lists it as `device`.
- **WebView debugging in the app.** The app calls `WebView.setWebContentsDebuggingEnabled(true)`, as development and test builds often do. Chrome can be inspected without it.

## Run it

```bash
npx recovery-probe android --list
npx recovery-probe android --package com.example.app
```

`--list` shows each WebView with the app that owns it, and Chrome. Without `--list`, the command forwards a port to the app's DevTools socket, checks that DevTools answers there, and serves it on a loopback URL (`--port N` chooses the port). The forward stays until Ctrl+C or `--duration MS`, then it is removed. When several devices are connected, choose one with `--serial`. Use the URL like any desktop endpoint:

```bash
npx recovery-probe desktop --cdp http://127.0.0.1:PORT --list
```

or as `cdp` in an `observe` or `desktop` config.

On a Meta Quest that nobody is wearing, add `--keep-awake`, as explained in [Keep the app drawing](#keep-the-app-drawing):

```bash
npx recovery-probe android --package com.example.app --keep-awake
```

## What reaches the app

- **Page reads:** fetch and XHR made by the WebView can be observed and faulted, as in a desktop page.
- **Native reads are outside the page.** That covers requests made in Java or Kotlin code or an SDK, and calls through JavaScript bridges (`addJavascriptInterface`). Android apps do not read `HTTPS_PROXY`, so `recovery-probe net` does not reach them either.
- **Blank WebViews are hidden.** Apps often keep WebViews with nothing loaded and no window yet, for example to warm one up. Android pauses those, and they never answer DevTools, so a client that attaches to every page waits forever. The URL serves the app's DevTools through a small bridge that leaves out pages that were blank when it first saw them, and lets them run if they were waiting for a debugger. Everything else passes through unchanged.
- **Leftover forwards:** a forward is removed when the command stops. If the process is killed instead, remove it with `adb forward --remove tcp:PORT`.

## Keep the app drawing

Android pauses a WebView in the background, and checks report a hidden page as a coverage gap. A page can also report itself visible while it draws nothing:
- **The display is asleep.** A headset that nobody wears turns its display off.
- **A system dialog is in front.** On a Quest, the Guardian boundary dialog takes focus when the display wakes without anyone wearing the headset.

Such a page still loads data and updates its DOM, but nothing reaches the screen:
- Clicks time out, because Playwright waits for frames to see that an element is stable.
- What the run measures may not match what a user sees.

Recovery Probe reports this in two places:
- **`android` warns** when the display is asleep or the Guardian dialog has focus.
- **Checks diagnose the page** as `visible-not-rendering` (no frames) or `visible-without-viewport` (no size), not as `visible`. The diagnosis is in the report's window state, and the terminal shows a warning.

**`--keep-awake`, on a Meta Quest only:**
- **What it does:** it keeps the display awake and pauses the Guardian boundary until the forward stops, then restores both. Nobody has to wear the headset.
- **What it changes:** it uses the Quest's own developer switches, the `com.oculus.vrpowermanager.prox_close` broadcast and the `debug.oculus.guardian_pause` property.
- **If the command is killed:** restore the headset with `adb shell setprop debug.oculus.guardian_pause 0` and `adb shell am broadcast -a com.oculus.vrpowermanager.automation_disable`.
- **Don't wear the headset while it runs:** Guardian is paused, so there are no boundary warnings.

## Checked on a Quest 2 (Android 14)

The tests ran against the WebView UI of a production app, signed in with a test account.

- **Attaching:** `android --list` lists the app's WebView, and `desktop --list` attaches through the bridge.
- **Discovery:** `desktop --discover` found the 17 JSON reads behind the home screen.
- **A recovery check:** failing the read behind the home screen once with each fault kind (`http-error`, `connection-failure`, `invalid-json`), the screen recovered by itself every time.
- **Unworn headset:** the page reported `visible` with no frames. Clicks timed out, and the diagnosis says `visible-not-rendering`. With `--keep-awake` the page drew frames, clicks worked, and the headset was back to its own settings when the forward stopped.
- **Slow first reload:** once, the first reload after signing in took longer than the 15-second wait. Running the command again worked.
