package uk.co.siamepos.app;

import android.os.Bundle;
import android.view.WindowManager;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // SEPOS-ANDROID-001 — register the native raw-ESC/POS printer plugin.
        registerPlugin(PrinterPlugin.class);
        // SEPOS-ANDROID-002 — register the Sunmi built-in (inner) printer plugin.
        registerPlugin(SunmiPrinterPlugin.class);
        super.onCreate(savedInstanceState);
        // SEPOS-ANDROID-001 — keep the screen on. This app runs as a fixed till /
        // kitchen display: a KDS must stay lit through service and a till must not
        // sleep mid-order. Devices are mains-powered, so no battery trade-off.
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        // SEPOS-ANDROID-001 — ignore the device's system font-scale. Sunmi tills
        // ship with a large system font that the WebView follows by default,
        // which blew the whole UI up ("everything looks big") even though the
        // viewport is full 1920px. Pin text to 100% so the app renders at its
        // designed size regardless of the device's font setting.
        try { this.bridge.getWebView().getSettings().setTextZoom(100); } catch (Exception e) {}
    }
}
