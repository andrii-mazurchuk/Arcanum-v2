# Arcanum-v2

Arcanum rebuilt from its mu-spec corpus by forge (TypeScript + Bun).

This file is the deployment's manual: the settings the product reads, how to deploy it with
Docker Compose (poll-only, or with push), how to fill its history, how the assistant reaches it
over HTTP, and a smoke test for a running deployment.

## Settings

Every setting the product reads, in the order the settings loader lists them. A setting that is
absent takes its default; one that is present but invalid stops the start with its name, and is
never replaced by the default. Switches take `on` or `off`.

| Setting | Default | Meaning |
| --- | --- | --- |
| `ARCANUM_STORAGE` | none, required | Location of the store file (the compose files set `/data/arcanum.db` in the `arcanum-data` volume); `:memory:` keeps the store in memory only. |
| `ARCANUM_FIRST_FILL_DAYS` | `90` | How many days back the first fill of an empty store reaches, a whole number from 1 to 90. |
| `ARCANUM_POLL_MINUTES` | `60` | Minutes between two polls of each switched-on source, a whole number of at least 1. |
| `ARCANUM_PUSH_PORT` | `8080` | Port the push receiver listens on inside the container, 0 to 65535. |
| `ARCANUM_TIME_ZONE` | `Europe/Warsaw` | Time zone in which days, weeks and months of the answers are counted. |
| `ARCANUM_MCP_PORT` | `8090` | Port the HTTP assistant connection (`mcp-http`) listens on, 1 to 65535. |
| `ARCANUM_MONOBANK_ENABLED` | `on` | Switches the Monobank source on or off. |
| `ARCANUM_MONOBANK_BASE_URL` | `https://api.monobank.ua` | Address of the Monobank API, http or https. |
| `ARCANUM_MONOBANK_TOKEN` | none, required | Your Monobank personal token, passed from the host environment; never written into any file. |
| `ARCANUM_MONOBANK_PUSH_URL` | none, off | Public address at which Monobank reaches the push receiver; with the secret set too, the service registers for push. |
| `ARCANUM_MONOBANK_PUSH_SECRET` | none, off | Secret path part of the push address; push registration stays off unless both push settings are set. |
| `ARCANUM_SECOND_ENABLED` | `off` | Switches the second source on; the second source's settings below are read only when it is on. |
| `ARCANUM_SECOND_BASE_URL` | none, required (off unless switched on) | Address of the second source's API, http or https. |
| `ARCANUM_SECOND_TOKEN` | none, required (off unless switched on) | The second source's credential, passed from the host environment. |

## Deploy

`compose.yaml` is the poll-only deployment. It runs two services from the one image:

- `arcanum`, the background service (the image's default command), which fetches by polling only;
- `arcanum-mcp`, the HTTP assistant connection (command `mcp-http`).

Both mount the one named volume `arcanum-data` read-write at the store folder and use the same
store file in it. No port is published, and no service has a fixed container name, so the
deployment can run beside others on the same host.

The Monobank token is never written into the repository: it comes from the host environment as
`ARCANUM_MONOBANK_TOKEN`. Start the deployment with it set:

```sh
docker compose up -d
```

The token must be present for every `docker compose up` that recreates the containers (after a
settings change or an image pull), not only the first: a recreate without it starts both services
tokenless. It is best kept in a host secret file outside the repository, readable by its owner only
(mode 600), and loaded by a small wrapper script before it calls docker compose, for example:

```sh
#!/bin/sh
set -a; . /path/to/arcanum.env; set +a; docker compose "$@"
```

Alternatively, point an `env_file:` at a file that lives outside the repository.

For push, layer the override file on top with a second `-f`:

```sh
docker compose -f compose.yaml -f compose.push.yaml up -d
```

`compose.push.yaml` publishes the push receiver's port 8080 and passes
`ARCANUM_MONOBANK_PUSH_URL` (the public address Monobank calls) and
`ARCANUM_MONOBANK_PUSH_SECRET` from the host environment; set both there first. Nothing else
changes.

## History

On its first start against an empty store the service fills the history itself, reaching
`ARCANUM_FIRST_FILL_DAYS` days back (90 by default, at most 90 days).

Older history is fetched with the backfill command, for a range of days:

```sh
docker compose run --rm arcanum bun src/app/bin.ts backfill monobank <YYYY-MM-DD..YYYY-MM-DD>
```

or for everything the source holds:

```sh
docker compose run --rm arcanum bun src/app/bin.ts backfill monobank --all
```

## Assistant over HTTP

The `arcanum-mcp` service serves the assistant's tools at:

```
http://arcanum-mcp:<ARCANUM_MCP_PORT>/mcp
```

(`http://arcanum-mcp:8090/mcp` by default). It accepts POST only and is stateless: there is no
session. It offers the same tools as the stdio `mcp` command, and they are read-only. It has no
authentication, so it is reachable only by other containers on the private compose network, and
its port must never be published.

## Smoke test

Against a running deployment, ask the balance from the deployed store:

```sh
docker compose run --rm arcanum bun src/app/bin.ts balance
```

It prints the balance and exits 0.
