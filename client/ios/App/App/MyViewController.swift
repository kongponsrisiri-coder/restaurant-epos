// SEPOS-IOS-001 — registers the app-embedded PrinterPlugin with the bridge.
//
// Why not capacitor.config.json's "packageClassList" alone (BUILD-IOS.md
// step 4)? @capacitor/cli 8.4.1 REGENERATES the native copy
// (ios/App/App/capacitor.config.json) of packageClassList on every
// `npx cap sync ios` from the npm plugins it scans
// (cli/dist/util/iosplugin.js → writePluginJSON), so an app-embedded class
// is stripped again on each sync. Registering the instance here is the
// officially documented, sync-proof path for in-app plugins
// (capacitorjs.com → iOS → Custom Native Code). The packageClassList entry
// is kept in client/capacitor.config.json as documentation/belt-and-braces;
// double registration is harmless (bridge just logs "Overriding existing
// registered plugin").
//
// Main.storyboard's Bridge View Controller points at this class
// (customClass="MyViewController" customModuleProvider="target").

import UIKit
import Capacitor

class MyViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(PrinterPlugin())
    }
}
