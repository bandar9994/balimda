// Balimda — © 2026 Bandar Altariqi. All rights reserved.
// Licensed under the Balimda License (see LICENSE): non-commercial use only;
// keep the Balimda name and the "Balimda by Bandar Altariqi" credit; no rebranding.

package com.bandar9994.balimda;

import com.getcapacitor.JSArray;
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
import java.net.URLDecoder;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * On-device models with llama.cpp running natively (CPU + Adreno GPU via OpenCL).
 * Models are GGUF files kept in the app's private storage (files/models).
 *
 * Events: "token" {requestId, text}, "status" {requestId, status},
 *         "download" {url, loaded, total, done, error}
 */
@CapacitorPlugin(name = "Llama")
public class LlamaPlugin extends Plugin {

    private final ExecutorService inference = Executors.newSingleThreadExecutor();
    private final ExecutorService downloads = Executors.newCachedThreadPool();
    private final Map<String, AtomicBoolean> cancelledDownloads = new ConcurrentHashMap<>();
    private final Map<String, AtomicBoolean> activeRequests = new ConcurrentHashMap<>();
    // Partial files of downloads running now; any other .part file was left
    // by a download the app was closed during, and only wastes space.
    private final java.util.Set<String> activeParts = ConcurrentHashMap.newKeySet();

    // Loaded model state (only touched on the inference thread).
    private long handle = 0;
    private String loadedKey = null;
    private String loadedDevice = "CPU";   // where the loaded model runs
    private String loadedOffload = "";

    private File modelsDir() {
        File dir = new File(getContext().getFilesDir(), "models");
        dir.mkdirs();
        return dir;
    }

    private static String fileNameFor(String url) throws Exception {
        String path = new URL(url).getPath();
        String name = URLDecoder.decode(path.substring(path.lastIndexOf('/') + 1), "UTF-8");
        name = name.replaceAll("[^A-Za-z0-9._-]", "_");
        if (!name.toLowerCase().endsWith(".gguf")) throw new IllegalArgumentException("The link must point to a .gguf file");
        return name;
    }

    private File modelFile(String name) {
        File f = new File(modelsDir(), name.replaceAll("[/\\\\]", "_"));
        return f;
    }

    // ---- record of downloads -------------------------------------------------------
    // Which models Balimda downloaded (files/models-record.json). A model is
    // only taken off the record when the user deletes it in Balimda, so a
    // recorded model whose file is gone was removed by something else on the
    // phone (e.g. a storage cleaner), and the app can say so and offer it again.

    private File recordFile() {
        return new File(getContext().getFilesDir(), "models-record.json");
    }

    private synchronized JSONObject readRecord() {
        File f = recordFile();
        if (!f.exists()) return new JSONObject();
        try (java.io.FileInputStream in = new java.io.FileInputStream(f)) {
            byte[] bytes = new byte[(int) f.length()];
            int off = 0;
            while (off < bytes.length) {
                int n = in.read(bytes, off, bytes.length - off);
                if (n < 0) break;
                off += n;
            }
            return new JSONObject(new String(bytes, 0, off, "UTF-8"));
        } catch (Exception e) {
            return new JSONObject();
        }
    }

    private synchronized void writeRecord(JSONObject record) {
        File f = recordFile();
        File tmp = new File(f.getPath() + ".tmp");
        try (FileOutputStream out = new FileOutputStream(tmp)) {
            out.write(record.toString().getBytes("UTF-8"));
            out.getFD().sync();
        } catch (Exception e) {
            return;
        }
        if (!tmp.renameTo(f)) tmp.delete();
    }

    private synchronized void noteDownloaded(String name, String url, long size) {
        try {
            JSONObject record = readRecord();
            JSONObject entry = new JSONObject();
            if (url != null) entry.put("url", url);
            entry.put("size", size);
            entry.put("at", System.currentTimeMillis());
            record.put(name, entry);
            writeRecord(record);
        } catch (Exception ignored) {
            // the record is only a helper
        }
    }

    private synchronized void noteDeleted(String name) {
        JSONObject record = readRecord();
        if (record.has(name)) {
            record.remove(name);
            writeRecord(record);
        }
    }

    private synchronized boolean wasDownloaded(String name) {
        return readRecord().has(name);
    }

