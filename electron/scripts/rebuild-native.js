#!/usr/bin/env node
// Rebuilds native modules in the root project's node_modules for Electron's Node ABI.
// We split the workspace (Electron in electron/, server in ../) so @electron/rebuild's
// dependency-tree walk doesn't reach root deps cleanly — calling prebuild-install
// per known native module is the reliable path.
//
// Run via: npm run rebuild:native  (from electron/)
// After this, system-Node usage of these modules will fail until you rebuild back
// (`cd .. && npm rebuild better-sqlite3`).

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const ELECTRON_VERSION = require('electron/package.json').version;
const ROOT_NODE_MODULES = path.resolve(__dirname, '..', '..', 'node_modules');

const NATIVE_MODULES = ['better-sqlite3'];

for (const mod of NATIVE_MODULES) {
  const dir = path.join(ROOT_NODE_MODULES, mod);
  if (!fs.existsSync(dir)) {
    console.log(`[rebuild-native] ${mod}: not installed in ${ROOT_NODE_MODULES}, skipping`);
    continue;
  }
  console.log(`[rebuild-native] ${mod} → Electron ${ELECTRON_VERSION}`);
  execSync(
    `npx prebuild-install --runtime electron --target ${ELECTRON_VERSION} --force`,
    { cwd: dir, stdio: 'inherit' }
  );
}

console.log('[rebuild-native] done');
