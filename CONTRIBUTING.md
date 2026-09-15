# Contributing

Use Node 24 and `npm ci`. Before submitting changes run:

```sh
npm run build
npm test
npm run test:integration
npm run generate-sbom
```

Runtime integration tests require an external JDK through `JAVA_HOME` plus `npm run fetch-runtime` for JDT LS. Protocol releases run the applicable official conformance scenarios at the package version pinned in `runtime/versions.lock.json`; the upstream "all" suite assumes an everything-server with resources, prompts, media echo tools, and MRTR, which this tools-only server intentionally does not advertise. Do not claim those inapplicable scenarios. Build every supported platform archive in CI and smoke it with a sanitized `PATH`.

Source tools must remain read-only. Preserve one-based Unicode code-point public positions, hash-bound previews, strict schemas, bounded outputs, stderr-only logs, and the ECJ compiler configuration.
