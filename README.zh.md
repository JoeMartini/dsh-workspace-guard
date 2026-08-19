# dsh-workspace-guard

[English](README.md) | [中文](README.zh.md)

Workspace Guard — 将目录浏览、工作区创建和会话 `cwd` 限制在一个配置的根目录内。专为多租户 dsh 部署设计，每个租户运行独立的 dsh 进程。

## 适用场景

当多个用户共享同一台 dsh 主机、且每个人必须被限制在自己的目录子树内时使用。本插件**与 IdP 无关**：认证由反向代理 / OIDC 层（oauth2-proxy、Keycloak、Authentik、Auth0 等）处理，插件仅负责路径围栏。

## 防护范围

| 接口 | 拦截行为 |
|---|---|
| `host.listDirectory` RPC | 阻止浏览根目录之外的目录 |
| `host.createDirectory` RPC | 阻止在根目录之外创建目录 |
| `workspace.resolve` / `workspace.create` RPC | 阻止注册指向根目录之外的工作区 |
| `session.create` RPC（含 `cwd`） | 阻止以根目录之外的路径启动会话 |

每次校验对目标和根目录都使用 `fs.realpath` 做规范化，因此符号链接无法逃逸围栏。

## 安装

```sh
dsh plugin --profile <name> add dsh-workspace-guard
```

然后在 profile 的 `cordis.patch.yml` 中覆盖 root（**不要用 insert**，bundle
已自动插入；用 override 覆盖配置即可）：

```yaml
- id: workspace-guard
  config:
    root: /workspaces/tenant-a
```

也可以设置 `DSH_WORKSPACE_ROOT` 环境变量，省略 patch 覆盖。

| 配置项 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `root` | `string` | 是 | 限制所有目录、工作区和会话操作的根目录绝对路径。 |

## 工作原理

dsh 没有为目录选择器、工作区注册表或 agent 创建提供前置事件。本插件通过 monkey-patch 替换五个 service 方法，并在销毁时恢复原始绑定（HMR 安全）：

1. `ctx.directoryPicker.capability().list` — 列表范围重定向到根目录
2. `ctx.directoryPicker.capability().createDirectory` — 阻止在根目录之外创建目录
3. `ctx.workspaceRegistry.create` — 阻止在根目录之外注册工作区
4. `ctx.workspaceRegistry.resolveByPath` — 阻止查询根目录之外的工作区
5. `ctx.agents.create` — 阻止以根目录之外的 `cwd` 创建会话

所有 patch 由单个 `ctx.effect()` 统一管理，其 disposer 恢复全部原始绑定。

## 多租户部署模式

```
Keycloak / 任意 OIDC IdP
    ↓
oauth2-proxy（每租户一个，基于角色控制访问）
    ↓
Nginx → /tenant-a/ → 127.0.0.1:3081 (DSH_HOME=/dsh/tenant-a, root=/workspaces/a)
       → /admin/    → 127.0.0.1:3080 (不挂载 guard，无限制)
```

- **管理实例**：不装本插件 — 完整权限。
- **租户实例**：挂载并配置 `root: /workspaces/<租户>/`。
- 每个实例有独立的 `DSH_HOME`（隔离会话、凭据、设置）。

## 已知限制与后续工作

- **无沙箱强制**：guard 阻止了工作区和会话的创建，但不配置 dsh 的沙箱策略（`workspace-write` 模式）。在 root 内创建的会话在 `read-only` 或 `danger-full-access` 沙箱模式下仍可读取 root 之外的文件。部署应将本插件与 `sandbox-policy` 配置结合使用，设 `mode: workspace-write` 且 `workspaceRoot` 与 guard 的 `root` 一致。
- **Monkey-patching**：dsh 不暴露目录选择器、工作区注册表或 agent 创建的前置事件。如果上游添加了此类事件，patch 应迁移为正式的 `ctx.on()` 监听器。
- **无按用户隔离的 root**：root 是进程级的。真正的按用户隔离需要每用户一个进程（即上述多租户模式），或 dsh 上游支持用户身份。

## Model Experience

无模型可见效果。插件在任何工具或提示组装运行之前拦截 host 服务；agent 看不到根目录之外的路径，因此无法引用它们。

## License

MIT
