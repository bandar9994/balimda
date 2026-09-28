// Balimda — © 2026 Bandar Altariqi. All rights reserved.
// Licensed under the Balimda License (see LICENSE): non-commercial use only;
// keep the Balimda name and the "Balimda by Bandar Altariqi" credit; no rebranding.

// JNI bridge between Balimda (com.bandar9994.balimda.LlamaEngine) and the
// on-device engine shared with the iOS app (native/llama/engine).

#include <jni.h>

#include <cstdint>
#include <string>
#include <vector>

#include "balimda_engine.h"

namespace {

void throw_java(JNIEnv * env, const std::string & msg) {
    jclass cls = env->FindClass("java/lang/RuntimeException");
    env->ThrowNew(cls, msg.c_str());
}

// Throws the engine's error message (and frees it).
void throw_engine_error(JNIEnv * env, char * error, const char * fallback) {
    throw_java(env, error ? error : fallback);
    be_string_free(error);
}

// Java strings are UTF-16; JNI's "UTF" helpers use modified UTF-8, which
// mangles emoji and other 4-byte characters, so convert by hand.
std::string to_utf8(JNIEnv * env, jstring s) {
    if (!s) return {};
    const jsize len = env->GetStringLength(s);
    const jchar * chars = env->GetStringChars(s, nullptr);
    std::string out;
    out.reserve(len);
    for (jsize i = 0; i < len; i++) {
        uint32_t c = chars[i];
        if (c >= 0xD800 && c <= 0xDBFF && i + 1 < len && chars[i + 1] >= 0xDC00 && chars[i + 1] <= 0xDFFF) {
            c = 0x10000 + ((c - 0xD800) << 10) + (chars[i + 1] - 0xDC00);
            i++;
        }
        if (c < 0x80) {
            out += char(c);
        } else if (c < 0x800) {
            out += char(0xC0 | (c >> 6));
            out += char(0x80 | (c & 0x3F));
        } else if (c < 0x10000) {
            out += char(0xE0 | (c >> 12));
            out += char(0x80 | ((c >> 6) & 0x3F));
            out += char(0x80 | (c & 0x3F));
        } else {
            out += char(0xF0 | (c >> 18));
            out += char(0x80 | ((c >> 12) & 0x3F));
            out += char(0x80 | ((c >> 6) & 0x3F));
            out += char(0x80 | (c & 0x3F));
        }
    }
    env->ReleaseStringChars(s, chars);
    return out;
}

jstring to_jstring(JNIEnv * env, const std::string & s) {
    std::vector<jchar> out;
    out.reserve(s.size());
    for (size_t i = 0; i < s.size();) {
        const unsigned char b = s[i];
        uint32_t c;
        int n;
        if (b < 0x80) { c = b; n = 1; }
        else if ((b >> 5) == 0x6) { c = b & 0x1F; n = 2; }
        else if ((b >> 4) == 0xE) { c = b & 0x0F; n = 3; }
        else if ((b >> 3) == 0x1E) { c = b & 0x07; n = 4; }
        else { c = 0xFFFD; n = 1; }
        if (i + n > s.size()) { c = 0xFFFD; n = 1; }
        for (int k = 1; k < n; k++) c = (c << 6) | (s[i + k] & 0x3F);
        i += n;
        if (c >= 0x10000) {
            c -= 0x10000;
            out.push_back(jchar(0xD800 + (c >> 10)));
            out.push_back(jchar(0xDC00 + (c & 0x3FF)));
        } else {
            out.push_back(jchar(c));
        }
    }
    return env->NewString(out.data(), jsize(out.size()));
}

// Passes each piece of the reply to TokenCallback.onToken(String).
struct TokenSink {
    JNIEnv * env;
    jobject callback;
    jmethodID on_token;
};

bool on_token(void * user, const char * text) {
    auto * sink = static_cast<TokenSink *>(user);
    JNIEnv * env = sink->env;
    jstring js = to_jstring(env, text);
    const jboolean go_on = env->CallBooleanMethod(sink->callback, sink->on_token, js);
    env->DeleteLocalRef(js);
    if (env->ExceptionCheck()) {
        env->ExceptionClear();
        return false;
    }
    return go_on;
}

}  // namespace

extern "C" {

JNIEXPORT jstring JNICALL
Java_com_bandar9994_balimda_LlamaEngine_nativeDevices(JNIEnv * env, jclass) {
    char * devices = be_devices();
    jstring out = to_jstring(env, devices ? devices : "");
    be_string_free(devices);
    return out;
}

JNIEXPORT jlong JNICALL
Java_com_bandar9994_balimda_LlamaEngine_nativeLoad(JNIEnv * env, jclass, jstring jpath, jint n_ctx,
                                               jint n_gpu_layers, jint n_threads) {
    const std::string path = to_utf8(env, jpath);
    char * error = nullptr;
    be_engine * e = be_load(path.c_str(), n_ctx, n_gpu_layers, n_threads, &error);
    if (!e) {
        throw_engine_error(env, error, "Couldn't load the model.");
        return 0;
    }
    return reinterpret_cast<jlong>(e);
}

// Where the loaded model runs, e.g. "offloaded 29/29 layers to GPU" ("" = CPU only).
JNIEXPORT jstring JNICALL
Java_com_bandar9994_balimda_LlamaEngine_nativeOffload(JNIEnv * env, jclass, jlong handle) {
    return to_jstring(env, be_offload(reinterpret_cast<be_engine *>(handle)));
}

JNIEXPORT void JNICALL
Java_com_bandar9994_balimda_LlamaEngine_nativeFree(JNIEnv *, jclass, jlong handle) {
    be_free(reinterpret_cast<be_engine *>(handle));
}

// Streams a reply. `callback.onToken(String)` receives text pieces and returns
// false to stop. Returns the engine's result line (see balimda_engine.h).
JNIEXPORT jstring JNICALL
Java_com_bandar9994_balimda_LlamaEngine_nativeComplete(JNIEnv * env, jclass, jlong handle, jobjectArray jroles,
                                                   jobjectArray jcontents, jint max_tokens, jfloat temperature,
                                                   jobject callback) {
    std::vector<std::string> roles, contents;
    const jsize n_msgs = env->GetArrayLength(jroles);
    for (jsize i = 0; i < n_msgs; i++) {
        auto r = (jstring) env->GetObjectArrayElement(jroles, i);
        auto c = (jstring) env->GetObjectArrayElement(jcontents, i);
        roles.push_back(to_utf8(env, r));
        contents.push_back(to_utf8(env, c));
        env->DeleteLocalRef(r);
        env->DeleteLocalRef(c);
    }
    std::vector<const char *> c_roles, c_contents;
    for (jsize i = 0; i < n_msgs; i++) {
        c_roles.push_back(roles[i].c_str());
        c_contents.push_back(contents[i].c_str());
    }

    jclass cb_cls = env->GetObjectClass(callback);
    TokenSink sink{env, callback, env->GetMethodID(cb_cls, "onToken", "(Ljava/lang/String;)Z")};
    char * error = nullptr;
    char * result = be_complete(reinterpret_cast<be_engine *>(handle), c_roles.data(), c_contents.data(), int(n_msgs),
                                max_tokens, temperature, on_token, &sink, &error);
    if (!result) {
        throw_engine_error(env, error, "The model failed.");
        return nullptr;
    }
    jstring out = to_jstring(env, result);
    be_string_free(result);
    return out;
}

}  // extern "C"
