package uk.co.siamepos.app;

import android.os.Bundle;
import android.view.WindowManager;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // SEPOS-ANDROID-001 — register the native raw-ESC/POS printer plugin.
        registerPlugin(PrinterPlugin.class);
        super.onCreate(savedInstanceState);
        // SEPOS-ANDROID-001 — keep the screen on. This app runs as a fixed till /
        // kitchen display: a KDS must stay lit through service and a till must not
        // sleep mid-order. Devices are mains-powered, so no battery trade-off.
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
    }
}
