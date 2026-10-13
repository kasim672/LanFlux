# Vendored incremental hashing

These modules are copied without algorithm modifications from `@noble/hashes` **2.4.0**, by Paul Miller. The included `LICENSE` is the upstream MIT license and applies to these third-party modules.

Source: https://github.com/paulmillr/noble-hashes/tree/2.4.0

Package: https://registry.npmjs.org/@noble/hashes/-/hashes-2.4.0.tgz

Registry tarball integrity:

```text
sha512-X5XaVWZIBCT7HHZGm5I7ZQXDwLG+bGXuSrMQAW+7Zvl87h1kmc1ZB1VSRJcpUfoUrGQp4Fkoxm5kZ+Ms+aW+eA==
```

Only SHA-2 and its required internal utility modules are served; no CDN or npm installation is needed to run LANFLUX. The SHA-256 incremental API works without `crypto.subtle`, including supported browsers on local HTTP. LANFLUX hashes bounded slices of the original file before offering it and the actual incoming payload incrementally. Known-answer and boundary tests compare this code with independent Node SHA-256 results.

To reproduce these copies from the pinned development dependency, run `npm ci` and `npm run vendor:hashes`. Preserve the MIT license when redistributing these modules.
