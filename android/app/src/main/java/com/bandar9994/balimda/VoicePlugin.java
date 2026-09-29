// Balimda — © 2026 Bandar Altariqi. All rights reserved.
// Licensed under the Balimda License (see LICENSE): non-commercial use only;
// keep the Balimda name and the "Balimda by Bandar Altariqi" credit; no rebranding.

package com.bandar9994.balimda;

import android.Manifest;
import android.content.ComponentName;
import android.content.Intent;
import android.content.pm.ResolveInfo;
import android.provider.Settings;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.speech.RecognitionListener;
import android.speech.RecognitionService;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Voice chat with the phone's own speech services: speech recognition
 * (Google's, or on-device only when "Private voice" is on) and text to speech.
 *
 * listen({lang, offline}) resolves with {text} when the user stops talking
 * ("" if nothing was heard). While listening, "voice" events carry
 * {state: "listening"}, {partial: "..."} and {level: 0..1}.
 * speak({text, lang, rate}) resolves when the text has been spoken; calls
 * queue up, so a reply can be spoken sentence by sentence as it's written.
 */
@CapacitorPlugin(name = "Voice", permissions = { @Permission(alias = "microphone", strings = { Manifest.permission.RECORD_AUDIO }) })
public class VoicePlugin extends Plugin {

    private final Handler main = new Handler(Looper.getMainLooper());

    // Listening (only touched on the main thread).
    private SpeechRecognizer recognizer;
    private PluginCall listenCall;
    private String heard = "";
    private long lastLevel = 0;
    private boolean ready = false;           // the recognizer started listening
    private boolean triedOther = false;      // another speech service was tried for this listen
    private boolean stopping = false;        // the user stopped listening
    // A speech service that worked when the phone's default one didn't start
    // (some phones' own voice input fails with apps). Kept while the app runs.
    private static ComponentName workingService = null;

    // Speaking.
    private TextToSpeech tts;
    private Boolean ttsReady = null;  // null while starting
    private final List<Runnable> afterTtsStarts = new ArrayList<>();
    private final Map<String, PluginCall> speaking = new ConcurrentHashMap<>();

    @PluginMethod
    public void available(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("recognition", SpeechRecognizer.isRecognitionAvailable(getContext()));
        ret.put("onDevice", Build.VERSION.SDK_INT >= 31 && SpeechRecognizer.isOnDeviceRecognitionAvailable(getContext()));
        ret.put("tts", true);
        call.resolve(ret);
    }

    // ---- listening ------------------------------------------------------------------

    @PluginMethod
    public void listen(PluginCall call) {
        if (getPermissionState("microphone") != PermissionState.GRANTED) {
            requestPermissionForAlias("microphone", call, "micPermission");
            return;
        }
        main.post(() -> startListening(call));
    }

    @PermissionCallback
    private void micPermission(PluginCall call) {
        if (getPermissionState("microphone") == PermissionState.GRANTED) {
            main.post(() -> startListening(call));
        } else {
            call.reject("Balimda needs the microphone to hear you. Allow it in the phone's Settings → Apps → Balimda → Permissions.", "mic-denied");
        }
    }

    private void startListening(PluginCall call) {
        finishListening(null, null);
        triedOther = false;
        stopping = false;
        startRecognizer(call, workingService);
    }

    // The phone's default speech service, e.g. "com.google.android.tts/…", or null.
    private ComponentName defaultService() {
        try {
            String s = Settings.Secure.getString(getContext().getContentResolver(), "voice_recognition_service");
            return s == null || s.isEmpty() ? null : ComponentName.unflattenFromString(s);
        } catch (Exception e) {
            return null;  // not readable on this phone
        }
    }

    // Another installed speech service to try when `failed` didn't start
    // (Google's first), or null.
    private ComponentName otherService(ComponentName failed) {
        List<ResolveInfo> services = getContext().getPackageManager()
            .queryIntentServices(new Intent(RecognitionService.SERVICE_INTERFACE), 0);
        ComponentName pick = null;
        for (ResolveInfo info : services) {
            if (info.serviceInfo == null) continue;
            ComponentName c = new ComponentName(info.serviceInfo.packageName, info.serviceInfo.name);
            if (c.equals(failed)) continue;
            if (pick == null || c.getPackageName().startsWith("com.google.")) pick = c;
        }
        return pick;
    }

    // Starts listening with `service` (null = the phone's default).
    private void startRecognizer(PluginCall call, ComponentName service) {
        String lang = call.getString("lang", "en-US");
        boolean offline = Boolean.TRUE.equals(call.getBoolean("offline", false));
        final ComponentName using = service != null ? service : defaultService();

        if (offline) {
            if (Build.VERSION.SDK_INT < 31 || !SpeechRecognizer.isOnDeviceRecognitionAvailable(getContext())) {
                call.reject("Private voice needs offline speech recognition, which this phone doesn't have (Android 12 or newer with Google's speech services). Turn off \"Private voice\" in Settings → Voice.", "offline-unavailable");
                return;
            }
            recognizer = SpeechRecognizer.createOnDeviceSpeechRecognizer(getContext());
        } else {
            if (!SpeechRecognizer.isRecognitionAvailable(getContext())) {
                call.reject("This phone has no speech recognition service. Install or enable Google (or \"Speech Services by Google\") and try again.", "unavailable");
                return;
            }
            recognizer = service != null
                ? SpeechRecognizer.createSpeechRecognizer(getContext(), service)
                : SpeechRecognizer.createSpeechRecognizer(getContext());
        }

        Intent intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
        intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
        intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, lang);
        intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_PREFERENCE, lang);
        intent.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true);
        intent.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1);
        intent.putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, getContext().getPackageName());
        if (offline) intent.putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true);

        listenCall = call;
        heard = "";
        ready = false;
        final SpeechRecognizer current = recognizer;
        recognizer.setRecognitionListener(new RecognitionListener() {
            @Override public void onReadyForSpeech(Bundle params) {
                ready = true;
                if (!offline && using != null && triedOther) workingService = using;
                emit("state", "listening");
            }
            @Override public void onBeginningOfSpeech() {}
            @Override public void onRmsChanged(float rmsdB) {
                long now = System.currentTimeMillis();
                if (now - lastLevel < 100) return;
                lastLevel = now;
                JSObject evt = new JSObject();
                evt.put("level", Math.max(0f, Math.min(1f, (rmsdB + 2f) / 12f)));
                notifyListeners("voice", evt);
            }
            @Override public void onBufferReceived(byte[] buffer) {}
            @Override public void onEndOfSpeech() {
                emit("state", "thinking");
            }
            @Override public void onPartialResults(Bundle results) {
                String text = first(results);
                if (text == null || text.isEmpty()) return;
                heard = text;
                emit("partial", text);
            }
            @Override public void onResults(Bundle results) {
                if (current != recognizer) return;
                String text = first(results);
                finishListening(text != null ? text : heard, null);
            }
            @Override public void onError(int error) {
                if (current != recognizer) return;
                // The speech service failed before it listened at all: try another
                // one once, then say what went wrong (not "didn't catch that").
                if (!ready && !stopping && heard.isEmpty() && !offline && isQuietError(error)) {
                    ComponentName other = triedOther ? null : otherService(using);
                    if (other != null) {
                        triedOther = true;
                        destroyRecognizer();
                        main.post(() -> {
                            if (listenCall == call) startRecognizer(call, other);
                        });
                        return;
                    }
                    workingService = null;
                    finishListening(null, "The phone's speech recognition didn't start (error " + error
                        + (using != null ? ", " + using.getPackageName() : "") + "). Make sure \"Speech Services by Google\" "
                        + "(or the Google app) is installed and up to date, and set it as the phone's voice input "
                        + "(Settings → search for \"voice input\"). Or turn on \"Private voice\" in Balimda's Settings → Voice.");
                    return;
                }
                onListenError(error, intent, offline, lang);
            }
            @Override public void onEvent(int eventType, Bundle params) {}
        });
        recognizer.startListening(intent);
    }

    private void onListenError(int error, Intent intent, boolean offline, String lang) {
        switch (error) {
            case SpeechRecognizer.ERROR_NO_MATCH:
            case SpeechRecognizer.ERROR_SPEECH_TIMEOUT:
            case SpeechRecognizer.ERROR_CLIENT:  // some phones report this when listening is stopped
                finishListening(heard, null);  // nothing (more) was said
                return;
            case SpeechRecognizer.ERROR_AUDIO:
                finishListening(null, "Couldn't record from the microphone. Another app may be using it (a call or a recorder). Try again.");
                return;
            case SpeechRecognizer.ERROR_TOO_MANY_REQUESTS:
                finishListening(null, "Google's speech recognition is busy right now. Wait a moment, or turn on \"Private voice\" in Settings → Voice.");
                return;
            case SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS:
                finishListening(null, "Balimda needs the microphone to hear you. Allow it in the phone's Settings → Apps → Balimda → Permissions.");
                return;
            case SpeechRecognizer.ERROR_NETWORK:
            case SpeechRecognizer.ERROR_NETWORK_TIMEOUT:
            case SpeechRecognizer.ERROR_SERVER:
            case SpeechRecognizer.ERROR_SERVER_DISCONNECTED:
                finishListening(null, "Speech recognition needs the internet. Connect, or turn on \"Private voice\" in Settings → Voice to recognise speech on the phone.");
                return;
            case SpeechRecognizer.ERROR_RECOGNIZER_BUSY:
                finishListening(null, "The phone's speech recognition is busy (another app may be using it). Try again.");
                return;
            case SpeechRecognizer.ERROR_LANGUAGE_NOT_SUPPORTED:
            case SpeechRecognizer.ERROR_LANGUAGE_UNAVAILABLE:
                String name = Locale.forLanguageTag(lang).getDisplayLanguage(Locale.ENGLISH);
                if (offline && Build.VERSION.SDK_INT >= 33 && recognizer != null) {
                    try {
                        recognizer.triggerModelDownload(intent);
                        finishListening(null, "The phone is downloading its offline " + name + " speech pack. Try again in a minute or two.");
                        return;
                    } catch (Exception ignored) {
                        // fall through
                    }
                }
                finishListening(null, offline
                    ? "This phone can't recognise " + name + " offline yet. Add the " + name + " offline speech pack in the phone's settings (search for \"offline speech recognition\"), or turn off \"Private voice\"."
                    : "This phone's speech recognition doesn't support " + name + ".");
                return;
            default:
                finishListening(null, "Speech recognition stopped (error " + error + "). Try again.");
        }
    }

    // Errors that otherwise mean "nothing was said".
    private static boolean isQuietError(int error) {
        return error == SpeechRecognizer.ERROR_NO_MATCH || error == SpeechRecognizer.ERROR_SPEECH_TIMEOUT
            || error == SpeechRecognizer.ERROR_CLIENT;
    }

    private void destroyRecognizer() {
        if (recognizer != null) {
            try {
                recognizer.destroy();
            } catch (Exception ignored) {
                // already gone
            }
            recognizer = null;
        }
    }

    // Ends listening: resolves the call with `text`, or rejects it with `error`.
    private void finishListening(String text, String error) {
        destroyRecognizer();
        PluginCall call = listenCall;
        listenCall = null;
        if (call == null) return;
        if (error != null) {
            call.reject(error);
        } else {
            JSObject ret = new JSObject();
            ret.put("text", text == null ? "" : text.trim());
            call.resolve(ret);
        }
    }

    @PluginMethod
    public void stopListening(PluginCall call) {
        // The recognizer then sends what it heard (onResults).
        main.post(() -> {
            stopping = true;
            if (recognizer != null) recognizer.stopListening();
            call.resolve();
        });
    }

    @PluginMethod
    public void cancelListening(PluginCall call) {
        main.post(() -> {
            if (recognizer != null) recognizer.cancel();
            finishListening("", null);
            call.resolve();
        });
    }

    private static String first(Bundle results) {
        if (results == null) return null;
        ArrayList<String> list = results.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
        return list == null || list.isEmpty() ? null : list.get(0);
    }

    private void emit(String key, String value) {
        JSObject evt = new JSObject();
        evt.put(key, value);
        notifyListeners("voice", evt);
    }

    // ---- speaking -------------------------------------------------------------------

    private void withTts(Runnable then) {
        main.post(() -> {
            if (ttsReady != null) {
                then.run();
                return;
            }
            afterTtsStarts.add(then);
            if (tts != null) return;
            tts = new TextToSpeech(getContext(), (status) -> main.post(() -> {
                ttsReady = status == TextToSpeech.SUCCESS;
                for (Runnable r : afterTtsStarts) r.run();
                afterTtsStarts.clear();
            }));
            tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
                @Override public void onStart(String id) {}
                @Override public void onDone(String id) {
                    finishSpeaking(id, false);
                }
                @Override public void onError(String id) {
                    finishSpeaking(id, false);
                }
                @Override public void onStop(String id, boolean interrupted) {
                    finishSpeaking(id, true);
                }
            });
        });
    }

    private void finishSpeaking(String id, boolean interrupted) {
        PluginCall call = speaking.remove(id);
        if (call == null) return;
        JSObject ret = new JSObject();
        ret.put("interrupted", interrupted);
        call.resolve(ret);
    }

    @PluginMethod
    public void speak(PluginCall call) {
        String text = call.getString("text", "");
        String lang = call.getString("lang", "en-US");
        float rate = call.getFloat("rate", 1.0f);
        withTts(() -> {
            if (!Boolean.TRUE.equals(ttsReady)) {
                call.reject("This phone has no text-to-speech engine. Install \"Speech Services by Google\" and try again.", "no-tts");
                return;
            }
            int ok = tts.setLanguage(Locale.forLanguageTag(lang));
            if (ok == TextToSpeech.LANG_MISSING_DATA || ok == TextToSpeech.LANG_NOT_SUPPORTED) {
                String name = Locale.forLanguageTag(lang).getDisplayLanguage(Locale.ENGLISH);
                call.reject("This phone has no " + name + " voice. Add one in the phone's Settings → Text-to-speech output (Speech Services by Google → Install voice data).", "no-voice");
                return;
            }
            tts.setSpeechRate(rate);
            String id = UUID.randomUUID().toString();
            speaking.put(id, call);
            if (tts.speak(text, TextToSpeech.QUEUE_ADD, null, id) != TextToSpeech.SUCCESS) {
                // Refused (e.g. too long): no callback will come for it.
                speaking.remove(id);
                call.reject("The phone couldn't read this aloud.", "tts-refused");
            }
        });
    }

    @PluginMethod
    public void stopSpeaking(PluginCall call) {
        main.post(() -> {
            if (tts != null) tts.stop();
            for (String id : new ArrayList<>(speaking.keySet())) finishSpeaking(id, true);
            call.resolve();
        });
    }

    // Android doesn't let an app in the background use the microphone:
    // leaving the app ends listening (with what was heard so far).
    @Override
    protected void handleOnPause() {
        main.post(() -> {
            if (recognizer != null) recognizer.cancel();
            finishListening(heard, null);
        });
    }

    @Override
    protected void handleOnDestroy() {
        main.post(() -> {
            finishListening("", null);
            if (tts != null) {
                tts.stop();
                tts.shutdown();
                tts = null;
            }
        });
    }
}
