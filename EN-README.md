<h3 align="center">DSH Mobile Server</h3>

<p align="center">
  <img src="assets/banner.jpg" alt="AI-HUB: DSH sessions on a phone and a tablet" width="760">
</p>

<p align="center">
  <img alt="license" src="https://img.shields.io/badge/license-MIT-blue?style=flat-square">
  <img alt="Rust" src="https://img.shields.io/badge/Rust-000000?style=flat-square&logo=rust&logoColor=white">
  <a href="README.md"><img alt="中文" src="https://img.shields.io/badge/README-%E4%B8%AD%E6%96%87-2f81f7?style=flat-square"></a>
</p>

<p align="center">Reach the computer at home, from your phone.</p>

**The relay server.** The phone and the computer cannot see each other across the public internet, so this is the address both of them can reach: it forwards HTTP, SSE, and WebSocket, while the desktop plugin dials out from the local network to establish an outbound WSS tunnel. The user's computer therefore needs no public IP address and no port forwarding on the router.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/WNLUO/dsh-mobile-server/main/assets/connection-en-dark.svg">
    <img src="https://raw.githubusercontent.com/WNLUO/dsh-mobile-server/main/assets/connection-en-light.svg" alt="The phone app reaches the DSH on your computer through a relay, or directly over the LAN" width="720">
  </picture>
</p>

The box in the middle of that diagram is the service you deploy. All it does is match connections and move frames: which model runs, where files land, and where session history lives are all on the user's own computer.

## Features

### Forwarding

- HTTP, SSE, and WebSocket all pass through, frame by frame — the progress bar on the phone is the progress on the computer.
- The tunnel is opened outbound by the computer, and traffic in both directions rides that single connection, which is how a machine inside a LAN becomes reachable.
- The mirror snapshot behind the mobile lists covers short tunnel hiccups, so a flaky link does not blank them out.

### Optional capabilities

- **Relay console**: WeChat login, activation codes, admission mode, controlling and controlled ends — it lives in the same binary as forwarding, so there is no second service to run.
- **iOS push notifications**: bring your own APNs key and the phone gets notified even when locked; leave it unconfigured and the feature is simply off.
- **Emergency full packages**: OTA payloads for the plugin are served from here as well.

### Operations

- `/healthz` for health checks; put a reverse proxy in front and wire it into monitoring.
- A logrotate template ships in the deploy directory — adjust the paths to match your machine.

## Deployment

On a Linux server:

```sh
git clone https://github.com/WNLUO/dsh-mobile-server.git
cd dsh-mobile-server/server/relay/rust
sudo ./deploy/install.sh
```

The install script installs Rust, builds `dsh-relay`, and configures a systemd service. The service listens on `127.0.0.1:18788` by default; put an HTTPS/WSS reverse proxy in front of it — Caddy or Nginx both work, with a certificate from Let's Encrypt or anything that renews itself.

## Environment variables (optional capabilities)

A pure forwarding deployment needs no environment variables at all. The ones below switch on **optional** capabilities:

- Console (WeChat login / activation codes / admission): enable with `PLATFORM_ENABLED=1`; the rest lives in `console/config.rs`.
- Mirror fallback: `MIRROR_CACHE=0` turns it off (on by default); `MIRROR_FALLBACK_MS` sets the threshold.
- **iOS push notifications**: enabled only when `APNS_KEY` + `APNS_KEY_ID` + `APNS_TEAM_ID` are all set. `APNS_KEY` is the `.p8` private key generated in the Apple Developer portal (Apple Push Notifications authentication key, ES256), accepted as either PEM text or a file path (supports `~/`). Leave it unset and the feature is off, with zero impact on forwarding or anything else; the startup log prints `apns disabled`.

## One Apple rule about iOS push

Push capability is bound to **the app's ownership**, not to the relay: only a key issued by the developer team that holds the app's bundle id can push to that app. So:

- **You use the App Store build we publish**: push works on your relay only once you configure **the `.p8` key issued by our team**. Pushes signed by a key from your own Apple account are rejected by Apple (the app is not yours) — not a bug but Apple's ecosystem rule, and the same limitation applies to any self-hosted server pushing to an official client (WeChat, Telegram).
- **You build your own app from a fork** (your own bundle id, signed with your own account): your key works end to end for your build; configure it as described above. This very path is what that section was built for.
- Keys are unrelated to certificates: a `.p8` key does not expire (certificates rotate every year), and one key can push to every app that team owns — but it **cannot read push history**, nor push to apps owned by other teams.

## Development and testing

Requires a Rust toolchain and Node.js:

```sh
npm ci
npm ci --prefix server/relay/rust/console
npm run test:relay-core
npm run test:relay
npm run build:relay
npm run test:e2e
```

- `server/relay/`: the Rust relay service and the optional management console.
- `server/relay-core/`: protocol type tables shared by the relay and the plugin, plus the Rust codec implementations and the protocol documentation.

The frame type table in `server/relay-core/protocol-types.js` is authoritative. The copy inside the plugin must stay in sync with it; the Rust conformance tests use the repository's JS test implementation as the byte-level reference.

## Why I built this

DSH runs on the computer at home, and people take their phones everywhere. The trouble is that neither side can reach the other: almost no home broadband comes with a public address, opening a port on the router is neither practical nor safe, and the phone has no other way to find that machine.

So you need one host with a public address for both ends to connect to, and something to match them up. That is what this relay is, and it is deliberately narrow — match the connections, move the frames, and leave the rest on the user's own computer.

## Alternatives

**Off-the-shelf tunnels (frp, ngrok and friends)**: the network connects, but the configuration is yours to maintain, and they know nothing about the protocol between the app and the plugin — pairing, QR codes, and device credentials would all need a solution of their own.

**A VPN (Tailscale, WireGuard)**: it works at the network layer, at the cost of a VPN that has to stay on, and it only covers devices you own — someone else who installs the app still cannot reach your machine.

**Exposing a port to the public internet**: needs a public IP, DDNS, and TLS you look after yourself; most home broadband has no fixed address, and the whole security surface is yours to watch.

## The companion clients

The desktop plugin and the phone app both live at <https://github.com/WNLUO/dsh-mobile-plugin>; download links and pairing steps are in that README.

## Contact

<p align="center">
  <img src="assets/wechat-group.png" alt="WeCom group QR code" width="180">
</p>

Scan the code above to join our WeCom group. If that is awkward, email <admin@wnluo.com> or <wnluo2@gmail.com>. If it works well for you, a star on the repository helps.

## License

MIT, see [LICENSE](LICENSE).
