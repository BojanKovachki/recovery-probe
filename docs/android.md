# Android WebViews (0.5.0-preview.13, experimental)

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

## What reaches the app

- **Page reads:** fetch and XHR made by the WebView can be observed and faulted, as in a desktop page.
- **Native reads are outside the page.** That covers requests made in Java or Kotlin code or an SDK, and calls through JavaScript bridges (`addJavascriptInterface`). Android apps do not read `HTTPS_PROXY`, so `recovery-probe net` does not reach them either.
- **Blank WebViews are hidden.** Apps often keep WebViews with nothing loaded and no window yet, for example to warm one up. Android pauses those, and they never answer DevTools, so a client that attaches to every page waits forever. The URL serves the app's DevTools through a small bridge that leaves out pages that were blank when it first saw them, and lets them run if they were waiting for a debugger. Everything else passes through unchanged.
- **Keep the app on screen.** Android pauses a WebView in the background, and checks report a hidden page as a coverage gap. On a VR headset this means wearing it, or keeping the display awake, with the app in front of other dialogs such as a boundary setup.
- **Leftover forwards:** a forward is removed when the command stops. If the process is killed instead, remove it with `adb forward --remove tcp:PORT`.

Checked on a Quest 2 (Android 14):
- it lists the app's WebView;
- `desktop --list` attaches through the bridge;
- page title and script evaluation work.
