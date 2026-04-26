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
import com.getcapacitor.Bridge;
import android.util.Log;

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
            Log.d("LanLinkNative", "NanoHTTPD Signaling Server started on port 3003");
        } catch (IOException e) {
            Log.e("LanLinkNative", "Failed to start NanoHTTPD server", e);
        }
    }

    private class SignalingServer extends NanoHTTPD {
        public SignalingServer() {
            super(3003);
        }

        @Override
        public Response serve(IHTTPSession session) {
            Method method = session.getMethod();
            if (Method.OPTIONS.equals(method)) {
                Response response = newFixedLengthResponse(Response.Status.OK, "text/plain", "");
                addCorsHeaders(response);
                return response;
            }

            if (Method.POST.equals(method) && "/signal".equals(session.getUri())) {
                try {
                    Map<String, String> files = new HashMap<>();
                    session.parseBody(files);
                    String postData = files.get("postData");
                    
                    JSObject data = new JSObject();
                    data.put("payload", postData);
                    
                    getBridge().triggerWindowJSEvent("http-signal", data.toString());
                    Log.d("LanLinkNative", "Received HTTP signal, triggering JS event");
                    
                    Response response = newFixedLengthResponse(Response.Status.OK, "text/plain", "OK");
                    addCorsHeaders(response);
                    return response;
                } catch (Exception e) {
                    Response response = newFixedLengthResponse(Response.Status.INTERNAL_ERROR, "text/plain", e.getMessage());
                    addCorsHeaders(response);
                    return response;
                }
            }
            Response response = newFixedLengthResponse(Response.Status.NOT_FOUND, "text/plain", "Not Found");
            addCorsHeaders(response);
            return response;
        }

        private void addCorsHeaders(Response response) {
            response.addHeader("Access-Control-Allow-Origin", "*");
            response.addHeader("Access-Control-Allow-Headers", "origin, accept, content-type");
            response.addHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
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
