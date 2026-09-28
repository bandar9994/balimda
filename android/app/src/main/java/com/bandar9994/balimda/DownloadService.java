// Balimda — © 2026 Bandar Altariqi. All rights reserved.
// Licensed under the Balimda License (see LICENSE): non-commercial use only;
// keep the Balimda name and the "Balimda by Bandar Altariqi" credit; no rebranding.

package com.bandar9994.balimda;

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
 * Keeps model downloads going while Balimda is in the background. Android
 * cuts the network off for background apps ("Software caused connection
 * abort"); a foreground service, shown as a notification with the progress,
 * keeps it. LlamaPlugin starts it with the first download and stops it when
 * the last one ends.
 */
public class DownloadService extends Service {

    private static final String CHANNEL = "downloads";
    private static final int NOTIFICATION_ID = 7001;

    private static volatile boolean running = false;
    private static volatile String text = "Downloading a model…";
    private static volatile int percent = -1;  // -1 = unknown

    private PowerManager.WakeLock wakeLock;

    static void start(Context context) {
        try {
            ContextCompat.startForegroundService(context, new Intent(context, DownloadService.class));
        } catch (Exception e) {
            // Not allowed right now (e.g. the app is already in the background):
            // the download still runs while the app is open.
        }
    }

    static void stop(Context context) {
        context.stopService(new Intent(context, DownloadService.class));
    }

    /** Updates the notification (`percent` -1 when the size isn't known). */
    static void progress(Context context, String message, int pct) {
        text = message;
        percent = pct;
        if (!running) return;
        NotificationManager nm = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        try {
            nm.notify(NOTIFICATION_ID, build(context));
        } catch (Exception ignored) {
            // No permission to show notifications: the download goes on anyway.
        }
    }

    private static android.app.Notification build(Context context) {
        Intent open = context.getPackageManager().getLaunchIntentForPackage(context.getPackageName());
        PendingIntent tap = open == null ? null : PendingIntent.getActivity(context, 0, open, PendingIntent.FLAG_IMMUTABLE);
        return new NotificationCompat.Builder(context, CHANNEL)
            .setSmallIcon(android.R.drawable.stat_sys_download)
            .setContentTitle("Balimda")
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
            NotificationChannel channel = new NotificationChannel(CHANNEL, "Model downloads", NotificationManager.IMPORTANCE_LOW);
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
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        wakeLock = null;
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