    // ---- info ---------------------------------------------------------------------

    @PluginMethod
    public void info(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("available", LlamaEngine.isAvailable());
        ret.put("error", LlamaEngine.loadError());
        JSArray devices = new JSArray();
        if (LlamaEngine.isAvailable()) {
            try {
                for (String line : LlamaEngine.nativeDevices().split("\n")) {
                    String[] parts = line.split("\t");
                    if (parts.length < 3) continue;
                    JSObject d = new JSObject();
                    d.put("type", parts[0]);
                    d.put("name", parts[1]);
                    d.put("description", parts[2]);
                    devices.put(d);
                }
            } catch (Throwable t) {
                ret.put("error", t.getMessage());
            }
        }
        ret.put("devices", devices);
        call.resolve(ret);
    }

    // ---- model files -------------------------------------------------------------

    @PluginMethod
    public void listModels(PluginCall call) {
        JSArray list = new JSArray();
        java.util.Set<String> present = new java.util.HashSet<>();
        File[] files = modelsDir().listFiles();
        JSONObject record = readRecord();
        if (files != null) {
            for (File f : files) {
                if (f.getName().endsWith(".part") && !activeParts.contains(f.getName())) {
                    f.delete();
                    continue;
                }
                if (!f.getName().endsWith(".gguf")) continue;
                present.add(f.getName());
                // Models downloaded before the record existed join it here.
                if (!record.has(f.getName())) noteDownloaded(f.getName(), null, f.length());
                JSObject m = new JSObject();
                m.put("name", f.getName());
                m.put("size", f.length());
                list.put(m);
            }
        }
        // On the record but gone from the phone, without being deleted in Balimda.
        JSArray missing = new JSArray();
        java.util.Iterator<String> names = record.keys();
        while (names.hasNext()) {
            String name = names.next();
            if (present.contains(name)) continue;
            JSONObject entry = record.optJSONObject(name);
            JSObject m = new JSObject();
            m.put("name", name);
            if (entry != null) {
                if (entry.has("url")) m.put("url", entry.optString("url"));
                m.put("size", entry.optLong("size", 0));
                m.put("at", entry.optLong("at", 0));
            }
            missing.put(m);
        }
        JSObject ret = new JSObject();
        ret.put("models", list);
        ret.put("missing", missing);
        call.resolve(ret);
    }

    @PluginMethod
    public void deleteModel(PluginCall call) {
        String name = call.getString("name", "");
        inference.execute(() -> {
            File f = modelFile(name);
            if (loadedKey != null && loadedKey.startsWith(f.getAbsolutePath() + "|")) unload();
            boolean ok = !f.exists() || f.delete();
            if (ok) noteDeleted(f.getName());
            JSObject ret = new JSObject();
            ret.put("deleted", ok);
            call.resolve(ret);
        });
    }

    @PluginMethod
    public void download(PluginCall call) {
        String url = call.getString("url", "");
        String name;
        try {
            name = fileNameFor(url);
        } catch (Exception e) {
            call.reject(e.getMessage());
            return;
        }
        AtomicBoolean cancelled = new AtomicBoolean(false);
        cancelledDownloads.put(url, cancelled);
        JSObject started = new JSObject();
        started.put("name", name);
        call.resolve(started);

        downloads.execute(() -> {
            File target = modelFile(name);
            File part = new File(target.getPath() + ".part");
            activeParts.add(part.getName());
            long total = -1;
            long done = 0;
            try {
                HttpURLConnection conn = null;
                String current = url;
                for (int redirects = 0; redirects < 8; redirects++) {
                    conn = (HttpURLConnection) new URL(current).openConnection();
                    conn.setInstanceFollowRedirects(false);
                    conn.setConnectTimeout(20000);
                    conn.setReadTimeout(60000);
                    int code = conn.getResponseCode();
                    if (code >= 300 && code < 400) {
                        current = new URL(new URL(current), conn.getHeaderField("Location")).toString();
                        conn.disconnect();
                        continue;
                    }
                    if (code != 200) throw new Exception("Download failed (HTTP " + code + ")");
                    break;
                }
                total = conn.getContentLengthLong();
                long lastEmit = 0;
                try (InputStream in = conn.getInputStream(); FileOutputStream out = new FileOutputStream(part)) {
                    byte[] buf = new byte[1 << 16];
                    int n;
                    while ((n = in.read(buf)) > 0) {
                        if (cancelled.get()) throw new InterruptedException("cancelled");
                        out.write(buf, 0, n);
                        done += n;
                        long now = System.currentTimeMillis();
                        if (now - lastEmit > 300) {
                            lastEmit = now;
                            emitDownload(url, done, total, false, null);
                        }
                    }
                }
                if (total > 0 && done != total) throw new Exception("Download was interrupted; please retry.");
                if (!part.renameTo(target)) throw new Exception("Couldn't save the model file.");
                noteDownloaded(target.getName(), url, target.length());
                emitDownload(url, done, total, true, null);
            } catch (InterruptedException e) {
                part.delete();
                emitDownload(url, done, total, true, "cancelled");
            } catch (Exception e) {
                part.delete();
                emitDownload(url, done, total, true, e.getMessage() == null ? e.toString() : e.getMessage());
            } finally {
                activeParts.remove(part.getName());
                cancelledDownloads.remove(url);
            }
        });
    }

