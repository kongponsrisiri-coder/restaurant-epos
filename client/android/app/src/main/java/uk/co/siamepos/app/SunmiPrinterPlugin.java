package uk.co.siamepos.app;

import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.ServiceConnection;
import android.os.IBinder;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Rect;
import android.util.Base64;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONObject;

import woyou.aidlservice.jiuiv5.ICallback;
import woyou.aidlservice.jiuiv5.IWoyouService;

/**
 * SEPOS-ANDROID-002 — Sunmi built-in (inner) thermal printer.
 *
 * Binds the device's InnerPrinterService (AIDL, package woyou.aidlservice.jiuiv5)
 * and prints raw ESC/POS bytes via sendRAWData. The bytes are built ON-DEVICE
 * (client/src/native/escpos.js), so kitchen/bill tickets print even with no
 * internet. On a non-Sunmi device the service simply never binds and isAvailable
 * returns false, so the app falls back to the network-printer path.
 */
@CapacitorPlugin(name = "SunmiPrinter")
public class SunmiPrinterPlugin extends Plugin {

    private volatile IWoyouService woyouService = null;
    private boolean binding = false;

    private final ServiceConnection connService = new ServiceConnection() {
        @Override public void onServiceDisconnected(ComponentName name) { woyouService = null; }
        @Override public void onServiceConnected(ComponentName name, IBinder service) {
            woyouService = IWoyouService.Stub.asInterface(service);
        }
    };

    @Override
    public void load() {
        bindService();
    }

    private synchronized void bindService() {
        if (woyouService != null || binding) return;
        try {
            Intent intent = new Intent();
            intent.setPackage("woyou.aidlservice.jiuiv5");
            intent.setAction("woyou.aidlservice.jiuiv5.IWoyouService");
            Context ctx = getContext().getApplicationContext();
            binding = ctx.bindService(intent, connService, Context.BIND_AUTO_CREATE);
        } catch (Exception e) {
            binding = false;
        }
    }

    /** isAvailable() → { available: bool } — true only on a Sunmi device with the printer service. */
    @PluginMethod
    public void isAvailable(PluginCall call) {
        if (woyouService == null) bindService();
        JSObject ret = new JSObject();
        ret.put("available", woyouService != null);
        call.resolve(ret);
    }

    private static final ICallback NOOP_CB = new ICallback.Stub() {
        @Override public void onRunResult(boolean b) {}
        @Override public void onReturnString(String s) {}
        @Override public void onRaiseException(int c, String m) {}
        @Override public void onPrintResult(int c, String m) {}
    };

    private boolean awaitService() {
        if (woyouService == null) {
            bindService();
            for (int i = 0; i < 20 && woyouService == null; i++) {
                try { Thread.sleep(100); } catch (InterruptedException ignored) {}
            }
        }
        return woyouService != null;
    }

    /**
     * printOps({ ops: [ {op,...}, ... ] }) → renders a ticket via the Sunmi native
     * text API (UTF-8, so £ + Thai print correctly). Ops:
     *   {op:'align', v:0|1|2} · {op:'size', v:<float>} · {op:'bold', v:bool}
     *   {op:'text', v:'...'}  · {op:'feed', v:n} · {op:'cut'}
     */
    @PluginMethod
    public void printOps(final PluginCall call) {
        final JSArray ops = call.getArray("ops");
        if (ops == null) { call.reject("ops array required"); return; }
        new Thread(() -> {
            if (!awaitService()) { call.reject("Sunmi printer service not available"); return; }
            try {
                woyouService.printerInit(NOOP_CB);
                for (int i = 0; i < ops.length(); i++) {
                    JSONObject o = ops.getJSONObject(i);
                    switch (o.getString("op")) {
                        case "align": woyouService.setAlignment(o.getInt("v"), NOOP_CB); break;
                        case "size":  woyouService.setFontSize((float) o.getDouble("v"), NOOP_CB); break;
                        case "bold":  woyouService.sendRAWData(new byte[]{0x1B, 0x45, (byte) (o.getBoolean("v") ? 1 : 0)}, NOOP_CB); break;
                        case "text":  woyouService.printText(o.getString("v") + "\n", NOOP_CB); break;
                        case "image": {
                            byte[] img = Base64.decode(o.getString("v"), Base64.DEFAULT);
                            Bitmap src = BitmapFactory.decodeByteArray(img, 0, img.length);
                            if (src != null) {
                                // Flatten transparency onto WHITE (printBitmap renders
                                // transparent pixels as black → a solid block otherwise),
                                // scale to ~380 dots, and CENTRE it on a full-width (576
                                // dots = 80mm) white canvas so it prints centred.
                                int head = 576, maxW = Math.min(head, o.optInt("w", 380));
                                int w = src.getWidth(), h = src.getHeight();
                                float scale = w > maxW ? (float) maxW / w : 1f;
                                int nw = Math.max(1, Math.round(w * scale));
                                int nh = Math.max(1, Math.round(h * scale));
                                Bitmap flat = Bitmap.createBitmap(head, nh, Bitmap.Config.ARGB_8888);
                                Canvas cv = new Canvas(flat);
                                cv.drawColor(Color.WHITE);
                                int x = (head - nw) / 2;
                                cv.drawBitmap(src, null, new Rect(x, 0, x + nw, nh), null);
                                woyouService.printBitmap(flat, NOOP_CB);
                            }
                            break;
                        }
                        case "feed":  woyouService.lineWrap(o.optInt("v", 1), NOOP_CB); break;
                        case "cut":   woyouService.sendRAWData(new byte[]{0x1D, 0x56, 0x42, 0x00}, NOOP_CB); break;
                    }
                }
                JSObject ret = new JSObject(); ret.put("ok", true); call.resolve(ret);
            } catch (Exception e) { call.reject("sunmi print failed: " + e.getMessage()); }
        }).start();
    }

    /** sendRaw({ data: base64 ESC/POS }) → prints on the built-in printer. */
    @PluginMethod
    public void sendRaw(final PluginCall call) {
        final String dataB64 = call.getString("data");
        if (dataB64 == null) { call.reject("data (base64) is required"); return; }
        new Thread(() -> {
            if (woyouService == null) {
                bindService();
                // give the async bind a moment to connect on first use
                for (int i = 0; i < 20 && woyouService == null; i++) {
                    try { Thread.sleep(100); } catch (InterruptedException ignored) {}
                }
            }
            if (woyouService == null) { call.reject("Sunmi printer service not available"); return; }
            final byte[] bytes;
            try { bytes = Base64.decode(dataB64, Base64.DEFAULT); }
            catch (IllegalArgumentException e) { call.reject("data is not valid base64"); return; }
            try {
                woyouService.sendRAWData(bytes, new ICallback.Stub() {
                    @Override public void onRunResult(boolean isSuccess) {}
                    @Override public void onReturnString(String result) {}
                    @Override public void onRaiseException(int code, String msg) {}
                    @Override public void onPrintResult(int code, String msg) {}
                });
                JSObject ret = new JSObject();
                ret.put("ok", true);
                ret.put("bytes", bytes.length);
                call.resolve(ret);
            } catch (Exception e) {
                call.reject("sunmi print failed: " + e.getMessage());
            }
        }).start();
    }
}
