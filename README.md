# DA5H

**Infrastructure dashboard. Lockdown is the first module.**

DA5H is a small self-hosted dashboard for the homelab. Its first module is
Lockdown: time-limited nftables blocks for configured host ports. The dashboard
also owns the notification relay every companion app posts through.

## Layout

```text
src/
  server.mjs           combined dashboard + Lockdown server
  dashboard.mjs        dashboard config, function cards and notification relay
  lockdown/
    server.mjs         Lockdown API and request validation
    blocker.mjs        privileged nftables blocker
    config.mjs         preset schema and validation
ui/
  src/App.jsx          path switch: dashboard at /, Lockdown at /lockdown
  src/Dashboard.jsx    service cards and health summaries
  src/Lockdown.jsx     Lockdown module UI
  src/dashboard.css
  src/lockdown.css
config/                gitignored clone of da5h-config
```

## Configuration

Clone the private config repo into `config/`:

```sh
git clone git@github.com:ImranR98/da5h-config.git config
```

The dashboard reads `DA5H_CONFIG` (default `./config/config.json`) and Lockdown
reads `LOCKDOWN_CONFIG` (default `./config/lockdown.json`).

`config.example.json` and `lockdown.example.json` show the shapes. The
dashboard config holds the ntfy URL/token and the service-card list. The
Lockdown config holds the port-blocking presets.

## Development

```sh
npm install
npm run build:ui
npm start
```

The dashboard listens on `http://localhost:8080`; Lockdown is at
`http://localhost:8080/lockdown`. The privileged blocker needs root and
nftables:

```sh
sudo PORT_BLOCKER_TOKEN=dev PORT_BLOCKER_HOST=127.0.0.1 \
  LOCKDOWN_CONFIG=./config/lockdown.json node src/lockdown/blocker.mjs
```

## Images

`ghcr.io/imranr98/da5h` runs the dashboard by default. The blocker deployment
uses the same image with `node src/lockdown/blocker.mjs` as its command.
