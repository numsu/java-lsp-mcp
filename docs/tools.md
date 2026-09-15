# Tool reference

Run `java-lsp-mcp describe-tools` for complete schemas.

## Navigation

`java_outline` returns filtered declarations and complete bounds. `java_search_symbols` searches workspace/dependencies with exact, prefix, camel-case, or fuzzy matching; unique workspace results can include source. `java_find_definition` resolves declarations with optional source and documentation. `java_find_references` supports call/read/write filters, scope, enclosing declarations, and snippets. Comments, configuration, templates, and reflection strings need text search. Hierarchy tools return bounded graph results.

`java_call_hierarchy` returns incoming callers or outgoing callees. Incoming hierarchies default to `callerScope: "production"`, which excludes callers classified by JDT as test files. Use `callerScope: "tests"` for test callers only or `callerScope: "all"` for both production and test callers. `callerScope` does not affect outgoing hierarchies.

## Validation and analysis

`java_diagnostics` reads current-snapshot diagnostics. `java_compile` runs ECJ against JDT's imported model, not a Maven/Gradle lifecycle. `java_run_tests` executes one or up to 100 selectors. `java_find_affected_tests` performs static candidate selection; full CI remains authoritative. `java_find_unused_code` returns review candidates because reflection and frameworks can create implicit use.

## Edit previews

`java_code_actions` lists JDT actions. `java_edit_preview` previews rename, action, imports, or formatting as hash-bound edits and optional diffs. Neither applies changes. External paths, overlaps, stale bases, and concurrent changes are rejected.

## Conventions

Targets are `{"path":"src/App.java","line":12,"column":8}` or `{"qualifiedName":"com.example.App.run"}`. Qualified targets match the package/class container exactly; duplicate JDT index entries for the same declaration are collapsed, while distinct overloads still require a source-position target. A qualified definition still returns its semantic location and available documentation when the source encoding cannot be decoded; requested source-derived body, context, and members are omitted. Positions are one-based Unicode code-point coordinates. Large results use `limit`, `cursor`, and optional totals, capped at 200 items. Cursors are signed and bound to query, index generation, and expiry.
