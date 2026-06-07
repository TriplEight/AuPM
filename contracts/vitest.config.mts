import { createRequire } from 'node:module'
import { defineConfig } from 'vitest/config'

// Load puya-ts transformer using createRequire to avoid ESM issues
const req = createRequire(import.meta.url)

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let puyaTsTransformer: any

const getTransformer = async () => {
  if (puyaTsTransformer) return puyaTsTransformer
  const mod = await import('@algorandfoundation/algorand-typescript-testing/vitest-transformer')
  puyaTsTransformer = mod.puyaTsTransformer
  return puyaTsTransformer
}

const algoTsPlugin = {
  name: 'puya-ts-transform',
  async transform(code: string, id: string) {
    if (!id.endsWith('.algo.ts') && !id.endsWith('.algo.spec.ts')) return null

    const ts = req('typescript') as typeof import('typescript')
    const transformer = await getTransformer()

    // Use transpileModule with the program transformer factory
    // The transformer expects a TS program but transpileModule creates a simple one
    // We need to create a full program for the transformer to work
    const compilerOptions: import('typescript').CompilerOptions = {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      strict: false,
      experimentalDecorators: true,
      emitDecoratorMetadata: false,
    }

    // Create a compiler host with this file's content
    const host = ts.createCompilerHost(compilerOptions)
    const originalGetSourceFile = host.getSourceFile.bind(host)
    host.getSourceFile = (fileName, languageVersion) => {
      if (fileName === id) {
        return ts.createSourceFile(fileName, code, languageVersion, true)
      }
      return originalGetSourceFile(fileName, languageVersion)
    }

    const program = ts.createProgram([id], compilerOptions, host)
    let result = ''

    const transformerFactory = transformer.factory?.(program) ?? transformer

    program.emit(
      program.getSourceFile(id),
      (fileName, text) => {
        if (fileName.endsWith('.js')) result = text
      },
      undefined,
      false,
      { before: [transformerFactory] },
    )

    if (!result) return null
    return { code: result, map: null }
  },
}

export default defineConfig({
  resolve: {
    alias: {
      '@algorandfoundation/algorand-typescript':
        '@algorandfoundation/algorand-typescript-testing/internal',
    },
  },
  test: {
    include: ['smart_contracts/**/*.spec.ts'],
    testTimeout: 60000,
    setupFiles: ['vitest.setup.ts'],
  },
  plugins: [algoTsPlugin],
})
