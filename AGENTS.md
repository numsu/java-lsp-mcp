# Repository instructions

Keep every externally observable MCP tool change documented and tested in the same change.

- Update the tool's Zod input/output schema and its agent-facing description when its contract changes.
- Update the README tool summary when the change affects the tool's primary behavior or an important default.
- Add or update regression tests for changed behavior and defaults.
- Treat `java-lsp-mcp describe-tools` as the canonical complete machine-readable schema; keep prose documentation consistent with it.
- Run `npm run check` before considering the change complete.

