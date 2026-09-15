# Architecture and correctness

The Node.js server supervises JDT LS over private LSP pipes. JDT supplies import, indexing, navigation, refactoring, classpaths, and diagnostics; ECJ supplies explicit compilation. MCP stdout is protocol-only.

The server never applies edits. Previews are hash-bound and reject external paths, overlaps, stale bases, and concurrent changes.

File watching uses atomic-write stabilization. Targeted calls also hash source, flush events, and update versioned LSP documents. Public positions are one-based Unicode code-point coordinates converted from JDT's UTF-16. Results are bounded by item and byte budgets; cursors are HMAC-signed and query/generation/expiry-bound.

All semantic tools share a readiness gate. JDT restarts once after a crash; repeated failure preserves diagnostics on stderr. Paths are canonicalized beneath the workspace, symlinks are checked, and downloads are SHA-256 verified. See [Security](../SECURITY.md).
