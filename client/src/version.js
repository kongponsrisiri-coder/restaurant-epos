// Single source for the app build version, printed on kitchen tickets + receipts
// so you can tell at a glance which build produced a given printout (removes the
// "did the update actually land on this till?" guesswork).
//
// ⚠️ Bump this in the SAME commit as android/app/build.gradle versionName on
// every release.
export const APP_VERSION = '1.4.60';
