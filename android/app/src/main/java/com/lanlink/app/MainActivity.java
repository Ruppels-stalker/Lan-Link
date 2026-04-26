package com.lanlink.app;

import android.os.Bundle;
import android.net.wifi.WifiManager;
import android.content.Context;
import com.getcapacitor.BridgeActivity;
import android.Manifest;
import android.content.pm.PackageManager;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import fi.iki.elonen.NanoHTTPD;
import java.io.IOException;
import java.util.HashMap;
import java.util.Map;
import com.getcapacitor.JSObject;

public class MainActivity extends BridgeActivity {
    private WifiManager.MulticastLock multicastLock;
    private SignalingServer server;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.TIRAMISU) {
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.NEARBY_WIFI_DEVICES) != PackageManager.PERMISSION_GRANTED) {
                ActivityCompat.requestPermissions(this, new String[]{Manifest.permission.NEARBY_WIFI_DEVICES, Manifest.permission.ACCESS_FINE_LOCATION}, 1);
            }
        } else {
             if (ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED) {
                ActivityCompat.requestPermissions(this, new String[]{Manifest.permission.ACCESS_FINE_LOCATION}, 1);
            }
        }
        
        WifiManager wifiManager = (WifiManager) getApplicationContext().getSystemService(Context.WIFI_SERVICE);
        if (wifiManager != null) {
            multicastLock = wifiManager.createMulticastLock("LanLinkMulticastLock");
            multicastLock.setReferenceCounted(true);
            multicastLock.acquire();
        }

        server = new SignalingServer();
        try {
            server.start(NanoHTTPD.SOCKET_READ_TIMEOUT, false);
        } catch (IOException e) {
            e.printStackTrace();
        }
    }

    private class SignalingServer extends NanoHTTPD {
        public SignalingServer() {
            super(3003);
        }

        @Override
        public Response serve(IHTTPSession session) {
            if (session.getMethod() == Method.POST && "/signal".equals(session.getUri())) {
                try {
                    Map<String, String> files = new HashMap<>();
                    session.parseBody(files);
                    String postData = files.get("postData");
                    
                    JSObject data = new JSObject();
                    data.put("payload", postData);
                    
                    bridge.triggerWindowStageEvent("http-signal", data.toString());
                    
                    return newFixedLengthResponse(Response.Status.OK, "text/plain", "OK");
                } catch (Exception e) {
                    return newFixedLengthResponse(Response.Status.INTERNAL_ERROR, "text/plain", e.getMessage());
                }
            }
            return newFixedLengthResponse(Response.Status.NOT_FOUND, "text/plain", "Not Found");
        }
    }

    @Override
    public void onDestroy() {
        super.onDestroy();
        if (multicastLock != null && multicastLock.isHeld()) {
            multicastLock.release();
        }
        if (server != null) {
            server.stop();
        }
    }
}
