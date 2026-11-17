<!-- Generated read-only by tools/release-proof/live-plan.ts at 2026-11-17T01:37:56.483Z against the live registry (registry.npmjs.org / index.crates.io) and github.com. -->

# Release request refused: ml-runtime-common (patch)

the release cannot be planned as requested:
  ✗ workspace version inheritance: 10 other publishable crate(s) inherit the same version
Release these together (Boundry never adds packages to a release on its own):
- ml-runtime-coreml-backend (backends/coreml) also inherits [workspace.package] version 0.3.0; bumping it changes this crate's version too → add --package ml-runtime-coreml-backend, or give it its own version
- ml-runtime-cpu-backend (backends/cpu) also inherits [workspace.package] version 0.3.0; bumping it changes this crate's version too → add --package ml-runtime-cpu-backend, or give it its own version
- ml-runtime-onnx-backend (backends/onnx) also inherits [workspace.package] version 0.3.0; bumping it changes this crate's version too → add --package ml-runtime-onnx-backend, or give it its own version
- ml-runtime-backend (crates/backend) also inherits [workspace.package] version 0.3.0; bumping it changes this crate's version too → add --package ml-runtime-backend, or give it its own version
- ml-runtime-inference (crates/inference) also inherits [workspace.package] version 0.3.0; bumping it changes this crate's version too → add --package ml-runtime-inference, or give it its own version
- ml-runtime-model (crates/model) also inherits [workspace.package] version 0.3.0; bumping it changes this crate's version too → add --package ml-runtime-model, or give it its own version
- ml-runtime-protocol (crates/protocol) also inherits [workspace.package] version 0.3.0; bumping it changes this crate's version too → add --package ml-runtime-protocol, or give it its own version
- ml-runtime-provider (crates/provider) also inherits [workspace.package] version 0.3.0; bumping it changes this crate's version too → add --package ml-runtime-provider, or give it its own version
- rust-ml-runtime (crates/runtime) also inherits [workspace.package] version 0.3.0; bumping it changes this crate's version too → add --package rust-ml-runtime, or give it its own version
- ml-runtime-http-provider (providers/http) also inherits [workspace.package] version 0.3.0; bumping it changes this crate's version too → add --package ml-runtime-http-provider, or give it its own version
