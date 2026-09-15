# Workflows and testing

Recommended loop:

```text
navigate → read → patch → diagnostics → compile → affected tests → run tests
```

ECJ compilation is stronger than diagnostics, while Maven/Gradle remains authoritative for lifecycle plugins, generation, packaging, and integration setup.

Tests accept one selector (`path`, optional `className`/`methodName`) or up to 100 selectors. Selectors sharing a JDT-resolved classpath run in one parallel JUnit JVM; different groups and concurrent calls also run in parallel. Compilation is reused only while valid. Do not batch tests competing for exclusive resources. `compileProjectOnly` can limit compilation to selected projects and required dependencies. Tests require workspace trust.

Coverage is opt-in with `"coverage": {}`. JaCoCo data from parallel JVMs is merged. File details include paths, covered counts, and missed lines with independent pagination; use summary detail for smaller output. Coverage failure does not change the test result, and selected-test coverage is not a substitute for full CI.
