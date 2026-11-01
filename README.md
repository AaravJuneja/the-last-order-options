# The Last Order

This repository contains the live choice display and presenter dashboard for The Last Order.

The display presents timed two-option questions and collects audience responses. A presenter can edit questions and control the session from a responsive dashboard.

## Controls

- Mouse or touch: point at an option and select it.
- Gamepad: tilt the left stick or use the D-pad/bumpers to select; hold LT or RT to confirm, or press A to choose immediately.
- Supported gamepads provide countdown and confirmation rumble.

## Run locally

Requirements: [Bun](https://bun.sh/), a [Turso](https://turso.tech/) database, and Wrangler credentials for Cloudflare.

1. Install dependencies:

   ```sh
   bun install
   ```

2. Create a Turso database and apply the schema:

   ```sh
   turso db shell your-database < db/schema.sql
   ```

3. Set `vars.TURSO_DATABASE_URL` in `wrangler.jsonc` to that database URL. Copy `.dev.vars.example` to `.dev.vars` and set `TURSO_AUTH_TOKEN` and a strong `ADMIN_KEY`.

4. Check and run the app:

   ```sh
   bun run typecheck
   bun run dev
   ```

The presenter dashboard is at `/revolutionize`. It requires the `ADMIN_KEY` value.

## Build and deploy

```sh
bun run build
```

Before deploying, configure your database URL and Cloudflare route in `wrangler.jsonc`, then add the secrets:

```sh
wrangler secret put TURSO_AUTH_TOKEN
wrangler secret put ADMIN_KEY
bun run deploy
```

The Worker uses Cloudflare Durable Objects for live session synchronization and Turso for question storage.

## Fonts

The bundled Iosevka Charon Mono and Pixelify Sans fonts are licensed under the SIL Open Font License 1.1. Their notices are in [`fonts/OFL-IosevkaCharon.txt`](fonts/OFL-IosevkaCharon.txt) and [`fonts/OFL-PixelifySans.txt`](fonts/OFL-PixelifySans.txt).

The project has no repository-wide license file.

