package uk.co.siamepos.app;

import android.content.Intent;
import android.net.Uri;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;

// SEPOS-ANDROID-AUTOUPDATE-001 (Korakot, 11 Sep) — one-tap update for the
// sideloaded satellite APK. A sideloaded app cannot self-install SILENTLY (only
// a Play-Store / device-owner install can), so the flow is: JS (appUpdate.js)
// checks the releases channel for a newer tablet-v* APK and, if the user taps
// "Update now", calls this plugin. We download the APK to the app cache and hand
// it to the Android package installer for the user to confirm. The version CHECK
// is entirely in JS; this plugin only does the download + install hand-off.
@CapacitorPlugin(name = "AppUpdate")
public class AppUpdatePlugin extends Plugin {

    @PluginMethod
    public void install(PluginCall call) {
        final String url = call.getString("url");
        if (url == null || url.isEmpty()) { call.reject("no url"); return; }
        new Thread(() -> {
            try {
                File apk = new File(getContext().getCacheDir(), "siamepos-update.apk");
                if (apk.exists()) apk.delete();

                HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
                c.setInstanceFollowRedirects(true);   // GitHub redirects the asset to its CDN (https->https)
                c.setConnectTimeout(30000);
                c.setReadTimeout(180000);
                c.connect();
                int code = c.getResponseCode();
                if (code / 100 != 2) { call.reject("download HTTP " + code); return; }

                try (InputStream in = c.getInputStream(); FileOutputStream out = new FileOutputStream(apk)) {
                    byte[] buf = new byte[8192];
                    int n;
                    while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
                    out.flush();
                }
                if (apk.length() < 1024) { call.reject("downloaded file too small"); return; }

                Uri uri = FileProvider.getUriForFile(
                        getContext(),
                        getContext().getPackageName() + ".fileprovider",
                        apk);
                Intent i = new Intent(Intent.ACTION_VIEW);
                i.setDataAndType(uri, "application/vnd.android.package-archive");
                i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(i);

                JSObject ret = new JSObject();
                ret.put("started", true);
                call.resolve(ret);
            } catch (Exception e) {
                call.reject("update failed: " + e.getMessage());
            }
        }).start();
    }
}
