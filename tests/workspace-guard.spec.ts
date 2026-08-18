import { describe, it, expect } from 'vitest'
import { resolve, sep } from 'node:path'
import { realpath } from 'node:fs/promises'

/** Path-containment logic under test (mirrors the plugin's internal helpers). */
async function canon(path: string): Promise<string> {
  try { return await realpath(path) }
  catch { return resolve(path) }
}

async function isUnder(path: string, root: string): Promise<boolean> {
  const cp = await canon(path)
  const cr = await canon(root)
  if (cp === cr) return true
  const prefix = cr.endsWith(sep) ? cr : cr + sep
  return cp.startsWith(prefix)
}

describe('path containment', () => {
  it('allows the root itself', async () => {
    expect(await isUnder('/tmp', '/tmp')).toBe(true)
  })

  it('allows a descendant', async () => {
    expect(await isUnder('/tmp/foo/bar', '/tmp')).toBe(true)
  })

  it('denies a sibling', async () => {
    expect(await isUnder('/home', '/tmp')).toBe(false)
  })

  it('denies a parent', async () => {
    expect(await isUnder('/', '/tmp')).toBe(false)
  })

  it('denies a prefix-lookalike', async () => {
    // /tmp-evil starts with /tmp but is not under /tmp
    expect(await isUnder('/tmp-evil', '/tmp')).toBe(false)
  })

  it('denies traversal escape', async () => {
    expect(await isUnder('/tmp/../etc', '/tmp')).toBe(false)
  })
})

describe('restricted crumbs', () => {
  // Mirrors the plugin's restrictedCrumbs logic
  function restrictedCrumbs(target: string, root: string) {
    const parts: string[] = [root]
    if (target === root) return parts
    let current = target
    const chain: string[] = []
    while (current !== root && current !== resolve('/')) {
      chain.unshift(current)
      current = resolve(current, '..')
      if (current === resolve(current, '..')) break
    }
    return [...parts, ...chain]
  }

  it('returns just root when target is root', () => {
    expect(restrictedCrumbs('/workspaces/a', '/workspaces/a')).toEqual(['/workspaces/a'])
  })

  it('builds chain from root to target', () => {
    const crumbs = restrictedCrumbs('/workspaces/a/projects/x', '/workspaces/a')
    expect(crumbs).toEqual([
      '/workspaces/a',
      '/workspaces/a/projects',
      '/workspaces/a/projects/x',
    ])
  })
})
