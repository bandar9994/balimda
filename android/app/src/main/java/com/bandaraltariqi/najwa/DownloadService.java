// Najwa AI — © 2026 Bandar Altariqi. All rights reserved.
// Licensed under the Najwa AI License (see LICENSE): non-commercial use only;
// keep the Najwa AI name and the "Najwa AI by Bandar Altariqi" credit; no rebranding.

package com.bandaraltariqi.najwa;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;

/**
 * Keeps model downloads, and replies being written on the phone, going while
 * Najwa AI is in the background. Android cuts the network off for background
 * apps ("Software caused connection abort"); a foreground service, shown as a
 * notification, keeps it. LlamaPlugin starts it with the first download and
 * stops it when the last one ends; NetPlugin.replying() holds it while a
 * reply is written. It stops when neither needs it.
 */
public class DownloadService extends Service {

    private static final String CHANNEL = "downloads";
    private static final int NOTIFICATION_ID = 7001;

    private static volatile boolean running = false;
    private static volatile boolean downloading = false;
    private static volatile boolean replying = false;
    private static volatile String text = "Downloading a model…";
    /** The app is in Arabic (Settings → General → Language): set by NetPlugin.language(). */
    static volatile boolean arabic = false;
    private static volatile int percent = -1;  // -1 = unknown

    private PowerManager.WakeLock wakeLock;

    static void start(Context context) {
        downloading = true;
        keep(context);
    }

    static void stop(Context context) {
        downloading = false;
        if (replying) refresh(context);
        else context.stopService(new Intent(context, DownloadService.class));
    }

    /** A reply is being written (true) or no longer (false). */
    static void replying(Context context, boolean on) {
        replying = on;
        if (on) {
            keep(context);
            refresh(context);
        } else if (downloading) {
            refresh(context);
        } else {
            context.stopService(new Intent(context, DownloadService.class));
        }
    }

    private static void keep(Context context) {
        try {
            ContextCompat.startForegroundService(context, new Intent(context, DownloadService.class));
        } catch (Exception e) {
            // Not allowed right now (e.g. the app is already in the background):
            // the work still runs while the app is open.
        }
    }

    private static void refresh(Context context) {
        if (!running) return;
        NotificationManager nm = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        try {
            nm.notify(NOTIFICATION_ID, build(context));
        } catch (Exception ignored) {
            // No permission to show notifications: the work goes on anyway.
        }
    }

    /** Updates the notification (`percent` -1 when the size isn't known). */
    static void progress(Context context, String message, int pct) {
        text = message;
        percent = pct;
        refresh(context);
    }

    private static android.app.Notification build(Context context) {
        Intent open = context.getPackageManager().getLaunchIntentForPackage(context.getPackageName());
        PendingIntent tap = open == null ? null : PendingIntent.getActivity(context, 0, open, PendingIntent.FLAG_IMMUTABLE);
        if (!downloading) {
            // Only a reply: no progress bar.
            return new NotificationCompat.Builder(context, CHANNEL)
                .setSmallIcon(android.R.drawable.stat_notify_chat)
                .setContentTitle("Najwa AI")
                .setContentText(arabic ? "جارٍ كتابة الرد…" : "Writing a reply…")
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setSilent(true)
                .setContentIntent(tap)
                .build();
        }
        return new NotificationCompat.Builder(context, CHANNEL)
            .setSmallIcon(android.R.drawable.stat_sys_download)
            .setContentTitle("Najwa AI")
            .setContentText(text)
            .setProgress(100, Math.max(percent, 0), percent < 0)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setContentIntent(tap)
            .build();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel channel = new NotificationChannel(CHANNEL, arabic ? "التحميلات والردود" : "Downloads and replies", NotificationManager.IMPORTANCE_LOW);
            ((NotificationManager) getSystemService(NOTIFICATION_SERVICE)).createNotificationChannel(channel);
        }
        try {
            if (Build.VERSION.SDK_INT >= 29) {
                startForeground(NOTIFICATION_ID, build(this), ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
            } else {
                startForeground(NOTIFICATION_ID, build(this));
            }
        } catch (Exception e) {
            stopSelf();
            return START_NOT_STICKY;
        }
        running = true;
        // Keep the processor awake with the screen off, so the download doesn't pause.
        if (wakeLock == null) {
            PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "balimda:download");
            wakeLock.acquire(6 * 60 * 60 * 1000L);  // at most 6 hours
        }
        return START_NOT_STICKY;
    }

    // Android 15 limits how long this kind of service may run in a day.
    @Override
    public void onTimeout(int startId, int fgsType) {
        stopSelf();
    }

    @Override
    public void onDestroy() {
        running = false;
        downloading = false;
        replying = false;
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        wakeLock = null;
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
