import { build } from "esbuild";
await build({ entryPoints: ["src/index.ts"], outfile: "dist/server.mjs", bundle: true, platform: "node", format: "esm", target: "node24", sourcemap: true, banner: { js: "#!/usr/bin/env node\nimport { createRequire as __javaLspMcpCreateRequire } from 'node:module'; const require = __javaLspMcpCreateRequire(import.meta.url);" } });
