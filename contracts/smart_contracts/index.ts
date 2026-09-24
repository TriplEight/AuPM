import * as fs from 'node:fs'
import * as path from 'node:path'
import { Config } from '@algorandfoundation/algokit-utils'
import { consoleLogger } from '@algorandfoundation/algokit-utils/types/logging'
import { registerDebugEventHandlers } from '@algorandfoundation/algokit-utils-debug'

// Uncomment the traceAll option to enable auto generation of AVM Debugger compliant sourceMap and simulation trace file for all AVM calls.
// Learn more about using AlgoKit AVM Debugger to debug your TEAL source codes and inspect various kinds of Algorand transactions in atomic groups -> https://github.com/algorandfoundation/algokit-avm-vscode-Debugger

Config.configure({
  logger: consoleLogger,
  debug: true,
  //  traceAll: true,
})
registerDebugEventHandlers()

// base directory
const baseDir = path.resolve(__dirname)

export interface Deployer {
  name: string
  deploy: () => Promise<void>
}

// function to validate and dynamically import a module
export async function importDeployerIfExists(dir: string): Promise<Deployer | null> {
  const deployerPath = path.resolve(dir, 'deploy-config')
  if (fs.existsSync(`${deployerPath}.ts`) || fs.existsSync(`${deployerPath}.js`)) {
    const deployer = await import(deployerPath)
    return { ...deployer, name: path.basename(dir) }
  }
  return null
}

// get a list of all deployers from the subdirectories
export async function getDeployers(dir: string): Promise<Deployer[]> {
  const directories = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((dirent) => dirent.isDirectory())
    .map((dirent) => path.resolve(dir, dirent.name))

  const deployers = await Promise.all(directories.map(importDeployerIfExists))
  return deployers.filter((deployer): deployer is Deployer => deployer !== null)
}

/**
 * Runs every deployer in `deployers`, optionally filtered to `contractName`.
 * A deployer that throws is logged, not swallowed: it is collected, and once
 * every deployer has run, `runDeployers` throws if any failed. The caller
 * (the module-level IIFE below) turns that throw into a non-zero exit code —
 * before this fix, a deploy failure printed an error and still exited 0
 * (algokit's `project deploy` then reported success).
 *
 * @param deployers - the deployers to run (from getDeployers()).
 * @param contractName - restricts the run to the deployer with this name.
 */
export async function runDeployers(deployers: Deployer[], contractName?: string): Promise<void> {
  const filteredDeployers = contractName
    ? deployers.filter((deployer) => deployer.name === contractName)
    : deployers

  if (contractName && filteredDeployers.length === 0) {
    console.warn(`No deployer found for contract name: ${contractName}`)
    return
  }

  const failures: Array<{ name: string; error: unknown }> = []
  for (const deployer of filteredDeployers) {
    try {
      await deployer.deploy()
    } catch (e) {
      console.error(`Error deploying ${deployer.name}:`, e)
      failures.push({ name: deployer.name, error: e })
    }
  }

  if (failures.length > 0) {
    const names = failures.map((f) => f.name).join(', ')
    throw new Error(`${failures.length} deployer(s) failed: ${names}`)
  }
}

/**
 * True when this file is the process's own entry point (`tsx
 * smart_contracts/index.ts`, `ts-node-dev … smart_contracts/index.ts`), not
 * merely imported — e.g. by index.spec.ts, to unit-test runDeployers()
 * without running the real deployers as an import side effect. `require` is
 * undefined under vitest's ESM-based module runner, so this checks `typeof`
 * first rather than assuming a CommonJS global exists.
 */
const isMainModule =
  typeof require !== 'undefined' && typeof module !== 'undefined' && require.main === module

// execute all the deployers
if (isMainModule) {
  ;(async () => {
    const contractName = process.argv.length > 2 ? process.argv[2] : undefined
    const deployers = await getDeployers(baseDir)
    await runDeployers(deployers, contractName)
  })().catch((e) => {
    console.error(e)
    process.exitCode = 1
  })
}
