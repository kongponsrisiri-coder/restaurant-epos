# node-host — embedded Node.js LAN host for Android (SEPOS-ANDROID-003)

Runs the real SiamEPOS backend (`backend-src/server.js` + better-sqlite3) inside the
Capacitor Android app via the maintained `nodejs-mobile-react-native` Node 18 runtime,
so a Sunmi T2s can act as an offline LAN host. Proven end-to-end on-device (arm64-v8a).

This `BUILD.md` documents the binaries that are **gitignored** (too large / regenerable)
and how to recreate them so the branch builds.

## What's committed vs regenerated
- **Committed (source):** `src/main/cpp/*`, `src/main/java/**`, `CMakeLists.txt`,
  `build.gradle`, `nodejs-assets/nodejs-project/{main.js,package.json,package-lock.json,
  backend-src/**,public/**}`, and `prebuilt/better_sqlite3-arm64-v8a.node`.
- **Gitignored (regenerate):** `build/`, `.cxx/`, `libnode/`, `nodejs-assets/nodejs-project/node_modules/`,
  and all runtime data (`*.db*`, logs, license cache).

## 1. Prebuilt Node runtime (`libnode/`)
From the npm package `nodejs-mobile-react-native@18.20.4`:
- copy its `libnode.so` for `arm64-v8a` + `armeabi-v7a` into `libnode/bin/<abi>/libnode.so`
- copy its Node headers into `libnode/include/`
- the JNI bridge C++ in `src/main/cpp/{native-lib.cpp,rn-bridge.cpp,rn-bridge.h}` is vendored from the same package (already committed).

## 2. node_modules for the on-device server
In `nodejs-assets/nodejs-project/`: `npm install --omit=dev`. Then:
- **better-sqlite3 native binary:** copy the committed `prebuilt/better_sqlite3-arm64-v8a.node`
  into `node_modules/better-sqlite3/build/Release/better_sqlite3.node` (a plain `npm install`
  builds it for the host OS, not Android — use the prebuilt one).
- **path-to-regexp patch (small-ICU):** the embedded Node 18 has reduced ICU, so Express 5's
  `node_modules/path-to-regexp/dist/index.js` `\p{ID_Start}`/`\p{ID_Continue}` regexes (lines ~11-13)
  throw at require. Replace those Unicode-property char-classes with ASCII equivalents
  (SiamEPOS route params are all ASCII). Without this the backend won't boot.

## 3. Cross-compile better-sqlite3 for Android arm64 (if regenerating the .node)
- better-sqlite3 **11.10.0**, toolchain **nodejs-mobile-gyp@0.4.0** + **NDK 27** (`aarch64-linux-android24-clang++`, `llvm-ar`, `llvm-ranlib`).
- Node target headers = `libnode/include/node/`; link against `libnode/bin/arm64-v8a/libnode.so`
  (gyp expects it at `<nodedir>/bin/arm64-v8a/libnode.so`).
- Key flag: `nodejs-mobile-gyp configure --arch=arm64 --nodedir=<dir> --format=make-android` then `build`
  (the `make-android` format avoids macOS link flags like `-dead_strip`/`-bundle`). Set `GYP_DEFINES=OS=android`
  and `CC/CXX/AR/RANLIB` (+ `*_target`) to the NDK clang.
- Result `file` should report `ELF 64-bit ... ARM aarch64`.

## 4. Build the APK
`cd client && npm run build && npx cap sync android`, then RE-COPY `client/dist/*` into
`nodejs-assets/nodejs-project/public/` (host serves the web POS at `/`), then
`cd android && JAVA_HOME=<Android Studio JBR> ./gradlew assembleRelease`.

## Architecture notes
- Standalone (no-cloud) is the default; cloud sync is opt-in and PULL-ONLY (`SYNC_PULL_ONLY`).
- Sunmi is arm64-v8a; armeabi-v7a libnode is shipped but better_sqlite3 is arm64-only.
- Settings/secret apply live (syncService re-reads `host-config.json` each tick + `/api/host/reload-config`).
