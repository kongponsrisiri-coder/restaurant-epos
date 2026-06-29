package com.janeasystems.rn_nodejs_mobile;

import android.util.Log;

/**
 * JNI shim for the prebuilt nodejs-mobile libnode.so.
 *
 * The C++ bridge (native-lib.cpp) from nodejs-mobile-react-native mangles its
 * JNI symbols against THIS exact package + class name
 * (Java_com_janeasystems_rn_1nodejs_1mobile_RNNodeJsMobileModule_*), so the
 * package and class name MUST stay as-is even though we are not using React
 * Native. All React Native coupling has been removed; the Capacitor plugin
 * (uk.co.siamepos.nodehost.NodeHostPlugin) drives this class instead.
 *
 * CRASH-PROOFING (hostspike2): the libraries are NO LONGER loaded in a static
 * initializer. A static-init failure (UnsatisfiedLinkError — an Error, not an
 * Exception) would throw out of class-load and crash the app before the plugin
 * can catch it. Instead {@link #ensureLoaded()} loads them lazily so the caller
 * can wrap it in try/catch(Throwable) and degrade gracefully.
 */
public class RNNodeJsMobileModule {

  private static final String TAG = "NODEHOST-JNI";

  private static volatile boolean loaded = false;

  /**
   * Loads the native libraries exactly once. Safe to call repeatedly.
   * Throws UnsatisfiedLinkError if a library is missing/incompatible — the
   * caller is expected to catch it and record the failure rather than crash.
   */
  public static synchronized void ensureLoaded() {
    if (loaded) return;
    Log.d(TAG, "loading native libs: nodejs-mobile-react-native-native-lib + node");
    // Order matters: the bridge lib links against libnode, but the JNI loader
    // resolves symbols lazily, so loading libnode first is safest.
    System.loadLibrary("node");
    System.loadLibrary("nodejs-mobile-react-native-native-lib");
    loaded = true;
    Log.d(TAG, "native libs loaded ok");
  }

  // ---- native methods implemented in libnode bridge (native-lib.cpp) ----
  public static native void registerNodeDataDirPath(String dataDir);

  /**
   * Installs the native SIGABRT/SIGSEGV/SIGILL/SIGBUS/SIGFPE handler
   * (crash_handler.cpp). On a fatal signal it writes a diagnostic file to
   * {@code crashFilePath} (async-signal-safe) then re-raises the default
   * handler so the process still dies. Call this RIGHT BEFORE starting node.
   * Implemented in libnode bridge; only callable after {@link #ensureLoaded()}.
   */
  public static native void installCrashHandler(String crashFilePath);
  public static native String getCurrentABIName();
  public static native Integer startNodeWithArguments(String[] arguments,
                                                      String modulesPath,
                                                      boolean redirectOutputToLogcat);
  public static native void sendMessageToNodeChannel(String channelName, String msg);

  /**
   * Called from JNI (rcv_message in native-lib.cpp) when the node process
   * sends a message back over the bridge. For the Phase 0 ping spike we don't
   * route these anywhere; just log them so the channel is proven alive.
   */
  public static void sendMessageToApplication(String channelName, String msg) {
    Log.d(TAG, "node->app [" + channelName + "]: " + msg);
  }
}
