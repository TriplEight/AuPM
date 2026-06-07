// mcp/src/tools/install.ts
// Full implementation in A7
export const installTool = {
  name: 'install_audited_package',
  description:
    'Install an npm package via SPM. If COMMUNITY_REVIEWED or higher, automatically pays ' +
    'the $0.001 USDC micropayment on Algorand and returns tarball path + settlement txid.',
  async handler({ pkg, version }: { pkg: string; version: string }) {
    return { status: 'not_implemented', pkg, version }
  },
}
