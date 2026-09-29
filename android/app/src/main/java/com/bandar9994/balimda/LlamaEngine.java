// Balimda — © 2026 Bandar Altariqi. All rights reserved.
// Licensed under the Balimda License (see LICENSE): non-commercial use only;
// keep the Balimda name and the "Balimda by Bandar Altariqi" credit; no rebranding.

package com.bandar9994.balimda;

import java.io.BufferedReader;
import java.io.FileReader;

/** Thin wrapper around the native llama.cpp engine (balimda_llama.cpp). */
public final class LlamaEngine {

    public interface TokenCallback {
        /** Receives the next piece of text ("" while reading the prompt). Return false to stop. */
        boolean onToken(String text);
    }

    private static boolean loaded;
    private static String loadError;

    static {
        try {
            if (!cpuHasDotProd()) {
                loadError = "This phone's processor is too old for the native engine.";
            } else {
                System.loadLibrary("balimda_llama");
                loaded = true;
            }
        } catch (Throwable t) {
            loadError = t.getMessage();
        }
    }

    private LlamaEngine() {}

    public static boolean isAvailable() {
        return loaded;
    }

    public static String loadError() {
        return loadError;
    }

    /** The library is built for ARMv8.2 dot-product instructions (Snapdragon 855 and newer). */
    private static boolean cpuHasDotProd() {
        String arch = String.valueOf(System.getProperty("os.arch"));
        if (!arch.contains("aarch64") && !arch.contains("arm")) return true;
        try (BufferedReader r = new BufferedReader(new FileReader("/proc/cpuinfo"))) {
            String line;
            while ((line = r.readLine()) != null) {
                if (line.startsWith("Features") && line.contains("asimddp")) return true;
            }
        } catch (Exception ignored) {
            // Unknown: assume a modern phone.
            return true;
        }
        return false;
    }

    /** Tab-separated lines: kind (cpu/gpu), name, description. */
    public static native String nativeDevices();

    public static native long nativeLoad(String path, int nCtx, int nGpuLayers, int nThreads);

    /** e.g. "offloaded 29/29 layers to GPU", or "" when the model runs on the CPU only. */
    public static native String nativeOffload(long handle);

    /** Loads a vision model's image part (its mmproj file); throws on failure. */
    public static native void nativeLoadVision(long handle, String mmprojPath, boolean useGpu, int nThreads);

    public static native void nativeFree(long handle);

    /**
     * Returns the engine's result line (see balimda_engine.h). Message i has
     * imageCounts[i] of the pictures in images (image files, in order); both
     * may be null. A background job (e.g. updating memory) runs beside the
     * chat instead of replacing it.
     */
    public static native String nativeComplete(
        long handle,
        String[] roles,
        String[] contents,
        int[] imageCounts,
        byte[][] images,
        int maxTokens,
        float temperature,
        boolean background,
        TokenCallback callback
    );
}
