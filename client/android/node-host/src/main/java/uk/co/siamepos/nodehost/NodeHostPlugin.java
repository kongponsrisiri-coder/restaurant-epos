package uk.co.siamepos.nodehost;

import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;
import android.system.ErrnoException;
import android.system.Os;
import android.util.Log;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.janeasystems.rn_nodejs_mobile.RNNodeJsMobileModule;

import android.content.res.AssetManager;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;

/**
 * Phase 0 host spike — Capacitor plugin that embeds a Node.js runtime.
 *
 * On load() it copies the bundled nodejs-project (Express + sql.js ping server)
 * from APK assets into the app's filesDir, then starts node on a background
 * thread. The node server binds 0.0.0.0:3001 so other LAN devices can reach it.
 *
 * Reuses the prebuilt libnode.so + JNI bridge from nodejs-mobile-react-native,
 * but with zero React Native dependency.
 *
 * CRASH-PROOFING (hostspike3): Node is now started MANUALLY, never on launch.
 *   - load() does ZERO native work — no System.loadLibrary, no node start,
 *     nothing that can abort. The app ALWAYS launches 100% clean to the normal
 *     SiamEPOS EPOS.
 *   - start() (a @PluginMethod) performs all the guarded preconditions
 *     (supported ABI, assets extracted, .so present + loads, main.js exists),
 *     installs the native crash handler, then launches node on a daemon thread.
 *     Only called when the operator taps "Start host server" in Settings.
 *   - node::Start() can SIGABRT natively (uncatchable in Java). crash_handler.cpp
 *     installs POSIX signal handlers that write the abort reason + backtrace to a
 *     file BEFORE the process dies. lastCrash() returns that file's contents so
 *     the next app launch can show the diagnosis (no USB logcat needed).
 *   - status() reports started/port/abi/node/error/sqlite without needing start.
 */
@CapacitorPlugin(name = "NodeHost")
public class NodeHostPlugin extends Plugin {

  static final String TAG = "NODEHOST";
  private static final String PROJECT_DIR = "nodejs-project";
  static final int PORT = 3001;          // matches main.js
  static final int FALLBACK_PORT = 8081; // matches main.js
  private static final String CRASH_FILE = "node-host-crash.txt"; // in filesDir
  private static final String LOG_FILE = "node-host-log.txt";     // in projectPath (cwd of node)
  // On-device cloud-sync config (cloud_api_url / restaurant_id / sync_secret).
  // Lives in filesDir (NOT projectPath, which bootstrap() wipes on every start)
  // so it survives app restarts and re-extractions. main.js reads it on boot to
  // set CLOUD_API_URL etc. before requiring the backend. Secrets stay on-device
  // in app-private storage — never in source, never in the APK.
  private static final String CONFIG_FILE = "host-config.json";   // in filesDir

  // Absolute path to the project dir node runs in (its cwd). main.js writes its
  // breadcrumb log there as node-host-log.txt; lastLog() reads it back. Set once
  // bootstrap() resolves it so lastLog() works even after node exits/crashes.
  private static volatile String projectDirPath = null;

  // ---- status fields (volatile: read from status() on any thread) ----
  private static volatile boolean started = false;     // node thread actually launched
  private static volatile boolean nativeReady = false;  // .so loaded + ABI ok
  private static volatile String startupError = null;   // first fatal error message+class
  private static volatile String abiName = null;        // resolved ABI
  private static volatile String nodeVersion = null;     // reported by main.js via /api/ping; null until queried
  private static volatile boolean attempted = false;

  @Override
  public void load() {
    // hostspike3: load() does ZERO native work. No System.loadLibrary, no node
    // start, no asset extraction — nothing that can SIGABRT/SIGSEGV. The app
    // launches 100% clean. Node only starts when start() is explicitly called
    // from the Settings "Start host server" button.
  }

