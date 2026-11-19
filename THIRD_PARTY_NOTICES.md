# Third-party notices

Kinfile was written from scratch (no forked editor project). It bundles these open-source packages into `dist/extension.js`:

| Package | License | Use |
|---|---|---|
| [@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol/typescript-sdk) | MIT | MCP server exposing editor tools to TrueForge |
| [zod](https://github.com/colinhacks/zod) | MIT | MCP tool input schemas |
| [diff (jsdiff)](https://github.com/kpdecker/jsdiff) | BSD-3-Clause | Line diff for hunk computation |

The MCP SDK's own runtime dependencies (e.g. `ajv`, `raw-body`) are MIT/ISC licensed and are included through it.

Runtime (not bundled): [TrueForge](https://github.com/truefoundry/trueforge) (MIT), started with `npx @truefoundry/trueforge`.