    @PluginMethod
    public void cancelDownload(PluginCall call) {
        AtomicBoolean flag = cancelledDownloads.get(call.getString("url", ""));
        if (flag != null) flag.set(true);
        call.resolve();
    }

    private void emitDownload(String url, long loaded, long total, boolean done, String error) {
        JSObject evt = new JSObject();
        evt.put("url", url);
        evt.put("loaded", loaded);
        evt.put("total", total);
        evt.put("done", done);
        if (error != null) evt.put("error", error);
        notifyListeners("download", evt);
    }

    // ---- inference -----------------------------------------------------------------

    private void unload() {
        if (handle != 0) {
            LlamaEngine.nativeFree(handle);
            handle = 0;
        }
        loadedKey = null;
    }

    private static int threadCount() {
        // Big cores only: using the small efficiency cores slows generation down.
        int cores = Runtime.getRuntime().availableProcessors();
        return Math.max(1, Math.min(4, cores));
    }

    // When the GPU does the work, extra CPU threads only spin while they wait
    // for it, heating the phone and slowing everything else down.
    private static final int GPU_THREADS = 2;

    // A short pause after each word on the GPU gives the screen a turn at the
    // GPU, so the phone stays smooth while a reply is written.
    private static final long GPU_YIELD_MS = 4;

    @PluginMethod
    public void generate(PluginCall call) {
        if (!LlamaEngine.isAvailable()) {
            call.reject("The native engine isn't available on this phone: " + LlamaEngine.loadError());
            return;
        }
        String requestId = call.getString("requestId", "");
        String model = call.getString("model", "");
        int nCtx = call.getInt("contextSize", 4096);
        boolean gpu = call.getBoolean("gpu", true);
        int maxTokens = call.getInt("maxTokens", 1024);
        float temperature = call.getFloat("temperature", 0.7f);
        JSONArray messages = call.getArray("messages", new JSArray());

        AtomicBoolean stop = new AtomicBoolean(false);
        activeRequests.put(requestId, stop);

        inference.execute(() -> {
            try {
                File file = modelFile(model);
                if (!file.exists()) {
                    if (wasDownloaded(file.getName())) {
                        throw new Exception("\"" + model + "\" was removed from this phone, but not by Balimda (it only deletes a model when you tap Delete). "
                            + "Something else on the phone removed it, often a storage cleaner. Download it again in Settings → Models & providers.");
                    }
                    throw new Exception("\"" + model + "\" isn't downloaded. Download it in Settings → Models & providers.");
                }
                String key = file.getAbsolutePath() + "|" + nCtx + "|" + gpu;
                if (!key.equals(loadedKey)) {
                    unload();
                    emitStatus(requestId, "loading");
                    handle = LlamaEngine.nativeLoad(file.getAbsolutePath(), nCtx, gpu ? 99 : 0, gpu ? GPU_THREADS : threadCount());
                    loadedOffload = LlamaEngine.nativeOffload(handle);
                    loadedDevice = describeDevice(loadedOffload);
                    if (gpu && loadedDevice.equals("CPU")) {
                        // The GPU couldn't take the model: load it again with all CPU threads.
                        unload();
                        handle = LlamaEngine.nativeLoad(file.getAbsolutePath(), nCtx, 0, threadCount());
                        loadedOffload = LlamaEngine.nativeOffload(handle);
                        loadedDevice = describeDevice(loadedOffload);
                    }
                    loadedKey = key;
                }
                if (stop.get()) {
                    resolveDone(call, "aborted");
                    return;
                }
                emitStatus(requestId, "thinking");
                final boolean onGpu = loadedDevice.startsWith("GPU");

                String[] roles = new String[messages.length()];
                String[] contents = new String[messages.length()];
                for (int i = 0; i < messages.length(); i++) {
                    JSONObject m = messages.getJSONObject(i);
                    roles[i] = m.optString("role", "user");
                    contents[i] = m.optString("content", "");
                }
                String result = LlamaEngine.nativeComplete(handle, roles, contents, maxTokens, temperature, (text) -> {
                    if (!text.isEmpty()) {
                        JSObject evt = new JSObject();
                        evt.put("requestId", requestId);
                        evt.put("text", text);
                        notifyListeners("token", evt);
                    }
                    if (onGpu) {
                        try {
                            Thread.sleep(GPU_YIELD_MS);
                        } catch (InterruptedException ignored) {
                            // just continue
                        }
                    }
                    return !stop.get();
                });
                resolveDone(call, result);
            } catch (Throwable t) {
                call.reject(t.getMessage() == null ? t.toString() : t.getMessage());
            } finally {
                activeRequests.remove(requestId);
            }
        });
    }

