# Architecture and correctness

The Node.js server supervises JDT LS over private LSP pipes. JDT supplies import, indexing, navigation, refactoring, classpaths, and diagnostics; ECJ supplies explicit compilation. MCP stdout is protocol-only.

JDWP debugging is isolated from JDT LS in a lazily started Java source launcher under `java-debug-bridge`. The bridge uses the tooling JDK's `jdk.attach` and `jdk.jdi` modules and communicates with Node over a private request/response pipe; its stdout is protocol-only and diagnostics use stderr. One bridge manages multiple target sessions, each with its own JDI event thread and bounded stop-event queue. Session, stop, frame, and value handles prevent runtime state from leaking across resumes or targets. The bridge is copied into development and release runtime layouts by the build.

Hot Code Replace shares the existing ECJ workspace compilation path. Node selects freshly produced class files for the requested sources; the bridge reads their binary names, maps them to loaded JDI reference types, performs one class redefinition, and restores logical source breakpoints.

The server never applies edits. Previews are hash-bound and reject external paths, overlaps, stale bases, and concurrent changes.

File watching uses atomic-write stabilization. Targeted calls also hash source, flush events, and update versioned LSP documents. Public positions are one-based Unicode code-point coordinates converted from JDT's UTF-16. Results are bounded by item and byte budgets; cursors are HMAC-signed and query/generation/expiry-bound.

All semantic tools share a readiness gate. JDT restarts once after a crash; repeated failure preserves diagnostics on stderr. Paths are canonicalized beneath the workspace, symlinks are checked, and downloads are SHA-256 verified. See [Security](../SECURITY.md).
