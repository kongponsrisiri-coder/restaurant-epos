package uk.co.siamepos.app;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // SEPOS-ANDROID-001 — register the native raw-ESC/POS printer plugin.
        registerPlugin(PrinterPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
