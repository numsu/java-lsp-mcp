# Troubleshooting

Start with `java-lsp-mcp doctor --workspace /project` and `java_status`.

- `RUNTIME_MISSING`: check tooling JDK, `JAVA_HOME`, JDT layout, or `npm run fetch-runtime`.
- `JDT_NOT_READY`: inspect status and stderr; large imports may need a longer timeout.
- `JDT_INDEXING`: the document still needs reconciliation.
- `STALE_CURSOR`: restart pagination.
- `STALE_ACTION`/`STALE_EDIT`: recreate the preview against current source.
- `TEST_PROJECT_EXCLUDED`: remove the relevant exclusion.

Use text search for non-semantic references. Reproduce ECJ/native-build differences with Maven or Gradle. Configure legacy source encoding explicitly. After repeated JDT failure, inspect stderr and use `clear-cache` only for the affected workspace if corruption is suspected.
