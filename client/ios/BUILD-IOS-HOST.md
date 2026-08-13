# iOS host — embedded Node.js LAN host for iPad (SEPOS-IOS-HOST-001)

Runs the real SiamEPOS backend (`nodejs-project/backend-src/server.js` +
better-sqlite3) inside the Capacitor iOS app via NodeMobile.xcframework
(nodejs-mobile **v18.20.4** — the same runtime version as the Android host), so
an iPad can be the LAN host till. Proven end-to-end on the A16 iPad
(13 Aug 2026): `✅ EPOS server is running on port 3001`, sqlite 3.49.2
disk-backed.

Committed: `App/App/NodeHostPlugin.swift` (start/stop/status/getLanIp/
lastCrash/lastLog/saveConfig — same JS contract as Android, so
`client/src/native/nodeHost.js` works unchanged), the AppDelegate
`--start-host` dev hook, pbxproj wiring, and `App/nodejs-project/` minus
`node_modules/`. Gitignored (regenerate below): NodeMobile.xcframework,
node_modules, the sqlite build tree.

## 1. Node runtime
```
cd client/ios/node-host
curl -LO https://github.com/nodejs-mobile/nodejs-mobile/releases/download/v18.20.4/nodejs-mobile-v18.20.4-ios.zip
unzip nodejs-mobile-v18.20.4-ios.zip        # → NodeMobile.xcframework + include/
cp -R NodeMobile.xcframework ../App/        # the pbxproj references App/NodeMobile.xcframework
```
The framework exposes one entry point (`node_start`) and its module map lets
Swift `import NodeMobile` directly.

## 2. node_modules for the on-device server
```
cd client/ios/App/nodejs-project
npm install --omit=dev
```
Then two patches (both identical in spirit to the Android host — see
`client/android/node-host/BUILD.md`):
- **path-to-regexp small-ICU patch** — the embedded Node has reduced ICU;
  replace the `\p{ID_Start}` / `\p{ID_Continue}` regexes in
  `node_modules/path-to-regexp/dist/index.js` with ASCII classes.
  (Fastest: copy the already-patched file from the Android worktree.)
- **better-sqlite3 native binary** — replace
  `node_modules/better-sqlite3/build/Release/better_sqlite3.node`
  with the iOS build from step 3. It must be the **plain Mach-O file**, NOT
  the framework-style `.node/` directory gyp produces — the `bindings`
  resolver stats for a file and a directory fails module resolution
  (first on-device boot died exactly there).

## 3. Cross-compile better-sqlite3 for iOS arm64
better-sqlite3 **11.10.0**, toolchain **nodejs-mobile-gyp@0.4.0** + Xcode clang.
```
cd client/ios/node-host && mkdir build-sqlite && cd build-sqlite
npm init -y && npm i --no-save nodejs-mobile-gyp@0.4.0
npm pack better-sqlite3@11.10.0 && tar xzf better-sqlite3-11.10.0.tgz && cd package
export GYP_DEFINES="OS=ios iossim=false"     # iossim MUST be defined or gyp errors
../node_modules/.bin/nodejs-mobile-gyp configure --arch=arm64 --nodedir=../.. --format=make-ios
SDK=$(xcrun --sdk iphoneos --show-sdk-path)
export CC="$(xcrun -find clang) -arch arm64 -miphoneos-version-min=13.0 -isysroot $SDK"
export CXX="$(xcrun -find clang++) -arch arm64 -miphoneos-version-min=13.0 -isysroot $SDK"
export CC_target="$CC" CXX_target="$CXX"
../node_modules/.bin/nodejs-mobile-gyp build
# artifact: build/Release/better_sqlite3.node/better_sqlite3  (Mach-O arm64)
# copy that INNER BINARY to nodejs-project/node_modules/better-sqlite3/build/Release/better_sqlite3.node
```
`--nodedir` points at node-host/ (the zip's `include/node` carries common.gypi +
config.gypi). `-undefined dynamic_lookup` warnings are expected — symbols bind
to the NodeMobile framework at dlopen.

## 4. Refresh the embedded backend (EVERY release — same rule as Android)
```
cd <ios worktree root>
P=client/ios/App/nodejs-project
rsync -a --delete --exclude 'screens' src/ $P/backend-src/
rsync -a --delete public/ $P/public/
(cd client && npm run build) && rsync -a client/dist/ $P/public/
```
`npx cap sync ios` does NOT touch nodejs-project — it is a plain folder
reference resource. Stale-backend gotcha memory:
`project_host_apk_embedded_sync_gotcha` applies to iOS too.

## 5. Build + sign + install (device)
```
cd client/ios/App
xcodebuild -project App.xcodeproj -scheme App -configuration Debug \
  -destination 'generic/platform=iOS' -allowProvisioningUpdates build
APP=~/Library/Developer/Xcode/DerivedData/App-*/Build/Products/Debug-iphoneos/App.app
ID="Apple Development: Korakot Kongponsrisiri (D47ACH6QY3)"   # SiamEPOS LTD team G6D63G9WVY
# .node dylibs are bundle RESOURCES — sign them, then reseal the app:
find $APP/nodejs-project -name '*.node' -type f -exec codesign --force --sign "$ID" {} \;
codesign --force --sign "$ID" --preserve-metadata=identifier,entitlements,flags $APP
xcrun devicectl device install app --device <UDID> $APP
```

## 6. Hands-free verification
```
xcrun devicectl device process launch --device <UDID> uk.co.siamepos.pos --start-host
# breadcrumbs (main.js writes them to Documents/node-host-data/):
xcrun devicectl device copy from --device <UDID> --domain-type appDataContainer \
  --domain-identifier uk.co.siamepos.pos \
  --source Documents/node-host-data/node-host-log.txt --destination /tmp/log.txt
# then: curl http://<ipad-ip>:3001/api/health
```

## Architecture notes / iOS-specific rules
- **No extraction step** (unlike Android): node runs main.js straight from the
  signed app bundle; writable data goes to `Documents/node-host-data` via
  `NODE_HOST_DATA_DIR`; `host-config.json` lives in `Documents/`.
- **node_start is once-per-process** — no in-process restart; `stop` tells the
  operator to close the app. Config changes need an app relaunch.
- **Local Network permission** (iOS 14+): inbound connections to the listener
  are gated — the one-time "find and connect to devices on your local
  network" prompt MUST be accepted or satellites/curl can't reach port 3001.
- **Kiosk posture**: `isIdleTimerDisabled` is set while hosting (screen stays
  awake); run plugged in. iOS suspends backgrounded apps — the host app must
  stay foreground (Guided Access recommended for real venues).
- App Store note: dlopen'ing bare .node dylibs from resources is fine for
  dev/TestFlight; App Store review may require moving them into Frameworks/ —
  revisit at submission time.
