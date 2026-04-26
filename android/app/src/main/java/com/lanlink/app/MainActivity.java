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
import java.util.UUID;
import com.getcapacitor.JSObject;
import com.getcapacitor.Bridge;
import android.util.Log;
import android.net.nsd.NsdManager;
import android.net.nsd.NsdServiceInfo;
import java.net.NetworkInterface;
import java.net.InetAddress;
import java.util.Enumeration;
import android.widget.Toast;

public class MainActivity extends BridgeActivity {
    private WifiManager.MulticastLock multicastLock;
    private SignalingServer server;
    private NsdManager nsdManager;
    private NsdManager.RegistrationListener registrationListener;
    private NsdManager.DiscoveryListener discoveryListener;
    private String mServiceName = "LanLink-" + UUID.randomUUID().toString().substring(0, 8);
    private final String SERVICE_TYPE = "_lanlink._tcp.";

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

        nsdManager = (NsdManager) getSystemService(Context.NSD_SERVICE);
        initializeNsdListeners();

        server = new SignalingServer();
        try {
            server.start(NanoHTTPD.SOCKET_READ_TIMEOUT, false);
            Log.d("LanLinkNative", "NanoHTTPD Signaling Server started on 0.0.0.0:3003");
            logAndToastIps();
        } catch (IOException e) {
            Log.e("LanLinkNative", "Failed to start NanoHTTPD server", e);
        }
    }

    private void logAndToastIps() {
        StringBuilder ips = new StringBuilder();
        try {
            Enumeration<NetworkInterface> interfaces = NetworkInterface.getNetworkInterfaces();
            while (interfaces.hasMoreElements()) {
                NetworkInterface iface = interfaces.nextElement();
                Enumeration<InetAddress> addresses = iface.getInetAddresses();
                while (addresses.hasMoreElements()) {
                    InetAddress addr = addresses.nextElement();
                    if (!addr.isLoopbackAddress() && addr.getHostAddress().indexOf(':') < 0) { // IPv4 only
                        ips.append(addr.getHostAddress()).append(" ");
                        Log.d("LanLinkNative", "Bound to IP: " + addr.getHostAddress() + " on " + iface.getName());
                    }
                }
            }
        } catch (Exception e) {
            Log.e("LanLinkNative", "Failed to get IPs", e);
        }
        final String ipStr = ips.toString().trim();
        runOnUiThread(() -> Toast.makeText(MainActivity.this, "Server bound to: " + ipStr, Toast.LENGTH_LONG).show());
    }

    private void initializeNsdListeners() {
        registrationListener = new NsdManager.RegistrationListener() {
            @Override
            public void onServiceRegistered(NsdServiceInfo NsdServiceInfo) {
                mServiceName = NsdServiceInfo.getServiceName();
                Log.d("LanLinkNative", "NSD Service registered: " + mServiceName);
                try {
                    JSObject data = new JSObject();
                    data.put("name", mServiceName);
                    getBridge().triggerWindowJSEvent("nsd-registered", data.toString());
                } catch (Exception e) {}
            }
            @Override
            public void onRegistrationFailed(NsdServiceInfo serviceInfo, int errorCode) {}
            @Override
            public void onServiceUnregistered(NsdServiceInfo arg0) {}
            @Override
            public void onUnregistrationFailed(NsdServiceInfo serviceInfo, int errorCode) {}
        };

        discoveryListener = new NsdManager.DiscoveryListener() {
            @Override
            public void onDiscoveryStarted(String regType) {
                Log.d("LanLinkNative", "NSD Discovery started");
            }
            @Override
            public void onServiceFound(NsdServiceInfo service) {
                Log.d("LanLinkNative", "NSD Service found: " + service);
                if (!service.getServiceType().equals(SERVICE_TYPE)) {
                    Log.d("LanLinkNative", "Unknown Service Type: " + service.getServiceType());
                } else if (service.getServiceName().equals(mServiceName)) {
                    Log.d("LanLinkNative", "Same machine: " + mServiceName);
                } else {
                    nsdManager.resolveService(service, new NsdManager.ResolveListener() {
                        @Override
                        public void onResolveFailed(NsdServiceInfo serviceInfo, int errorCode) {
                            Log.e("LanLinkNative", "NSD Resolve failed: " + errorCode);
                        }
                        @Override
                        public void onServiceResolved(NsdServiceInfo serviceInfo) {
                            Log.d("LanLinkNative", "NSD Resolve Succeeded. " + serviceInfo);
                            if (serviceInfo.getHost() != null) {
                                String hostAddress = serviceInfo.getHost().getHostAddress();
                                int port = serviceInfo.getPort();
                                String name = serviceInfo.getServiceName();

                                JSObject data = new JSObject();
                                data.put("name", name);
                                data.put("ip", hostAddress);
                                data.put("port", port);

                                getBridge().triggerWindowJSEvent("nsd-peer-resolved", data.toString());
                            }
                        }
                    });
                }
            }
            @Override
            public void onServiceLost(NsdServiceInfo service) {}
            @Override
            public void onDiscoveryStopped(String serviceType) {}
            @Override
            public void onStartDiscoveryFailed(String serviceType, int errorCode) {
                nsdManager.stopServiceDiscovery(this);
            }
            @Override
            public void onStopDiscoveryFailed(String serviceType, int errorCode) {
                nsdManager.stopServiceDiscovery(this);
            }
        };
    }

    public void registerNsdService() {
        NsdServiceInfo serviceInfo = new NsdServiceInfo();
        serviceInfo.setServiceName(mServiceName);
        serviceInfo.setServiceType(SERVICE_TYPE);
        serviceInfo.setPort(3003);
        nsdManager.registerService(serviceInfo, NsdManager.PROTOCOL_DNS_SD, registrationListener);
    }

    @Override
    public void onResume() {
        super.onResume();
        WifiManager wifiManager = (WifiManager) getApplicationContext().getSystemService(Context.WIFI_SERVICE);
        if (wifiManager != null) {
            multicastLock = wifiManager.createMulticastLock("LanLinkMulticastLock");
            multicastLock.setReferenceCounted(true);
            multicastLock.acquire();
        }
        if (nsdManager != null) {
            registerNsdService();
            nsdManager.discoverServices(SERVICE_TYPE, NsdManager.PROTOCOL_DNS_SD, discoveryListener);
        }
    }

    @Override
    public void onPause() {
        if (nsdManager != null) {
            try { nsdManager.unregisterService(registrationListener); } catch (Exception e) {}
            try { nsdManager.stopServiceDiscovery(discoveryListener); } catch (Exception e) {}
        }
        if (multicastLock != null && multicastLock.isHeld()) {
            multicastLock.release();
        }
        super.onPause();
    }

    private class SignalingServer extends NanoHTTPD {
        public SignalingServer() {
            super("0.0.0.0", 3003);
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
            response.addHeader("Access-Control-Allow-Headers", "*");
            response.addHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
            response.addHeader("Access-Control-Allow-Private-Network", "true");
        }
    }

    @Override
    public void onDestroy() {
        super.onDestroy();
        if (server != null) {
            server.stop();
        }
    }
}
