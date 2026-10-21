# Mullvad extension for Chrome

An unofficial Chrome Manifest V3 port of the [Mullvad browser extension](https://github.com/mullvad/browser-extension), built with React and Bun. Type checking uses [tsc-rs](https://github.com/pingdotgg/ts-rust), an experimental Rust port of the TypeScript 7 compiler.

**Development preview.** This project is not affiliated with Mullvad. Do not treat a configured browser proxy as proof that a VPN connection works.

## What it does

- Select a Mullvad SOCKS5 server for the browser or individual destination hosts.
- Manage website rules, exclusions, session-random routing, and location history.
- Inspect IPv4, IPv6, and DNS observations through Mullvad's connection-check services.
- Configure supported Chrome privacy controls and import compatible Firefox settings exports.

Mullvad SOCKS5 servers require an existing Mullvad VPN connection. The extension does not create a VPN tunnel.

## Build and load

Use Bun 1.4.3, as pinned in `package.json`.

```sh
bun install --frozen-lockfile
bun run build
```

Open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select `dist/production`. Connect the Mullvad VPN app before selecting a proxy. Reload the extension after rebuilding.

For development, run `bun run build:dev` and load `dist/development` instead. Both builds use packaged scripts and a self-only content security policy.

Other commands:

```sh
bun run check
bun run lint
bun run format
bun test
```

The browser suite requires `chromium`, `Xvfb`, and `xdotool` on `PATH`. It uses disposable profiles and native permission dialogs. Missing prerequisites fail the browser checks rather than skipping them.

## Routing and privacy limits

Rules apply to each request's destination, not every resource loaded by a particular tab. With random mode off, exclusions bypass the proxy. Random mode overrides saved proxy selections and exclusions; local destinations still bypass the proxy.

The extension uses mandatory Chrome PAC configuration and does not append a direct fallback to SOCKS5 routes. This is not a system-wide kill switch. Disabling the extension, changing browser settings, or using another application falls outside its routing controls.

Connection checks describe the browser route used by the check request. They do not establish the active website's route or prevent DNS leaks. Chrome's WebRTC control restricts non-proxied UDP; it does not disable WebRTC. Firefox's per-site proxy DNS toggle has no equivalent here.

To use the popup in private windows, enable **Allow in Incognito** in the extension's Chrome details. Regular routing is inherited until a private-session override is set. Private routing overrides expire when the last Incognito window closes, and private usage does not enter location history. The Settings button opens regular, persistent settings. Reload-after-change uses one preference for both popup contexts; change it in regular settings. Incognito diagnostics are unavailable because a spanning service worker cannot guarantee that its requests use the private route.

Import previews identify incompatible settings before replacement. Firefox exports using unsupported DNS settings or unrecognized proxy endpoints require correction; importing them must not silently discard their routing intent.

## Development command API

Only the development build exposes `globalThis.mullvadDev` in its service worker. Its `command` method uses the same validation and controller as the UI. The production build excludes this API.

Use a fresh browser profile and keep the debugging port on loopback. CDP can control the whole debugging profile, so do not attach it to your normal browsing profile or expose its port to a network.

For command-line loading with Chromium:

```sh
bun run build:dev
PROFILE=$(mktemp -d)
chromium \
  --user-data-dir="$PROFILE" \
  --remote-debugging-address=127.0.0.1 \
  --remote-debugging-port=9222 \
  --disable-extensions-except="$PWD/dist/development" \
  --load-extension="$PWD/dist/development"
```

In Chrome builds that restrict command-line extension loading, open the isolated profile's `chrome://extensions` page and load `dist/development` manually.

Open the extension popup to wake its worker, then list CDP targets:

```sh
curl --fail --silent http://127.0.0.1:9222/json/list
```

Select the `service_worker` target for this extension ID whose URL ends in `/background/index.js`. Connect a CDP client to that target's `webSocketDebuggerUrl` and send:

```json
{
  "id": 1,
  "method": "Runtime.evaluate",
  "params": {
    "expression": "globalThis.mullvadDev.command({type: 'snapshot'})",
    "awaitPromise": true,
    "returnByValue": true
  }
}
```

The returned value is `{ "ok": true, "value": ... }` or `{ "ok": false, "error": ... }`. See [`src/shared/messages.ts`](src/shared/messages.ts) for commands and [`src/shared/state.ts`](src/shared/state.ts) for result types. Commands default to the regular context; Incognito commands also require Chrome opt-in and an open private window.

Rediscover the worker target after extension reloads or worker restarts. Treat diagnostic responses as sensitive because they can contain IP addresses. Close the isolated profile when finished. The extension has no HTTP control server or website-accessible command endpoint.

## License

GPL-3.0-or-later. See [LICENSE.md](LICENSE.md) and [NOTICE.md](NOTICE.md). The bundled public-suffix implementation retains its [MIT notice](src/core/tldts.LICENSE).
