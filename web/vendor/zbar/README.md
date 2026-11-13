# Bundled ZBar reader

The unmodified browser wrapper is `@undecaf/zbar-wasm` **0.11.0**, built with
ZBar **0.23.90**. Both retain **LGPL-2.1-or-later**, separately from this
project's MIT code. See [LICENSE.txt](LICENSE.txt). Runtime files, upstream
versions, npm integrity and source archive hashes are in
[provenance.json](provenance.json).

Upstream projects:

- https://github.com/undecaf/zbar-wasm/tree/c04ab59682681e27a24b36b36084806437a5d224
- https://github.com/mchehab/zbar/tree/0.23.90

The complete pinned wrapper source, build scripts, lockfile and tests are in
[sources/zbar-wasm-c04ab596.tar.gz](sources/zbar-wasm-c04ab596.tar.gz).
The matching ZBar source is in
[sources/zbar-0.23.90.tar.gz](sources/zbar-0.23.90.tar.gz). The core archive is
from the upstream Git tag; it needs Autotools to generate `configure`, unlike
the release tarball referenced by the wrapper's Makefile. Keep these source
archives and notices available when distributing these binaries.

`index.js` loads the adjacent `zbar.wasm`; no CDN is used. The separate files
can be replaced with a compatible rebuilt library without changing project
code or a signature check. The library's LGPL permissions, including debugging
modifications to it, remain applicable. Source archives are served alongside
the runtime but are not required in the camera's offline cache.

## Rebuilding or modifying the library

Use the included upstream Makefile, `package-lock.json` and source. Its pinned
compiler image is `emscripten/emsdk:3.1.44`. Build prerequisites include Node,
npm, make, Autoconf, Automake, Autopoint, pkg-config, Libtool and Docker or
Podman. From this directory on a Unix build host, create a separate build
directory and unpack both archives:

```sh
mkdir zbar-rebuild
tar -xf sources/zbar-wasm-c04ab596.tar.gz -C zbar-rebuild
cp sources/zbar-0.23.90.tar.gz zbar-rebuild/zbar-wasm-c04ab59682681e27a24b36b36084806437a5d224/
cd zbar-rebuild/zbar-wasm-c04ab59682681e27a24b36b36084806437a5d224
tar -xf zbar-0.23.90.tar.gz
(cd zbar-0.23.90 && autoreconf -vfi)
npm ci --ignore-scripts
make EM_ENGINE='$(EM_DOCKER)' dist
```

Copy the rebuilt `dist/index.js`, its source map and `dist/zbar.wasm` into
this directory together. Retain applicable notices and corresponding source
for modified versions. The upstream build instructions and pinned inputs are
provided here; this project update did not rebuild the downloaded npm binary
or establish a bit-for-bit reproducible build. Its npm SHA512 and bundled
file SHA256 values were verified before use.