    /** result = "reason\tpromptTokens\tpromptMs\tgeneratedTokens\tgenerationMs\tchatTokens\tmessagesSent\tcontextSize" (or just "reason"). */
    private void resolveDone(PluginCall call, String result) {
        String[] parts = result.split("\t");
        JSObject ret = new JSObject();
        ret.put("stopReason", parts[0]);
        if (parts.length >= 5) {
            JSObject stats = new JSObject();
            stats.put("device", loadedDevice);
            stats.put("offload", loadedOffload);
            stats.put("promptTokens", Long.parseLong(parts[1]));
            stats.put("promptMs", Double.parseDouble(parts[2]));
            stats.put("tokens", Long.parseLong(parts[3]));
            stats.put("ms", Double.parseDouble(parts[4]));
            if (parts.length >= 8) {
                stats.put("chatTokens", Long.parseLong(parts[5]));
                stats.put("messagesSent", Long.parseLong(parts[6]));
                stats.put("contextSize", Long.parseLong(parts[7]));
            }
            ret.put("stats", stats);
        }
        call.resolve(ret);
    }

    /** "GPU · QUALCOMM Adreno(TM) 740" when layers were offloaded, else "CPU". */
    private static String describeDevice(String offload) {
        java.util.regex.Matcher m = java.util.regex.Pattern.compile("offloaded (\\d+)/(\\d+)").matcher(offload == null ? "" : offload);
        if (!m.find() || Integer.parseInt(m.group(1)) == 0) return "CPU";
        String gpu = "GPU";
        try {
            for (String line : LlamaEngine.nativeDevices().split("\n")) {
                String[] p = line.split("\t");
                if (p.length >= 3 && p[0].equals("gpu")) {
                    gpu = "GPU · " + p[2];
                    break;
                }
            }
        } catch (Throwable ignored) {
            // keep the generic label
        }
        return gpu;
    }

    private void emitStatus(String requestId, String status) {
        JSObject evt = new JSObject();
        evt.put("requestId", requestId);
        evt.put("status", status);
        // Once the model is loaded, say where it runs (e.g. "GPU · Adreno 740").
        if ("thinking".equals(status) && loadedDevice != null) evt.put("device", loadedDevice);
        notifyListeners("status", evt);
    }

    @PluginMethod
    public void stop(PluginCall call) {
        AtomicBoolean flag = activeRequests.get(call.getString("requestId", ""));
        if (flag != null) flag.set(true);
        call.resolve();
    }

    @PluginMethod
    public void unloadModel(PluginCall call) {
        inference.execute(() -> {
            unload();
            call.resolve();
        });
    }

    @Override
    protected void handleOnDestroy() {
        inference.execute(this::unload);
        inference.shutdown();
        downloads.shutdownNow();
    }
}
