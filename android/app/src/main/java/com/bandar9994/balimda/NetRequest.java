// Balimda — © 2026 Bandar Altariqi. All rights reserved.
// Licensed under the Balimda License (see LICENSE): non-commercial use only;
// keep the Balimda name and the "Balimda by Bandar Altariqi" credit; no rebranding.

package com.bandar9994.balimda;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.ConnectException;
import java.net.HttpURLConnection;
import java.net.NoRouteToHostException;
import java.net.SocketTimeoutException;
import java.net.URL;
import java.net.UnknownHostException;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * One HTTP request made with the phone's own network code, its answer passed
 * on piece by piece as it arrives (for streamed replies). Plain Java, so it
 * can be tested without Android (see NetPlugin for the app's side).
 */
public class NetRequest {

    public interface Listener {
        void onHead(int status, Map<String, String> headers);
        void onData(byte[] buffer, int length);
        void onEnd();
        /** headSent: whether onHead was called before the failure. */
        void onError(String message, boolean headSent);
    }

    private static final int CONNECT_TIMEOUT_MS = 15000;
    // Agents can think for a while; Hermes sends a keepalive every few seconds.
    private static final int READ_TIMEOUT_MS = 5 * 60 * 1000;

    private final String url;
    private final String method;
    private final Map<String, String> headers;
    private final String body;
    private volatile HttpURLConnection conn;
    private volatile boolean cancelled;

    public NetRequest(String url, String method, Map<String, String> headers, String body) {
        this.url = url;
        this.method = method == null ? "GET" : method;
        this.headers = headers;
        this.body = body;
    }

    public boolean isCancelled() {
        return cancelled;
    }

    /** Stops the request from another thread. */
    public void cancel() {
        cancelled = true;
        HttpURLConnection c = conn;
        if (c != null) c.disconnect();
    }

    /** Runs the request on the calling thread. */
    public void run(Listener listener) {
        boolean headSent = false;
        HttpURLConnection c = null;
        try {
            URL u = new URL(url);
            String scheme = u.getProtocol();
            if (!"http".equals(scheme) && !"https".equals(scheme)) throw new IOException("Only http and https addresses work.");
            c = (HttpURLConnection) u.openConnection();
            conn = c;
            if (cancelled) throw new IOException("Cancelled");
            c.setRequestMethod(method);
            c.setConnectTimeout(CONNECT_TIMEOUT_MS);
            c.setReadTimeout(READ_TIMEOUT_MS);
            c.setUseCaches(false);
            c.setInstanceFollowRedirects(true);
            // Unpacking gzip can hold back a streamed reply.
            c.setRequestProperty("Accept-Encoding", "identity");
            if (headers != null) {
                for (Map.Entry<String, String> h : headers.entrySet()) c.setRequestProperty(h.getKey(), h.getValue());
            }
            if (body != null) {
                byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
                c.setDoOutput(true);
                c.setFixedLengthStreamingMode(bytes.length);
                try (OutputStream out = c.getOutputStream()) {
                    out.write(bytes);
                }
            }
            int status = c.getResponseCode();
            Map<String, String> head = new LinkedHashMap<>();
            for (Map.Entry<String, List<String>> h : c.getHeaderFields().entrySet()) {
                if (h.getKey() == null || h.getValue() == null) continue;  // the status line
                head.put(h.getKey().toLowerCase(java.util.Locale.ROOT), String.join(", ", h.getValue()));
            }
            listener.onHead(status, head);
            headSent = true;
            InputStream in = status >= 400 ? c.getErrorStream() : c.getInputStream();
            if (in != null) {
                try (InputStream stream = in) {
                    byte[] buf = new byte[16384];
                    int n;
                    while (!cancelled && (n = stream.read(buf)) != -1) {
                        if (n > 0 && !cancelled) listener.onData(buf, n);
                    }
                }
            }
            if (cancelled) throw new IOException("Cancelled");
            listener.onEnd();
        } catch (Exception e) {
            listener.onError(cancelled ? "Cancelled" : describe(e), headSent);
        } finally {
            if (c != null) c.disconnect();
        }
    }

    // Says what went wrong in words a person can act on.
    private String describe(Exception e) {
        String host = where();
        if (e instanceof UnknownHostException) return "Couldn't find the server" + host + ". Check the address.";
        if (e instanceof ConnectException) return "Couldn't connect to the server" + host + " (" + e.getMessage() + "). Check that it's running, that it accepts connections from other devices, and that the phone is on the same network.";
        if (e instanceof NoRouteToHostException) return "Couldn't reach the server" + host + ". Check that the phone is on the same network.";
        if (e instanceof SocketTimeoutException) return "The server" + host + " didn't answer in time.";
        String m = e.getMessage();
        return m == null || m.isEmpty() ? e.getClass().getSimpleName() : m;
    }

    // " at 192.168.1.10:8642", or "" for an address that can't be read.
    private String where() {
        try {
            URL u = new URL(url);
            return " at " + u.getHost() + (u.getPort() != -1 ? ":" + u.getPort() : "");
        } catch (Exception e) {
            return "";
        }
    }
}
