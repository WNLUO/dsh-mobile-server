# DSH Cloudflare Relay (prototype)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/WNLUO/dsh-mobile-server/tree/main/cloudflare)

This is an isolated Workers package; it does not reuse the Node relay runtime. The implementation accepts the desktop host's outbound `/tunnel` connection, registers protocol v2, relays pairing approval, and forwards mobile HTTP/SSE and WebSocket traffic through a Durable Object. The root page provides read-only setup guidance and coarse service status; it is not an administration panel. It is still **incomplete**: LAN metadata and cookie-only routing are not implemented. Core tunnel flows have been smoke-tested on a temporary Cloudflare deployment, but automated runtime integration tests are not included and long-lived connection lifecycle still needs validation. This is not yet a production-ready relay.

Set `RELAY_SECRET` as a Cloudflare secret before pairing; it signs relay cookies. `TUNNEL_REGISTER_SECRET` is optional, but when configured must match the desktop plugin's registration secret. The host connection is client-initiated and accepted by the Worker/DO; Cloudflare can still close it during runtime or deployment changes, so reconnect recovery must be tested.

## Local development

Requires Node.js 20+ and npm.

```sh
npm install
npm test
npx wrangler dev
```

`/` serves the setup/status page, `/status` returns only whether any registered desktop tunnel is connected, and `/healthz` returns `ok`. The public status response does not expose instance names, IDs, credentials, or secrets. Local Worker/DO websocket lifecycle tests against Cloudflare's runtime are not included yet.

## One-click deployment

The public upstream repository must be public. Configure the Deploy button with this directory as its subdirectory. The user signs in to Cloudflare and connects GitHub/GitLab; Cloudflare creates a copy and deploys it to the account's `workers.dev` address. A custom domain and ICP filing are not required. Configure secrets privately in Cloudflare; never commit real secrets.

Core WebSocket upgrade and bidirectional forwarding have been smoke-tested on Cloudflare. WebSocket Hibernation and long-lived connection lifecycle have not been exhaustively validated. A host disconnect interrupts active requests; the desktop plugin reconnects, while this implementation does not resume interrupted requests. Long-lived HTTP/SSE forwarding uses a Durable Object `waitUntil` task, which Cloudflare may stop after 15 minutes. Workers' WebSocket API cannot send protocol-level ping frames to the phone, so idle phone-WebSocket stability must be verified on Cloudflare. A single Durable Object coordinates all instances in one user's deployment, so this design targets personal use rather than a shared relay service.

## Automatic stable updates

The copied repository checks the official server repository for a newer `cloudflare-vX.Y.Z` GitHub Release once per day, and can also be run manually from GitHub Actions. Until the first stable release is published, it makes no changes. After deployment, confirm the **Update DSH Cloudflare Relay** workflow is enabled in GitHub Actions and keep the Worker connected to the repository in Cloudflare Builds. It copies only the Cloudflare package, then performs a three-way merge of `wrangler.toml` so custom Worker names and resource settings survive. If a user change overlaps an upstream config change, the workflow stops without committing; resolve the conflict and run it again.

Before publishing an update, the workflow runs `npm ci`, `npm test`, and `npx wrangler deploy --dry-run`. Only a passing update is committed to the user's repository. Cloudflare Builds deploys that push automatically when the Worker is connected to the repository. Secrets remain in Cloudflare and local `.dev.vars`, `.env`, and Wrangler state are not copied; no Cloudflare API token is stored in the Worker or updater. `wrangler.toml` is committed to GitHub, so keep secret values out of its `[vars]` section and use Cloudflare secrets instead.

To pause updates, disable **Update DSH Cloudflare Relay** in the repository's Actions settings. To roll back code, revert the updater's commit; this does not roll back Durable Object data or Cloudflare migrations. Keep storage migrations forward-compatible before publishing a release. To publish a stable version, set `cloudflare/package.json` and `.dsh-relay-upstream-version` to the same new `x.y.z`, then run **Release Cloudflare Relay** on the default branch. The release workflow tests the package and rejects an already-published version.
