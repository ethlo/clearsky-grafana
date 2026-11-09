# Grafana for Clearsky

A [Clearsky](https://github.com/ethlo/clearsky) plugin. It lets Copilot chats read logs, metrics and dashboards of your environments with `grafana logs test '{app="api"} |= "error"'` instead of a shell on servers. Read only: it makes only search and query calls, with your Viewer login, which never goes in the sandbox. Environments that ask (any name with "prod" by default) ask in the chat each time, and while the VPN is off it says so instead of failing.

## Add it

```sh
clearsky add grafana --trust
```

or **Settings → Plugins → Grafana → Add**. That's `github:ethlo/clearsky-grafana` at the version Clearsky's catalog pins. It needs `--trust` (or the box in Settings) because it gives chats a door (`grafana …`) that acts with your login, so it runs inside Clearsky.

Then set **Grafana environments** on its page under Settings → Plugins (one row per environment, `name=https://address`), and log in to each with your browser there, or give Viewer tokens. A team pack can set the environments for everyone (`GRAFANA_INSTANCES`, `GRAFANA_ASK`).

## Develop

```sh
git clone --depth 1 https://github.com/ethlo/clearsky .clearsky
CLEARSKY_CORE=.clearsky npm test
```

Some tests check its settings with Clearsky's own code, so they need a Clearsky checkout (see `test/core.mjs`). Release by bumping `version` in `clearsky-plugin.json` and `package.json` and tagging `v<version>`.
