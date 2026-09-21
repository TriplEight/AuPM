// mcp/src/index.ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { attestLockfileTool } from './tools/attest.js'
import { checkTool } from './tools/check.js'
import { installTool } from './tools/install.js'

const server = new McpServer({ name: 'spm', version: '0.1.0' })

server.tool(
  checkTool.name,
  checkTool.description,
  {
    pkg: z.string().describe('Package name, e.g. "lodash" or "@scope/pkg"'),
    version: z.string().describe('Exact version string, e.g. "4.17.21"'),
  },
  async ({ pkg, version }) => ({
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(await checkTool.handler({ pkg, version }), null, 2),
      },
    ],
  }),
)

server.tool(
  installTool.name,
  installTool.description,
  {
    pkg: z.string().describe('Package name, e.g. "lodash" or "@scope/pkg"'),
    version: z.string().describe('Exact version string, e.g. "4.17.21"'),
    allowDonation: z
      .boolean()
      .optional()
      .describe('Opt in to donating for a 402. Off by default — a 402 never signs otherwise.'),
  },
  async ({ pkg, version, allowDonation }) => ({
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(await installTool.handler({ pkg, version, allowDonation }), null, 2),
      },
    ],
  }),
)

server.tool(
  attestLockfileTool.name,
  attestLockfileTool.description,
  {
    lockfilePath: z.string().describe('Path to a package-lock.json on disk'),
    allowDonation: z
      .boolean()
      .optional()
      .describe('Opt in to donating for a 402. Off by default — a 402 never signs otherwise.'),
  },
  async ({ lockfilePath, allowDonation }) => ({
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(
          await attestLockfileTool.handler({ lockfilePath, allowDonation }),
          null,
          2,
        ),
      },
    ],
  }),
)

const transport = new StdioServerTransport()
await server.connect(transport)
