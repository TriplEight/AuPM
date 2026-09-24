import { describe, expect, test, vi } from 'vitest'
import type { Deployer } from './index'
import { runDeployers } from './index'

// R3e: before this fix, a deployer failure was caught, logged, and
// swallowed — the process exited 0. These tests run runDeployers() directly
// with a failing stub deployer (no chain, no real deploy-config module), so
// they prove the runner itself surfaces the failure to its caller.

describe('runDeployers', () => {
  test('resolves when every deployer succeeds', async () => {
    const ok: Deployer = { name: 'payment_router', deploy: vi.fn().mockResolvedValue(undefined) }
    await expect(runDeployers([ok])).resolves.toBeUndefined()
    expect(ok.deploy).toHaveBeenCalledOnce()
  })

  test('rejects when a deployer fails, naming it', async () => {
    const failing: Deployer = {
      name: 'payment_router',
      deploy: vi.fn().mockRejectedValue(new Error('Didnt receive an indexer client')),
    }
    await expect(runDeployers([failing])).rejects.toThrow(/payment_router/)
  })

  test('runs every deployer even when an earlier one fails, then rejects', async () => {
    const failing: Deployer = { name: 'a', deploy: vi.fn().mockRejectedValue(new Error('boom')) }
    const ok: Deployer = { name: 'b', deploy: vi.fn().mockResolvedValue(undefined) }
    await expect(runDeployers([failing, ok])).rejects.toThrow(/a/)
    expect(ok.deploy).toHaveBeenCalledOnce()
  })

  test('resolves without running anything for an unknown contractName filter', async () => {
    const ok: Deployer = { name: 'payment_router', deploy: vi.fn().mockResolvedValue(undefined) }
    await expect(runDeployers([ok], 'nonexistent')).resolves.toBeUndefined()
    expect(ok.deploy).not.toHaveBeenCalled()
  })

  test('runs only the deployer matching contractName', async () => {
    const a: Deployer = { name: 'a', deploy: vi.fn().mockResolvedValue(undefined) }
    const b: Deployer = { name: 'b', deploy: vi.fn().mockResolvedValue(undefined) }
    await runDeployers([a, b], 'b')
    expect(a.deploy).not.toHaveBeenCalled()
    expect(b.deploy).toHaveBeenCalledOnce()
  })
})