  /**
   * MANUAL entry point — starts the embedded Node host inside an Android
   * FOREGROUND SERVICE so Android won't freeze/kill it when the app is
   * backgrounded or the screen sleeps (Phase 1 step 4). The service owns the
   * Node lifecycle: it runs the same guarded preconditions + crash-handler +
   * node thread (via bootstrap()) and posts an ongoing notification so the OS
   * keeps the process alive. A production host till needs Node anchored here.
   *
   * Never throws out of Capacitor — always resolves with the current status.
   */
  @PluginMethod
  public void start(PluginCall call) {
    try {
      Context ctx = getContext();
      Intent svc = new Intent(ctx, NodeHostService.class);
      svc.setAction(NodeHostService.ACTION_START);
      // Android 8+ requires startForegroundService(); the service then has a
      // few seconds to call startForeground() with its notification.
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        ctx.startForegroundService(svc);
      } else {
        ctx.startService(svc);
      }
      Log.d(TAG, "start() -> requested NodeHostService (foreground)");
    } catch (Throwable t) {
      recordError("start() service launch", t);
      Log.e(TAG, "start() service launch failed (app continues normally)", t);
    }
    // Return the same shape as status() so the UI can refresh from this call.
    status(call);
  }

  /**
   * Stops the foreground service (and therefore the host). Node itself cannot be
   * cleanly torn down from Java once libnode is running in-process, so stopping
   * the service removes the ongoing notification and lets Android reclaim the
   * process when the activity is also gone. The satellite tills will lose the
   * server, which is the intended effect of an explicit "Stop host server".
   * Never throws — resolves with the current status.
   */
  @PluginMethod
  public void stop(PluginCall call) {
    try {
      Context ctx = getContext();
      Intent svc = new Intent(ctx, NodeHostService.class);
      svc.setAction(NodeHostService.ACTION_STOP);
      ctx.startService(svc); // delivers ACTION_STOP; service stops itself
      Log.d(TAG, "stop() -> requested NodeHostService stop");
    } catch (Throwable t) {
      recordError("stop() service", t);
      Log.e(TAG, "stop() service failed", t);
    }
    status(call);
  }

  /**
   * Asks Android to exempt SiamEPOS from battery optimisation / Doze so the
   * host service keeps running while the till is idle/asleep. On Sunmi and many
   * OEM skins the foreground service alone is not always enough — Doze can still
   * throttle it. This opens the system dialog requesting the exemption.
   *
   * Returns { ignoring: <bool>, requested: <bool> }. If already exempt we don't
   * re-prompt. Never throws.
   */
  @PluginMethod
  public void requestIgnoreBatteryOptimizations(PluginCall call) {
    JSObject ret = new JSObject();
    boolean ignoring = false;
    boolean requested = false;
    try {
      Context ctx = getContext();
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
        PowerManager pm = (PowerManager) ctx.getSystemService(Context.POWER_SERVICE);
        String pkg = ctx.getPackageName();
        ignoring = pm != null && pm.isIgnoringBatteryOptimizations(pkg);
        if (!ignoring) {
          Intent i = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
          i.setData(Uri.parse("package:" + pkg));
          i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
          ctx.startActivity(i);
          requested = true;
        }
      } else {
        ignoring = true; // pre-M had no Doze
      }
    } catch (Throwable t) {
      Log.w(TAG, "requestIgnoreBatteryOptimizations failed", t);
    }
    ret.put("ignoring", ignoring);
    ret.put("requested", requested);
    call.resolve(ret);
  }

  /**
   * Runs all guarded preconditions, installs the native crash handler, then
   * launches node on a daemon thread. Idempotent (guarded by `attempted`).
   * Called by NodeHostService once it is in the foreground so the Node process
   * is anchored to the service for its whole lifetime. Static so the service can
   * drive it with its own Context.
   */
  static synchronized void bootstrap(Context ctx) {
    if (attempted) return;
    attempted = true;

    abiName = resolveAbi();
    Log.d(TAG, "bootstrap: device primary ABI=" + abiName + " sdk=" + Build.VERSION.SDK_INT);

    // --- Precondition 1: supported ABI ---
    if (!"arm64-v8a".equals(abiName) && !"armeabi-v7a".equals(abiName)) {
      recordError("unsupported ABI", new IllegalStateException(
          "Device ABI '" + abiName + "' has no bundled libnode.so (only arm64-v8a / armeabi-v7a shipped)"));
      return; // skip — app still runs
    }

    // --- Precondition 2: extract nodejs-project from assets ---
    final String filesDir = ctx.getFilesDir().getAbsolutePath();
    final String projectPath = filesDir + "/" + PROJECT_DIR;
    projectDirPath = projectPath; // so lastLog() can find node-host-log.txt
    try {
      Os.setenv("TMPDIR", ctx.getCacheDir().getAbsolutePath(), true);
    } catch (Throwable e) {
      Log.w(TAG, "Could not set TMPDIR (non-fatal)", e);
    }
    // Tell main.js exactly where it may write its breadcrumb log. node inherits
    // this process's env, so setting it before startNodeWithArguments is enough.
    try {
      Os.setenv("NODE_HOST_DATA_DIR", projectPath, true);
    } catch (Throwable e) {
      Log.w(TAG, "Could not set NODE_HOST_DATA_DIR (non-fatal)", e);
    }
    final String mainJs = projectPath + "/main.js";
    try {
      File projectDir = new File(projectPath);
      if (projectDir.exists()) deleteRecursively(projectDir);
      copyAssetFolder(ctx.getAssets(), PROJECT_DIR, projectPath);
    } catch (Throwable e) {
      recordError("asset extraction", e);
      return; // skip — app still runs
    }
    if (!new File(mainJs).exists()) {
      recordError("main.js missing", new IOException("Expected entry point not found after extraction: " + mainJs));
      return;
    }

    // --- Precondition 3: native libraries load (UnsatisfiedLinkError is an
    //     Error, not Exception — guard explicitly). Touch the JNI class so its
    //     static { System.loadLibrary } initializer runs HERE inside try/catch,
    //     not lazily at first use where it could escape. ---
    try {
      RNNodeJsMobileModule.ensureLoaded();
      // Sanity: the native ABI must match what the device reports, else node
      // will load the wrong libnode and abort.
      String nativeAbi = RNNodeJsMobileModule.getCurrentABIName();
      Log.d(TAG, "native libs loaded; native lib ABI=" + nativeAbi);
      RNNodeJsMobileModule.registerNodeDataDirPath(filesDir);
      nativeReady = true;
    } catch (UnsatisfiedLinkError e) {
      recordError("native library load (UnsatisfiedLinkError)", e);
      return;
    } catch (Throwable e) {
      recordError("native init", e);
      return;
    }

    // --- Install the native crash catcher BEFORE node can abort. It writes the
    //     signal + backtrace to filesDir/node-host-crash.txt on SIGABRT etc. so
    //     the next launch can show why (no USB logcat on the Sunmi). ---
    final String crashFilePath = filesDir + "/" + CRASH_FILE;
    // Clear any previous crash report now that we are about to (re)launch node.
    // If node aborts again the handler rewrites it; if it runs fine the stale
    // report is gone so the card won't show an old crash forever.
    try { new File(crashFilePath).delete(); } catch (Throwable ignore) {}
    try {
      RNNodeJsMobileModule.installCrashHandler(crashFilePath);
      Log.d(TAG, "crash handler installed -> " + crashFilePath);
    } catch (Throwable e) {
      // Non-fatal: node can still try to start, we just lose the file on crash.
      Log.w(TAG, "could not install native crash handler (continuing)", e);
    }

    // --- All preconditions pass: start node on a DEDICATED background thread. ---
    Log.d(TAG, "preconditions ok — launching node thread for " + mainJs);
    Thread t = new Thread(() -> {
      try {
        started = true;
        int code = RNNodeJsMobileModule.startNodeWithArguments(
            new String[]{"node", mainJs},
            projectPath,
            true /* redirect stdout/stderr to logcat */
        );
        Log.d(TAG, "node exited with code " + code);
        // If node returns, the server is no longer running.
        started = false;
        if (startupError == null && code != 0) {
          startupError = "node exited with code " + code;
        }
      } catch (Throwable e) {
        started = false;
        recordError("node thread", e);
        Log.e(TAG, "node thread threw (app continues normally)", e);
      }
    }, "node-main");
    t.setDaemon(true);
    t.start();
  }

  private static void recordError(String where, Throwable t) {
    if (startupError == null) {
      String msg = (t.getMessage() != null ? t.getMessage() : "(no message)");
      startupError = "[" + where + "] " + t.getClass().getSimpleName() + ": " + msg;
    }
    Log.e(TAG, "error @ " + where, t);
  }

  private static String resolveAbi() {
    try {
      String[] abis = Build.SUPPORTED_ABIS;
      if (abis != null && abis.length > 0) return abis[0];
    } catch (Throwable ignore) {}
    return "unknown";
  }

  /**
   * Native-only status surface. Safe to call regardless of whether node
   * started — never throws. Lets the Sunmi screen show the root cause.
   * Shape: { started, port, abi, node, error, sqlite }.
   * Note: sqlite + live node version come from the running server's /api/ping;
   * the JS wrapper merges that in. Java reports what it knows.
   */
  @PluginMethod
  public void status(PluginCall call) {
    JSObject ret = new JSObject();
    try {
      ret.put("started", started);
      ret.put("port", started ? PORT : null); // best-effort; fallback handled JS-side via ping
      ret.put("fallbackPort", FALLBACK_PORT);
      ret.put("abi", abiName != null ? abiName : resolveAbi());
      ret.put("nativeReady", nativeReady);
      ret.put("node", nodeVersion); // populated by JS after a successful ping
      ret.put("error", startupError);
      ret.put("sqlite", false);     // authoritative value comes from /api/ping, merged JS-side
    } catch (Throwable t) {
      // Even status must never crash the WebView.
      try { ret.put("error", "status() failed: " + t); } catch (Throwable ignore) {}
    }
    call.resolve(ret);
  }

  /**
   * Returns this device's LAN IPv4 address so the "Add a till" card can build the
   * satellite join URL (http://<lan-ip>:3001). Tries the Wi-Fi DHCP lease first
   * (same source the foreground-service notification uses), then falls back to
   * enumerating non-loopback IPv4 network interfaces so Ethernet / USB-tether /
   * hotspot also work. Shape: { ip: "192.168.x.y" | null, port: 3001 }. Never
   * throws — resolves { ip: null } if nothing usable is found.
   */
  @PluginMethod
  public void getLanIp(PluginCall call) {
    JSObject ret = new JSObject();
    ret.put("ip", resolveLanIp(getContext()));
    ret.put("port", PORT);
    call.resolve(ret);
  }

  /** Best-effort LAN IPv4. Wi-Fi lease first, then interface enumeration. */
  static String resolveLanIp(Context ctx) {
    // 1) Wi-Fi DHCP lease — fast and correct on the common Sunmi-on-Wi-Fi setup.
    try {
      android.net.wifi.WifiManager wm =
          (android.net.wifi.WifiManager) ctx.getApplicationContext().getSystemService(Context.WIFI_SERVICE);
      if (wm != null) {
        int ip = wm.getConnectionInfo().getIpAddress();
        if (ip != 0) {
          return String.format("%d.%d.%d.%d",
              (ip & 0xff), (ip >> 8 & 0xff), (ip >> 16 & 0xff), (ip >> 24 & 0xff));
        }
      }
    } catch (Throwable ignore) {}
    // 2) Enumerate interfaces — covers Ethernet / tether / hotspot where the
    //    Wi-Fi manager reports 0. Pick the first non-loopback site-local IPv4.
    try {
      java.util.Enumeration<java.net.NetworkInterface> ifaces = java.net.NetworkInterface.getNetworkInterfaces();
      while (ifaces != null && ifaces.hasMoreElements()) {
        java.net.NetworkInterface ni = ifaces.nextElement();
        try {
          if (!ni.isUp() || ni.isLoopback()) continue;
        } catch (Throwable ignore) { continue; }
        java.util.Enumeration<java.net.InetAddress> addrs = ni.getInetAddresses();
        while (addrs.hasMoreElements()) {
          java.net.InetAddress a = addrs.nextElement();
          if (a.isLoopbackAddress()) continue;
          if (a instanceof java.net.Inet4Address && a.isSiteLocalAddress()) {
            return a.getHostAddress();
          }
        }
      }
    } catch (Throwable ignore) {}
    return null;
  }

  /**
   * Returns the contents of the native crash file written by crash_handler.cpp
   * on the LAST fatal signal, or null if there is none. We KEEP the file (do not
   * delete on read) so it persists across launches until a successful start()
   * clears it — that way the operator can reopen the app after a crash and still
   * read the reason. Shape: { crash: "<text>" | null }.
   */
  @PluginMethod
  public void lastCrash(PluginCall call) {
    JSObject ret = new JSObject();
    String contents = null;
    try {
      Context ctx = getContext();
      File f = new File(ctx.getFilesDir(), CRASH_FILE);
      if (f.exists() && f.length() > 0) {
        contents = readFileUtf8(f);
      }
    } catch (Throwable t) {
      Log.w(TAG, "lastCrash() read failed", t);
    }
    ret.put("crash", contents);
    call.resolve(ret);
  }

  /**
   * Returns the breadcrumb log main.js writes (node-host-log.txt) from the node
   * project dir — the same writable path node runs in. This is how the human
   * reads exactly where the JS server died (uncaught throw / sql.js WASM fail /
   * which port it bound) without USB logcat. Persists across launches until the
   * next start() truncates it. Shape: { log: "<text>" | null }.
   */
  @PluginMethod
  public void lastLog(PluginCall call) {
    JSObject ret = new JSObject();
    String contents = null;
    try {
      String dir = projectDirPath;
      if (dir == null) {
        // bootstrap() hasn't run this session — fall back to the conventional path.
        dir = getContext().getFilesDir().getAbsolutePath() + "/" + PROJECT_DIR;
      }
      File f = new File(dir, LOG_FILE);
      if (f.exists() && f.length() > 0) {
        contents = readFileUtf8(f);
      }
    } catch (Throwable t) {
      Log.w(TAG, "lastLog() read failed", t);
    }
    ret.put("log", contents);
    call.resolve(ret);
  }

  /**
   * Persists the cloud-sync config the operator enters on the Sunmi (cloud API
   * URL, restaurant id, optional sync secret) to filesDir/host-config.json so
   * the next host start (main.js) can read it and point the pull at the right
   * cloud. Stored in app-private storage — secrets never leave the device and
   * are never compiled into the APK. Shape in: { cloud_api_url, restaurant_id,
   * sync_secret }. Resolves { saved: true } / { saved:false, error }.
   *
   * NOTE: changing config requires a host restart (Stop then Start) to take
   * effect, since main.js reads it once at boot — the UI tells the operator so.
   */
  @PluginMethod
  public void saveConfig(PluginCall call) {
    JSObject ret = new JSObject();
    try {
      File f = new File(getContext().getFilesDir(), CONFIG_FILE);
      // Read any existing values first so an absent key in this call PRESERVES
      // what was there (e.g. saving cloud settings shouldn't blank the
      // restaurant name set at one-tap host setup, and vice-versa).
      String prevName = "";
      try {
        if (f.exists() && f.length() > 0) prevName = extractJsonString(readFileUtf8(f), "restaurant_name");
      } catch (Throwable ignore) {}

      String cloudApiUrl = call.getString("cloud_api_url", "");
      String restaurantId = call.getString("restaurant_id", "");
      String syncSecret = call.getString("sync_secret", "");
      // restaurant_name — only overwrite when the caller supplied it; otherwise
      // keep the previously stored value. Applied to local settings (company_name)
      // by main.js on boot so the standalone host shows the name in the POS.
      String restaurantName = call.getString("restaurant_name", null);
      if (restaurantName == null) restaurantName = prevName;
      // v1.13-standalone: cloud sync is OPT-IN, default OFF. Stored as "1"/"0"
      // string so the tolerant extractor + main.js flagOn() both read it cleanly.
      boolean cloudSyncEnabled = call.getBoolean("cloud_sync_enabled", false);
      // Minimal JSON by hand to avoid an extra dependency. Values are escaped.
      StringBuilder sb = new StringBuilder();
      sb.append("{\n");
      sb.append("  \"cloud_sync_enabled\": \"").append(cloudSyncEnabled ? "1" : "0").append("\",\n");
      sb.append("  \"cloud_api_url\": \"").append(jsonEscape(cloudApiUrl)).append("\",\n");
      sb.append("  \"restaurant_id\": \"").append(jsonEscape(restaurantId)).append("\",\n");
      sb.append("  \"restaurant_name\": \"").append(jsonEscape(restaurantName)).append("\",\n");
      sb.append("  \"sync_secret\": \"").append(jsonEscape(syncSecret)).append("\"\n");
      sb.append("}\n");
      try (OutputStream out = new FileOutputStream(f)) {
        out.write(sb.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8));
        out.flush();
      }
      Log.d(TAG, "saveConfig: wrote " + f.getAbsolutePath() + " (cloudSync=" + cloudSyncEnabled + ", cloud=" + cloudApiUrl + ", rid=" + restaurantId + ", secret=" + (syncSecret.isEmpty() ? "none" : "set") + ")");
      ret.put("saved", true);
    } catch (Throwable t) {
      Log.e(TAG, "saveConfig failed", t);
      ret.put("saved", false);
      ret.put("error", String.valueOf(t.getMessage()));
    }
    call.resolve(ret);
  }

  /**
   * Returns the saved cloud-sync config so the Settings card can pre-fill the
   * form. Never returns the sync_secret in cleartext to avoid shoulder-surfing —
   * instead a boolean has_sync_secret flag. Shape out: { cloud_api_url,
   * restaurant_id, has_sync_secret }. Empty/defaults if nothing saved yet.
   */
  @PluginMethod
  public void getConfig(PluginCall call) {
    JSObject ret = new JSObject();
    String cloudApiUrl = "";
    String restaurantId = "";
    String restaurantName = "";
    boolean hasSecret = false;
    boolean cloudSyncEnabled = false;
    try {
      File f = new File(getContext().getFilesDir(), CONFIG_FILE);
      if (f.exists() && f.length() > 0) {
        String json = readFileUtf8(f);
        cloudApiUrl = extractJsonString(json, "cloud_api_url");
        restaurantId = extractJsonString(json, "restaurant_id");
        restaurantName = extractJsonString(json, "restaurant_name");
        hasSecret = !extractJsonString(json, "sync_secret").isEmpty();
        String flag = extractJsonString(json, "cloud_sync_enabled");
        cloudSyncEnabled = flag.equals("1") || flag.equalsIgnoreCase("true");
      }
    } catch (Throwable t) {
      Log.w(TAG, "getConfig read failed", t);
    }
    ret.put("cloud_sync_enabled", cloudSyncEnabled);
    ret.put("cloud_api_url", cloudApiUrl);
    ret.put("restaurant_id", restaurantId);
    ret.put("restaurant_name", restaurantName);
    ret.put("has_sync_secret", hasSecret);
    call.resolve(ret);
  }

  private static String jsonEscape(String s) {
    if (s == null) return "";
    StringBuilder b = new StringBuilder();
    for (int i = 0; i < s.length(); i++) {
      char c = s.charAt(i);
      switch (c) {
        case '"': b.append("\\\""); break;
        case '\\': b.append("\\\\"); break;
        case '\n': b.append("\\n"); break;
        case '\r': b.append("\\r"); break;
        case '\t': b.append("\\t"); break;
        default: b.append(c);
      }
    }
    return b.toString();
  }

  // Tiny tolerant extractor for our own flat one-string-per-key JSON. Avoids a
  // JSON lib for the getConfig prefill path; main.js uses real JSON.parse.
  private static String extractJsonString(String json, String key) {
    try {
      String needle = "\"" + key + "\"";
      int k = json.indexOf(needle);
      if (k < 0) return "";
      int colon = json.indexOf(':', k + needle.length());
      if (colon < 0) return "";
      int q1 = json.indexOf('"', colon + 1);
      if (q1 < 0) return "";
      StringBuilder b = new StringBuilder();
      for (int i = q1 + 1; i < json.length(); i++) {
        char c = json.charAt(i);
        if (c == '\\' && i + 1 < json.length()) { b.append(json.charAt(++i)); continue; }
        if (c == '"') break;
        b.append(c);
      }
      return b.toString();
    } catch (Throwable t) { return ""; }
  }

  private static String readFileUtf8(File f) throws IOException {
    try (InputStream in = new java.io.FileInputStream(f)) {
      java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream();
      byte[] buf = new byte[4096];
      int n;
      while ((n = in.read(buf)) != -1) bos.write(buf, 0, n);
      return new String(bos.toByteArray(), java.nio.charset.StandardCharsets.UTF_8);
    }
  }

  // ---- asset copy helpers ----

  private static void copyAssetFolder(AssetManager am, String from, String to) throws IOException {
    String[] children = am.list(from);
    if (children == null || children.length == 0) {
      copyAssetFile(am, from, to);
    } else {
      new File(to).mkdirs();
      for (String child : children) {
        copyAssetFolder(am, from + "/" + child, to + "/" + child);
      }
    }
  }

  private static void copyAssetFile(AssetManager am, String from, String to) throws IOException {
    File parent = new File(to).getParentFile();
    if (parent != null) parent.mkdirs();
    try (InputStream in = am.open(from); OutputStream out = new FileOutputStream(to)) {
      byte[] buf = new byte[8192];
      int n;
      while ((n = in.read(buf)) != -1) out.write(buf, 0, n);
      out.flush();
    }
  }

  private static void deleteRecursively(File f) {
    File[] kids = f.listFiles();
    if (kids != null) for (File k : kids) deleteRecursively(k);
    f.delete();
  }
}
