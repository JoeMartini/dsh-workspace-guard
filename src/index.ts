/**
 * Workspace Guard — restricts directory picker browsing, workspace creation,
 * and session cwd to a configured root directory. All paths outside the root
 * are rejected before they reach the host filesystem or the agent loop.
 *
 * dsh has no pre-create events for directory-picker, workspace registry, or
 * agent creation, so this plugin monkey-patches service methods:
 *
 *   - `ctx.directoryPicker.capability().list` — limits browse scope
 *   - `ctx.directoryPicker.capability().createDirectory` — limits mkdir scope
 *   - `ctx.workspaceRegistry.create` — blocks workspace registration
 *   - `ctx.workspaceRegistry.resolveByPath` — blocks lookups outside root
 *   - `ctx.agents.create` — rejects session creation with an out-of-root cwd
 *   - `ctx.sandboxPolicy.resolve` — forces per-session workspaceRoot to the
 *     guard root so landlock/bwrap confines bash/file writes to the root,
 *     regardless of the session's cwd
 *
 * All patches are registered inside a single ctx.effect for consistent HMR
 * disposal ordering.
 *
 * @module @deepseek-ai/dsh-workspace-guard
 */

import { realpath } from 'node:fs/promises'
import { resolve, sep, dirname, basename } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { DirectoryPickerError } from '@deepseek-ai/dsh-host-directory-picker'
import type { DirectoryEntry, DirectoryListing } from '@deepseek-ai/dsh-host-directory-picker'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-sandbox-policy'

export const name = 'workspace-guard'
export const inject = ['directoryPicker', 'workspaceRegistry', 'agents']

export interface Config {
  /**
   * Absolute root path that bounds all directory, workspace, and session
   * operations. The plugin canonicalizes both the root and every target
   * via `realpath` before comparing, so symlinks cannot escape containment.
   */
  root: string
}

export const Config: z<Config> = z.object({
  root: z.string().required(),
})

// ─────────────────────────────────────────────────────────────────────────
// Path containment
// ─────────────────────────────────────────────────────────────────────────

/** Canonicalize via realpath; fall back to lexical resolve if path doesn't exist yet. */
async function canon(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch {
    return resolve(path)
  }
}

/** True when `path` is `root` itself or a descendant. Symlink-safe via realpath. */
async function isUnder(path: string, root: string): Promise<boolean> {
  const cp = await canon(path)
  const cr = await canon(root)
  if (cp === cr) return true
  const prefix = cr.endsWith(sep) ? cr : cr + sep
  return cp.startsWith(prefix)
}

/** Assert `path` is under `root`; throw a descriptive error if not. */
async function assertUnder(path: string, root: string): Promise<void> {
  if (!(await isUnder(path, root))) {
    throw new GuardError(
      `access denied: '${path}' is outside your workspace root '${root}'`,
    )
  }
}

/** Build breadcrumbs starting from root instead of filesystem /. */
function restrictedCrumbs(target: string, root: string): DirectoryEntry[] {
  const rootName = basename(root) || root
  const crumbs: DirectoryEntry[] = [{ name: rootName, path: root, hidden: false }]
  if (target === root) return crumbs
  let current = target
  const chain: DirectoryEntry[] = []
  while (current !== root && current !== dirname(current)) {
    const name = basename(current)
    chain.unshift({ name, path: current, hidden: name.startsWith('.') })
    current = dirname(current)
    if (current === dirname(current)) break
  }
  return [...crumbs, ...chain]
}

/** Error class so consumers can distinguish guard denials. */
export class GuardError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GuardError'
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Plugin entry
// ─────────────────────────────────────────────────────────────────────────

export function apply(ctx: Context, config: Config) {
  const root = resolve(config.root)

  ctx.effect(() => {
    const restore: Array<() => void> = []

    // ── 1. Directory picker: restrict browse + createDirectory ──
    const picker = ctx.directoryPicker
    const cap = picker.capability()

    if (cap.kind === 'browse') {
      const originalList = cap.list.bind(cap)
      const originalCreateDir = cap.createDirectory.bind(cap)

      cap.list = async (path?: string, signal?: AbortSignal): Promise<DirectoryListing> => {
        const target = path !== undefined ? resolve(path) : root
        if (!(await isUnder(target, root))) {
          throw new DirectoryPickerError(
            'directory-unreadable', target,
            `access denied: '${target}' is outside your workspace root`,
          )
        }
        const result = await originalList(target, signal)
        return {
          ...result,
          home: root,
          crumbs: restrictedCrumbs(result.path, root),
        }
      }

      cap.createDirectory = async (path: string, name: string): Promise<string> => {
        const parent = resolve(path)
        if (!(await isUnder(parent, root))) {
          throw new DirectoryPickerError(
            'directory-create-failed', resolve(parent, name),
            'cannot create directory outside your workspace root',
          )
        }
        return originalCreateDir(parent, name)
      }

      restore.push(() => {
        cap.list = originalList
        cap.createDirectory = originalCreateDir
      })
    }

    // ── 2. Workspace registry: guard create + resolveByPath ──
    const registry = ctx.workspaceRegistry
    const originalCreate = registry.create.bind(registry)
    const originalResolveByPath = registry.resolveByPath.bind(registry)

    registry.create = async (path: string, title?: string): Promise<Workspace> => {
      await assertUnder(path, root)
      return originalCreate(path, title)
    }

    registry.resolveByPath = async (path: string): Promise<Workspace | undefined> => {
      await assertUnder(path, root)
      return originalResolveByPath(path)
    }

    restore.push(() => {
      registry.create = originalCreate
      registry.resolveByPath = originalResolveByPath
    })

    // ── 3. Agent creation: reject out-of-root cwd ──
    const agents = ctx.agents
    const originalAgentsCreate = agents.create.bind(agents)

    agents.create = (async (options: Parameters<typeof originalAgentsCreate>[0]) => {
      const cwd = options.meta?.cwd
      if (cwd !== undefined) {
        await assertUnder(cwd, root)
      }
      return originalAgentsCreate(options)
    }) as typeof originalAgentsCreate

    restore.push(() => {
      agents.create = originalAgentsCreate
    })

    // ── 4. Sandbox policy: force workspaceRoot to guard root ──
    // sandbox-policy.resolve() returns { mode, workspaceRoot: session?.header.cwd ?? this.workspaceRoot }.
    // The session cwd may be process.cwd() (outside root). Override resolve() to
    // always return the guard root as workspaceRoot for workspace-write mode, so
    // landlock/bwrap confines bash/file writes to the guard root.
    //
    // Uses ctx.get('sandboxPolicy') for optional injection — the service may
    // not be composed (e.g. headless profile without sandbox-policy).
    const sandboxPolicy = ctx.get('sandboxPolicy')
    if (sandboxPolicy !== undefined) {
      const originalResolve = sandboxPolicy.resolve.bind(sandboxPolicy)

      sandboxPolicy.resolve = (session?: Parameters<typeof originalResolve>[0]) => {
        const resolved = originalResolve(session)
        if (resolved.mode === 'workspace-write') {
          return { ...resolved, workspaceRoot: root }
        }
        return resolved
      }

      restore.push(() => {
        sandboxPolicy.resolve = originalResolve
      })
    }

    // ── Restore all on dispose (HMR safety) ──
    return () => restore.forEach(fn => fn())
  })
}
