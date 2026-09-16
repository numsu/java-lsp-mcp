# Tool reference

Run `java-lsp-mcp describe-tools` for complete schemas.

## Navigation

`java_outline` returns filtered declarations and complete bounds. `java_search_symbols` searches workspace/dependencies with exact, prefix, camel-case, or fuzzy matching; unique workspace results can include source. `java_find_definition` resolves declarations with optional source and documentation. `java_find_references` supports call/read/write filters, scope, enclosing declarations, and snippets. Comments, configuration, templates, and reflection strings need text search. Hierarchy tools return bounded graph results.

`java_call_hierarchy` returns incoming callers or outgoing callees. Incoming hierarchies default to `callerScope: "production"`, which excludes callers classified by JDT as test files. Use `callerScope: "tests"` for test callers only or `callerScope: "all"` for both production and test callers. `callerScope` does not affect outgoing hierarchies.

## Validation and analysis

`java_diagnostics` reads current-snapshot diagnostics. `java_compile` runs ECJ against JDT's imported model, not a Maven/Gradle lifecycle. When a build is blocked because a loaded project prerequisite has not been built, compilation recursively builds that prerequisite and retries the dependent project. This recovery is automatic and remains subject to the shared timeout and configured project exclusions. `java_run_tests` executes one or up to 100 selectors. Set `debug: true` to launch the selected JUnit Console run in a suspended local JDWP JVM and return `status: "debugging"` with one `debugSessions` entry per classpath group; set breakpoints first, then call `java_debug_execute` with `action: "continue"` (no `stopId` is needed for this initial startup suspension). Use the other `java_debug_*` tools with those session ids. No test result is produced by a debug launch—run the same selectors again without `debug` after debugging to obtain the result. Debug launches reject `coverage` and caller-supplied JDWP entries in `vmArgs`. `java_find_affected_tests` performs static candidate selection; full CI remains authoritative. `java_find_unused_code` returns review candidates because reflection and frameworks can create implicit use.

## Edit previews

`java_code_actions` lists JDT actions. `java_edit_preview` previews rename, action, imports, or formatting as hash-bound edits and optional diffs. Neither applies changes. External paths, overlaps, stale bases, and concurrent changes are rejected.

## JDWP debugging

Debug tools support local JVMs that were started with the JDWP agent in server mode, for example:

```text
java -agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=*:0 -jar app.jar
```

The server never loads an agent into an ordinary JVM. `java_debug_targets` lists local JVM descriptors and reads the HotSpot `sun.jvm.args` agent property when the operating system command line omits JVM arguments (as can happen with Eclipse m2e launchers). This is a short serviceability Attach API read, not a JDWP debugger attach. Only `server=y` targets are attachable; a target started with `server=n` connects outward to its configured debugger and is reported as unavailable. Use the opaque `targetId` with `java_debug_attach`; Eclipse or another debugger must detach first because a JDWP target normally serves one debugger connection.

`java_debug_sessions` lists sessions owned by this MCP server, including any active continue/step request. A newly attached suspended JVM is reported as `stopped` and includes its initial `stopId` and active thread, so a JUnit debug response can be used immediately without a second attach call. `java_debug_detach` resumes an event suspension owned by the session, disposes the debugger connection, and does not terminate the target JVM; if the target already terminated, the response preserves `terminated` instead of claiming `running`.

`java_debug_set_breakpoints` replaces all breakpoints for one workspace-relative source path and waits up to `timeoutMs` (default 5 seconds) for each location to become verified. An empty array clears that source's breakpoints. Breakpoints for unloaded classes remain deferred and return as `pending` if the timeout expires; they are resolved on class preparation after the initially suspended VM is continued. The requested source must have line-number debug information. The timeout does not resume a suspended VM.

`java_debug_wait_for_stop` waits up to `timeoutMs` for a breakpoint or step event. `timeout` is a successful, non-error outcome. A stop returns `stopId` and `threadId`. Pass both to `java_debug_stack_trace`, then pass a returned `frameId` to `java_debug_variables`. Objects and arrays return a `valueId` for bounded, paginated expansion. All frame and value handles become stale when execution resumes.

`java_debug_execute` accepts `continue`, `step_over`, `step_into`, or `step_out`. Step actions require the current `stopId` and stopped `threadId`. A step or continue already in progress returns a pending-request error, and a successful running response reports the active request. Set `waitTimeoutMs` to combine resume and the next bounded event wait without a race; zero returns as soon as the target is running.

Stale-stop errors include the requested and current `stopId`, JVM state, and current location. Refresh state with `java_debug_sessions` or `java_debug_wait_for_stop` before retrying. `java_debug_threads` excludes JVM infrastructure by default; use `packagePrefix` (matches the suspended thread's declaring class), `namePattern` (full-match Java regular expression; invalid patterns fail with `INVALID_PATTERN`), and `includeSystemThreads` to control filtering. `java_debug_stack_trace` returns application frames by default, supports `packagePrefix`, and reports `truncated` with `nextStartFrame` for pagination. `java_debug_variables` supports collection pagination via `valueId`, optional inline object fields, and explicit getter-evaluation metadata.

`java_debug_hot_swap` first runs an incremental ECJ workspace build, locates class files produced for `sourcePaths`, and calls JDI class redefinition for loaded classes. A successful `dryRun` returns `outcome: "validated"` after compiling and resolving candidates without changing the JVM. Each class reports `changeType` (`method_body` or `structural`); structural changes such as added fields/methods or hierarchy changes are rejected by standard HotSpot. `activeFrames` reports frames that continue old bytecode or became obsolete, and breakpoints are separated into `restored`, `pending`, and `rejected` lists after replacement.

JDWP grants debugger-level control over the target process. Bind it only to a trusted local interface or otherwise secure access to the debug transport.

## Conventions

Targets are `{"path":"src/App.java","line":12,"column":8}` or `{"qualifiedName":"com.example.App.run"}`. Qualified targets match the package/class container exactly; duplicate JDT index entries for the same declaration are collapsed, while distinct overloads still require a source-position target. A qualified definition still returns its semantic location and available documentation when the source encoding cannot be decoded; requested source-derived body, context, and members are omitted. Positions are one-based Unicode code-point coordinates. Large results use `limit`, `cursor`, and optional totals, capped at 200 items. Cursors are signed and bound to query, index generation, and expiry.
