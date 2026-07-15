# sandbox

Hardened OpenCode image (rootless + gVisor, zero secrets, egress → MCP Gateway only). `Dockerfile` + agent `profiles/`. Spec: §11, §12, ADR 002/009.

## What's in the image

Built from `debian:12-slim` (pinned by tag). Contents, per §11.1:

- Standard agent dev toolchain: `python3`, `nodejs`/`npm`, `bash`, `git`, `curl`, `ripgrep`, `build-essential`.
- The **OpenCode** binary at `/usr/local/bin/opencode`, run in server mode (`opencode serve --port 4096 --hostname 0.0.0.0`) — see [OpenCode binary](#opencode-binary) below.
- Agent profiles at `/etc/opencode/profiles/` (copied from `profiles/*.json`): `dev`, `data-analyst`, `ops`, `generalist`. Each profile sets the system role, default model tier, and which MCP tool groups are enabled (§12).
- A non-root user `agent` (uid 1000) owning `/workspace` (the container's `WORKDIR`) and `/etc/opencode`.

## Non-root model

The image never runs as root at container start:

- `RUN useradd -m -u 1000 -s /bin/bash agent` creates the user during build.
- `/workspace` and `/etc/opencode` are `chown`-ed to `agent` before the `USER agent` switch.
- `USER agent` is the last instruction before `WORKDIR`/`ENTRYPOINT`, so every process the entrypoint spawns — OpenCode itself and any tool it shells out to — runs as uid 1000, not uid 0.

This is necessary but not sufficient: full rootless enforcement (user namespace remapping so uid 1000 in the container doesn't map to a privileged uid on the host) is a runtime/orchestrator concern, not an image concern — see below.

## Runtime hardening this image ASSUMES

This ticket (AX-015) delivers the **image**. The following hardening measures from §11.2 are enforced by the runtime/orchestrator when the image is scheduled, not by anything baked into the Dockerfile. The image is built to be compatible with all of them, but none of them can be verified with `docker build`/`docker run` alone:

| Measure | Where it's enforced | Ticket |
|---|---|---|
| **gVisor (`runsc`) runtime isolation** | K8s `RuntimeClass` on the sandbox node pool (ADR 002) | AX-075 |
| **Rootless / user namespace remap** | Container runtime config (`userns-remap`) or K8s `hostUsers: false` | AX-075 |
| **Dropped Linux capabilities** (`--cap-drop=ALL`, `no-new-privileges`) | Pod `securityContext` | AX-075 |
| **Read-only root filesystem** (`/workspace` as a dedicated volume, `/tmp` as tmpfs) | Pod `securityContext.readOnlyRootFilesystem` + volume mounts | AX-075 |
| **Egress restricted to MCP Gateway + llm-proxy only** (§17.4 flow matrix, rows 7–8) — no direct Internet, no DNS except kube-dns | K8s `NetworkPolicy` in the sandbox namespace | AX-076 |
| Resource limits (cgroups v2: cpu/mem/pids) | Pod resource requests/limits | AX-075 |
| Secrets | None baked into the image; `task_jwt` is mounted at runtime into a tmpfs by the Orchestrator, never an env var or on-disk file | Orchestrator (§11.2) |

**This image itself enables no outbound network** — there is no proxy config, no allowlist, nothing egress-related in the Dockerfile. Locking egress to the MCP Gateway is a K8s `NetworkPolicy` concern (AX-076), deliberately out of scope here per Principle #2 and the ticket's constraints.

## OpenCode + profiles wiring

- OpenCode runs in **server mode** (`opencode serve`); the Orchestrator talks to it over its local HTTP API on port 4096 and consumes its event stream (§12).
- OpenCode is configured with the MCP Gateway as its **only** remote MCP server (`https://mcp-gateway.internal:8443/mcp`, `Authorization: Bearer ${TASK_JWT}`) — the agent only ever sees the tools the Gateway filters in for that user/turn. This wiring lives in [`opencode.json`](#opencode-config-opencodejson), copied into the image at OpenCode's global config path.
- OpenCode's LLM provider is the internal `llm-proxy` — never a direct frontier API key inside the sandbox.
- Profiles in `/etc/opencode/profiles/*.json` (`dev`, `data-analyst`, `ops`, `generalist`) select the system prompt/role, default model tier (`frontier` vs `eco`), and which MCP tool groups (`github`, `database`, `browser`, `m365`, `slack`, `notion`) are exposed for a given agent invocation.

### OpenCode config (`opencode.json`)

[`opencode.json`](opencode.json) is the OpenCode 1.17 global config baked into the image. The Dockerfile copies it to `/home/agent/.config/opencode/opencode.json` — OpenCode's global config path (`$XDG_CONFIG_HOME/opencode/opencode.json`, `~/.config/opencode` for the `agent` user) — owned by `agent`.

- **`provider`** declares `llm-proxy` as the LLM provider (OpenAI-compatible, `@ai-sdk/openai-compatible`) with `baseURL`/`apiKey` resolved from the runtime env (`{env:LLM_PROXY_BASE_URL}`, `{env:LLM_PROXY_API_KEY}`) — never a direct frontier API key inside the sandbox (§9.5). Its models are the logical tiers `eco`/`frontier`, which the runner names when it pushes a turn (`app/runner.py` opencode mode). On the KEYLESS dev/CI path, llm-proxy runs in `stub` mode and serves a deterministic `POST /v1/chat/completions` (no API key) — see `services/llm-proxy/app/openai_compat.py`.
- **`mcp`** declares a single **remote** server, `mcp-gateway`, at `https://mcp-gateway.internal:8443/mcp`. It is the *sole* remote MCP server; the sandbox reaches no other MCP endpoint. The `TASK_JWT` is presented per turn via `"Authorization": "Bearer {env:TASK_JWT}"` — OpenCode's `{env:VAR}` interpolation, so no secret is on disk; the Orchestrator supplies `TASK_JWT` in the runtime env (§11.2, §13).
- **`tools`** is the allow-list: the union of every profile's `tools` groups (`github`, `browser`, `database`, `m365`, `slack`, `notion` — from `profiles/*.json`). This is the outer bound of what the image will expose; the Gateway still filters down to the exact tools permitted for each user/turn (§12), so the effective set is always a subset of this list.



The OpenCode binary is not guaranteed to be fetchable in offline/CI build environments, so the Dockerfile makes the fetch a clearly-parameterized, non-fatal step:

- `ARG OPENCODE_VERSION` (default `latest`) and `ARG OPENCODE_URL` pin/override the download location.
- The build attempts `curl -fsSL` against the release URL; **on failure it writes a stub `/usr/local/bin/opencode`** that prints an error and exits 1, instead of failing `docker build`.
- To ship a working image, pass a real pinned version and rebuild:

  ```sh
  docker build --build-arg OPENCODE_VERSION=<real-version> -t olma-sandbox:dev sandbox/
  ```

- Until a real binary is wired in, the rest of the image (toolchain, non-root user, profiles) is still fully buildable and testable independently of OpenCode's availability.

## Build & verify

```sh
docker build -t olma-sandbox:dev sandbox/
docker run --rm olma-sandbox:dev whoami                 # -> agent
docker run --rm olma-sandbox:dev sh -c 'id -u'            # -> 1000 (non-zero)
docker run --rm olma-sandbox:dev sh -c 'ls /etc/opencode/profiles'
```
