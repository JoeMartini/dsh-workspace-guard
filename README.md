# dsh-workspace-guard

[English](README.md) | [中文](README.zh.md)

Workspace Guard — restricts directory picker browsing, workspace creation, and session `cwd` to a configured root directory. Designed for multi-tenant dsh deployments where each tenant runs a separate process.

## When to use

When multiple users share a dsh host and each must be confined to their own directory subtree. The plugin is **IdP-agnostic**: authentication is handled by the reverse proxy / OIDC layer (oauth2-proxy, Keycloak, Authentik, Auth0, etc.), and this plugin enforces path containment only.

## What it guards

| Surface | What is blocked |
|---|---|
| `host.listDirectory` RPC | Browsing directories outside root |
| `host.createDirectory` RPC | Creating directories outside root |
| `workspace.resolve` / `workspace.create` RPC | Registering a workspace pointing outside root |
| `session.create` RPC (with `cwd`) | Starting a session whose `cwd` is outside root |

Each check uses `fs.realpath` canonicalization on both the target and the root, so symlinks cannot escape containment.

## Installation

```sh
dsh plugin --profile <name> add dsh-workspace-guard
```

The bundle's own `cordis.patch.yml` already inserts the plugin with a
default root (`$DSH_WORKSPACE_ROOT` env var, falling back to `process.cwd()`).
To customize the root, **override** by id in your profile's `cordis.patch.yml`
(do not `insert` a second entry — that causes a duplicate-id error):

```yaml
- id: workspace-guard
  config:
    root: /workspaces/tenant-a
```

Alternatively, set the `DSH_WORKSPACE_ROOT` environment variable and omit
the patch override entirely.

| Config key | Type | Required | Description |
|---|---|---|---|
| `root` | `string` | yes | Absolute path bounding all directory, workspace, and session operations. |

## How it works

dsh has no pre-create events for directory-picker, workspace registry, or agent creation. This plugin monkey-patches five service methods and restores them on disposal (HMR-safe):

1. `ctx.directoryPicker.capability().list` — re-homes listing to root
2. `ctx.directoryPicker.capability().createDirectory` — blocks mkdir outside root
3. `ctx.workspaceRegistry.create` — blocks workspace registration outside root
4. `ctx.workspaceRegistry.resolveByPath` — blocks lookups outside root
5. `ctx.agents.create` — blocks sessions with an out-of-root `cwd`

A single `ctx.effect()` owns all patches; its disposer restores every original binding.

## Multi-tenant deployment pattern

```
Keycloak / any OIDC IdP
    ↓
oauth2-proxy (one per tenant, Role-Based Access)
    ↓
Nginx → /tenant-a/ → 127.0.0.1:3081 (DSH_HOME=/dsh/tenant-a, root=/workspaces/a)
       → /admin/    → 127.0.0.1:3080 (no guard, unrestricted)
```

- **Admin instance**: do not mount this plugin — unrestricted access.
- **Tenant instance**: mount with `root: /workspaces/<tenant>/`.
- Each instance has its own `DSH_HOME` (separate sessions, credentials, settings).

## Known Limitations and Deferred Work

- **No sandbox enforcement**: the guard blocks workspace and session creation, but does not configure dsh's sandbox policy (`workspace-write` mode). A session created inside root can still read files outside root in `read-only` or `danger-full-access` sandbox mode. Deployments should combine this plugin with a `sandbox-policy` config setting `mode: workspace-write` and `workspaceRoot` matching the guard's `root`.
- **Monkey-patching**: dsh does not expose pre-create events for directory-picker, workspace registry, or agent creation. If upstream adds such events, the patches should migrate to proper `ctx.on()` listeners.
- **No per-user root**: the root is per-process. True per-user isolation requires one process per user (the multi-tenant pattern above) or upstream user-identity support in dsh.

## Model Experience

No model-visible effects. The plugin intercepts host services before any tool or prompt assembly runs; the agent never sees paths outside the root and therefore cannot reference them.

## License

MIT
