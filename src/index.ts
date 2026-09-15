import { main } from "./cli/main.js";
main().then(code => { if (code) process.exitCode = code; }).catch(error => { process.stderr.write(`[java-lsp-mcp] fatal: ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
