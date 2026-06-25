package uk.co.siamepos.app;

import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.Socket;

/**
 * SEPOS-ANDROID-001 — raw ESC/POS network printing.
 *
 * The server builds the exact ESC/POS bytes (src/services/printService.js); the
 * app fetches them and pushes them straight to a LAN printer's TCP port (9100),
 * so an Android tablet can drive kitchen/bar/receipt printers with no desktop
 * server on the network. The Sunmi's BUILT-IN printer is a separate path (its
 * own SDK) added when that hardware lands — this covers every network printer.
 */
@CapacitorPlugin(name = "Printer")
public class PrinterPlugin extends Plugin {

    /** sendRaw({ host, port=9100, data=<base64 ESC/POS> }) → opens a TCP socket, writes the bytes. */
    @PluginMethod
    public void sendRaw(PluginCall call) {
        final String host = call.getString("host");
        final int port = call.getInt("port", 9100);
        final String dataB64 = call.getString("data");
        final int timeout = call.getInt("timeoutMs", 6000);
        if (host == null || dataB64 == null) {
            call.reject("host and data (base64) are required");
            return;
        }
        final byte[] bytes;
        try {
            bytes = Base64.decode(dataB64, Base64.DEFAULT);
        } catch (IllegalArgumentException e) {
            call.reject("data is not valid base64");
            return;
        }
        new Thread(() -> {
            Socket socket = new Socket();
            try {
                socket.connect(new InetSocketAddress(host, port), timeout);
                OutputStream out = socket.getOutputStream();
                out.write(bytes);
                out.flush();
                socket.close();
                JSObject ret = new JSObject();
                ret.put("ok", true);
                ret.put("bytes", bytes.length);
                call.resolve(ret);
            } catch (Exception e) {
                try { socket.close(); } catch (Exception ignored) {}
                call.reject("print failed: " + e.getMessage());
            }
        }).start();
    }
}
