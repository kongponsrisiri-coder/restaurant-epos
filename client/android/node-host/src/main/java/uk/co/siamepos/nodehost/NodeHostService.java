package uk.co.siamepos.nodehost;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.IBinder;
import android.util.Log;

/**
 * Foreground service that owns the embedded Node.js host lifecycle (Phase 1
 * step 4).
 *
 * WHY: in v1.7 Node was started on a bare daemon thread inside the normal app
 * process. When the till is backgrounded or the screen sleeps, Android freezes
 * /kills the process and the host dies — satellite tills lose the server. A
 * production host till must keep Node alive 24/7, so we anchor it to an Android
 * foreground service with an ongoing notification. While that notification is
 * up Android treats the process as user-visible and will not doze/kill it under
 * normal conditions.
 *
 * The service does NOT change WHAT Node serves — it still calls
 * NodeHostPlugin.bootstrap(), which runs the identical preconditions + native
 * crash handler + node thread that bind 0.0.0.0:3001. The service is purely
 * about KEEPING it alive.
 */
public class NodeHostService extends Service {

  public static final String ACTION_START = "uk.co.siamepos.nodehost.START";
  public static final String ACTION_STOP  = "uk.co.siamepos.nodehost.STOP";

  private static final String CHANNEL_ID = "siamepos_host";
  private static final int NOTIFICATION_ID = 4201;

  @Override
  public int onStartCommand(Intent intent, int flags, int startId) {
    String action = intent != null ? intent.getAction() : ACTION_START;
    Log.d(NodeHostPlugin.TAG, "NodeHostService.onStartCommand action=" + action);

    if (ACTION_STOP.equals(action)) {
      // Operator tapped "Stop host server". Tear down the foreground state and
      // stop the service. (libnode cannot be cleanly unwound in-process, but
      // removing the foreground notification lets Android reclaim the process.)
      stopForegroundCompat();
      stopSelf();
      return START_NOT_STICKY;
    }

    // ACTION_START (default): become a foreground service FIRST (must happen
    // within ~5s of startForegroundService, ON THE MAIN THREAD), then bootstrap
    // Node off the main thread.
    try {
      createChannel();
      startForeground(NOTIFICATION_ID, buildNotification("Starting host…"));
    } catch (Throwable t) {
      Log.e(NodeHostPlugin.TAG, "startForeground failed", t);
      // Without foreground status Android will kill us shortly; bail cleanly.
      stopSelf();
      return START_NOT_STICKY;
    }

    // CRITICAL (ANR fix): onStartCommand runs on the MAIN/UI thread. bootstrap()
    // does first-launch asset extraction of the ~78 MB nodejs-project + native
    // .so load + node start — all synchronously. Running that inline here froze
    // the UI and produced "SiamEPOS isn't responding" (ANR). v1.7 ran it on a
    // daemon thread via the plugin; the service refactor regressed it. Move ALL
    // heavy work onto a dedicated background thread so onStartCommand returns
    // immediately. The notification is already up, so the operator sees
    // "Starting host…" while the unpack runs (~10-30s on first launch).
    final Context appCtx = getApplicationContext();
    new Thread(() -> {
      try {
        NodeHostPlugin.bootstrap(appCtx);
        // Update the notification text now we know where it is listening.
        updateNotification("Host running · http://" + lanIp() + ":" + NodeHostPlugin.PORT);
      } catch (Throwable t) {
        Log.e(NodeHostPlugin.TAG, "NodeHostService bootstrap failed (service stays up)", t);
        updateNotification("Host start failed — open SiamEPOS to see why");
      }
    }, "node-host-boot").start();

    // START_STICKY: if Android does kill us under memory pressure, it will try
    // to recreate the service (with a null intent → treated as ACTION_START)
    // and Node bootstraps again, restoring the host.
    return START_STICKY;
  }

  @Override
  public IBinder onBind(Intent intent) {
    return null; // not a bound service
  }

  @Override
  public void onDestroy() {
    Log.d(NodeHostPlugin.TAG, "NodeHostService.onDestroy");
    super.onDestroy();
  }

  // ---- notification plumbing ----

  private void createChannel() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
      if (nm != null && nm.getNotificationChannel(CHANNEL_ID) == null) {
        NotificationChannel ch = new NotificationChannel(
            CHANNEL_ID, "SiamEPOS host", NotificationManager.IMPORTANCE_LOW);
        ch.setDescription("Keeps the SiamEPOS LAN host server running for connected tills.");
        ch.setShowBadge(false);
        nm.createNotificationChannel(ch);
      }
    }
  }

  private Notification buildNotification(String text) {
    Notification.Builder b;
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      b = new Notification.Builder(this, CHANNEL_ID);
    } else {
      b = new Notification.Builder(this);
    }
    b.setContentTitle("SiamEPOS — host running")
     .setContentText(text)
     .setSmallIcon(android.R.drawable.stat_sys_upload) // generic, no extra asset needed
     .setOngoing(true)
     .setOnlyAlertOnce(true);

    // Tapping the notification reopens the SiamEPOS app.
    try {
      Intent launch = getPackageManager().getLaunchIntentForPackage(getPackageName());
      if (launch != null) {
        int flags = PendingIntent.FLAG_UPDATE_CURRENT
            | (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M ? PendingIntent.FLAG_IMMUTABLE : 0);
        PendingIntent pi = PendingIntent.getActivity(this, 0, launch, flags);
        b.setContentIntent(pi);
      }
    } catch (Throwable ignore) {}

    return b.build();
  }

  private void updateNotification(String text) {
    try {
      NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
      if (nm != null) nm.notify(NOTIFICATION_ID, buildNotification(text));
    } catch (Throwable ignore) {}
  }

  @SuppressWarnings("deprecation")
  private void stopForegroundCompat() {
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
        stopForeground(Service.STOP_FOREGROUND_REMOVE);
      } else {
        stopForeground(true);
      }
    } catch (Throwable t) {
      Log.w(NodeHostPlugin.TAG, "stopForeground failed", t);
    }
  }

  /** Best-effort LAN IPv4 for the notification text. Falls back to "this device". */
  private String lanIp() {
    try {
      WifiManager wm = (WifiManager) getApplicationContext().getSystemService(Context.WIFI_SERVICE);
      if (wm != null) {
        int ip = wm.getConnectionInfo().getIpAddress();
        if (ip != 0) {
          return String.format("%d.%d.%d.%d",
              (ip & 0xff), (ip >> 8 & 0xff), (ip >> 16 & 0xff), (ip >> 24 & 0xff));
        }
      }
    } catch (Throwable ignore) {}
    return "this device";
  }
}
