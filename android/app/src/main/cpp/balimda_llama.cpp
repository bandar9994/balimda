// JNI bridge between Balimda (com.bandar9994.balimda.LlamaEngine) and llama.cpp.
//
// One engine = one loaded model + context. Chats are formatted with the
// model's own chat template, and the KV cache is reused between turns so only
// the new part of a conversation has to be processed.

#include <jni.h>

#include <algorithm>
#include <chrono>
#include <cstring>
#include <mutex>
#include <random>
#include <string>
#include <vector>

#include "ggml-backend.h"
#include "llama.h"

#ifdef __ANDROID__
#include <android/log.h>
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, "BalimdaLlama", __VA_ARGS__)
#else
#include <cstdio>
#define LOGI(...) (fprintf(stderr, __VA_ARGS__), fputc('\n', stderr))
#endif

namespace {

struct Engine {
    llama_model * model = nullptr;
    llama_context * ctx = nullptr;
    const llama_vocab * vocab = nullptr;
    std::vector<llama_token> cached;  // tokens currently in the KV cache
    std::string tmpl;                 // chat template ("" = built-in default)
    std::string offload;              // e.g. "offloaded 29/29 layers to GPU"
};

std::once_flag backend_once;
std::mutex log_mutex;
std::string last_offload;  // captured from llama.cpp's log while a model loads

void log_to_logcat(ggml_log_level level, const char * text, void *) {
    if (level >= GGML_LOG_LEVEL_WARN) LOGI("%s", text);
    // llama.cpp reports how many layers went to the GPU; keep it so the app
    // can show where the model really runs.
    const char * p = strstr(text, "offloaded ");
    if (p && strstr(p, "layers to GPU")) {
        std::lock_guard<std::mutex> lock(log_mutex);
        last_offload = p;
        while (!last_offload.empty() && (last_offload.back() == '\n' || last_offload.back() == ' ')) last_offload.pop_back();
    }
}

double now_ms() {
    using namespace std::chrono;
    return duration<double, std::milli>(steady_clock::now().time_since_epoch()).count();
}

void init_backend() {
    std::call_once(backend_once, [] {
        llama_log_set(log_to_logcat, nullptr);
        llama_backend_init();
    });
}

void throw_java(JNIEnv * env, const std::string & msg) {
    jclass cls = env->FindClass("java/lang/RuntimeException");
    env->ThrowNew(cls, msg.c_str());
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

// Length of the longest prefix of `s` that doesn't end inside a UTF-8
// character. Tokens can split multi-byte characters, so we hold back the tail.
size_t complete_utf8_prefix(const std::string & s) {
    size_t i = s.size();
    int back = 0;
    while (i > 0 && back < 4) {
        const unsigned char b = s[i - 1];
        if ((b & 0xC0) != 0x80) {  // lead byte (or ASCII)
            int need = b < 0x80 ? 1 : (b >> 5) == 0x6 ? 2 : (b >> 4) == 0xE ? 3 : (b >> 3) == 0x1E ? 4 : 1;
            return (back + 1 >= need) ? s.size() : i - 1;
        }
        i--;
        back++;
    }
    return s.size();
}

std::string apply_template(const Engine & e, const std::vector<std::string> & roles,
                           const std::vector<std::string> & contents) {
    std::vector<llama_chat_message> msgs;
    for (size_t i = 0; i < roles.size(); i++) msgs.push_back({roles[i].c_str(), contents[i].c_str()});

    size_t total = 0;
    for (auto & c : contents) total += c.size();
    std::vector<char> buf(total * 2 + 1024);

    auto run = [&](const char * tmpl) -> int32_t {
        int32_t n = llama_chat_apply_template(tmpl, msgs.data(), msgs.size(), true, buf.data(), int32_t(buf.size()));
        if (n > int32_t(buf.size())) {
            buf.resize(n + 1);
            n = llama_chat_apply_template(tmpl, msgs.data(), msgs.size(), true, buf.data(), int32_t(buf.size()));
        }
        return n;
    };
    int32_t n = run(e.tmpl.empty() ? nullptr : e.tmpl.c_str());
    if (n < 0) n = run("chatml");  // unknown template: ChatML works for most small models
    if (n < 0) return {};
    return std::string(buf.data(), n);
}

}  // namespace

extern "C" {

JNIEXPORT jstring JNICALL
Java_com_bandar9994_balimda_LlamaEngine_nativeDevices(JNIEnv * env, jclass) {
    init_backend();
    std::string out;
    for (size_t i = 0; i < ggml_backend_dev_count(); i++) {
        ggml_backend_dev_t dev = ggml_backend_dev_get(i);
        const char * kind = "other";
        switch (ggml_backend_dev_type(dev)) {
            case GGML_BACKEND_DEVICE_TYPE_CPU: kind = "cpu"; break;
            case GGML_BACKEND_DEVICE_TYPE_GPU: kind = "gpu"; break;
            case GGML_BACKEND_DEVICE_TYPE_IGPU: kind = "gpu"; break;
            default: break;
        }
        out += std::string(kind) + "\t" + ggml_backend_dev_name(dev) + "\t" + ggml_backend_dev_description(dev) + "\n";
    }
    return to_jstring(env, out);
}

JNIEXPORT jlong JNICALL
Java_com_bandar9994_balimda_LlamaEngine_nativeLoad(JNIEnv * env, jclass, jstring jpath, jint n_ctx,
                                               jint n_gpu_layers, jint n_threads) {
    init_backend();
    const std::string path = to_utf8(env, jpath);

    llama_model_params mp = llama_model_default_params();
    mp.n_gpu_layers = n_gpu_layers;
    {
        std::lock_guard<std::mutex> lock(log_mutex);
        last_offload.clear();
    }
    llama_model * model = llama_model_load_from_file(path.c_str(), mp);
    if (!model) {
        throw_java(env, "Couldn't load the model file. It may be incomplete or not a GGUF model; try deleting and downloading it again.");
        return 0;
    }

    llama_context_params cp = llama_context_default_params();
    cp.n_ctx = uint32_t(n_ctx);
    cp.n_batch = 512;
    cp.n_ubatch = 512;
    cp.n_threads = n_threads;
    cp.n_threads_batch = n_threads;
    llama_context * ctx = llama_init_from_model(model, cp);
    if (!ctx) {
        llama_model_free(model);
        throw_java(env, "Not enough memory for this model and context size. Try a smaller model or a smaller context.");
        return 0;
    }

    auto * e = new Engine();
    e->model = model;
    e->ctx = ctx;
    e->vocab = llama_model_get_vocab(model);
    const char * tmpl = llama_model_chat_template(model, nullptr);
    if (tmpl) e->tmpl = tmpl;
    {
        std::lock_guard<std::mutex> lock(log_mutex);
        e->offload = last_offload;
    }
    LOGI("loaded %s (ctx %d, gpu layers %d, threads %d)", path.c_str(), n_ctx, n_gpu_layers, n_threads);
    return reinterpret_cast<jlong>(e);
}

// Where the loaded model runs, e.g. "offloaded 29/29 layers to GPU" ("" = CPU only).
JNIEXPORT jstring JNICALL
Java_com_bandar9994_balimda_LlamaEngine_nativeOffload(JNIEnv * env, jclass, jlong handle) {
    auto * e = reinterpret_cast<Engine *>(handle);
    return to_jstring(env, e ? e->offload : std::string());
}

JNIEXPORT void JNICALL
Java_com_bandar9994_balimda_LlamaEngine_nativeFree(JNIEnv *, jclass, jlong handle) {
    auto * e = reinterpret_cast<Engine *>(handle);
    if (!e) return;
    llama_free(e->ctx);
    llama_model_free(e->model);
    delete e;
}

// Streams a reply. `callback.onToken(String)` receives text pieces and returns
// false to stop. Returns "<reason>\t<prompt tokens>\t<prompt ms>\t<generated tokens>\t<generation ms>"
// where reason is "end_turn", "max_tokens" or "aborted".
JNIEXPORT jstring JNICALL
Java_com_bandar9994_balimda_LlamaEngine_nativeComplete(JNIEnv * env, jclass, jlong handle, jobjectArray jroles,
                                                   jobjectArray jcontents, jint max_tokens, jfloat temperature,
                                                   jobject callback) {
    auto * e = reinterpret_cast<Engine *>(handle);
    if (!e) {
        throw_java(env, "Model is not loaded");
        return nullptr;
    }

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

    const std::string prompt = apply_template(*e, roles, contents);
    if (prompt.empty()) {
        throw_java(env, "Couldn't format the conversation for this model.");
        return nullptr;
    }

    // Tokenize (add BOS if the model wants it; the template's special tokens are parsed).
    std::vector<llama_token> tokens(prompt.size() + 16);
    int32_t n_tok = llama_tokenize(e->vocab, prompt.c_str(), int32_t(prompt.size()), tokens.data(),
                                   int32_t(tokens.size()), true, true);
    if (n_tok < 0) {
        tokens.resize(-n_tok);
        n_tok = llama_tokenize(e->vocab, prompt.c_str(), int32_t(prompt.size()), tokens.data(),
                               int32_t(tokens.size()), true, true);
    }
    tokens.resize(std::max(n_tok, 0));

    const int32_t n_ctx = int32_t(llama_n_ctx(e->ctx));
    if (int32_t(tokens.size()) + 8 >= n_ctx) {
        throw_java(env, "This chat is longer than the model's memory. Start a new chat or raise the context size in Settings.");
        return nullptr;
    }

    // Reuse the part of the conversation that's already in the KV cache.
    size_t keep = 0;
    while (keep < e->cached.size() && keep < tokens.size() && e->cached[keep] == tokens[keep]) keep++;
    if (keep == tokens.size() && keep > 0) keep--;  // must decode at least one token to get logits
    llama_memory_t mem = llama_get_memory(e->ctx);
    if (!llama_memory_seq_rm(mem, 0, llama_pos(keep), -1)) {
        llama_memory_clear(mem, true);
        keep = 0;
    }
    e->cached.assign(tokens.begin(), tokens.begin() + keep);

    jclass cb_cls = env->GetObjectClass(callback);
    jmethodID on_token = env->GetMethodID(cb_cls, "onToken", "(Ljava/lang/String;)Z");
    auto emit = [&](const std::string & text) -> bool {
        jstring js = to_jstring(env, text);
        const jboolean go_on = env->CallBooleanMethod(callback, on_token, js);
        env->DeleteLocalRef(js);
        if (env->ExceptionCheck()) {
            env->ExceptionClear();
            return false;
        }
        return go_on;
    };

    auto result = [&](const std::string & reason, size_t n_prompt, double prompt_ms, int n_gen, double gen_ms) {
        char buf[160];
        snprintf(buf, sizeof(buf), "%s\t%zu\t%.1f\t%d\t%.1f", reason.c_str(), n_prompt, prompt_ms, n_gen, gen_ms);
        return to_jstring(env, buf);
    };

    // Process the prompt in batches; an empty onToken("") call lets the user cancel.
    const double t_prompt = now_ms();
    const size_t n_new_prompt = tokens.size() - keep;
    const int32_t n_batch = int32_t(llama_n_batch(e->ctx));
    for (size_t i = keep; i < tokens.size(); i += n_batch) {
        const int32_t n = int32_t(std::min<size_t>(n_batch, tokens.size() - i));
        if (llama_decode(e->ctx, llama_batch_get_one(tokens.data() + i, n)) != 0) {
            llama_memory_clear(mem, true);
            e->cached.clear();
            throw_java(env, "The model failed while reading the chat.");
            return nullptr;
        }
        e->cached.insert(e->cached.end(), tokens.begin() + i, tokens.begin() + i + n);
        if (!emit("")) return result("aborted", n_new_prompt, now_ms() - t_prompt, 0, 0);
    }
    const double prompt_ms = now_ms() - t_prompt;

    auto sparams = llama_sampler_chain_default_params();
    llama_sampler * smpl = llama_sampler_chain_init(sparams);
    if (temperature <= 0.0f) {
        llama_sampler_chain_add(smpl, llama_sampler_init_greedy());
    } else {
        llama_sampler_chain_add(smpl, llama_sampler_init_penalties(llama_vocab_n_tokens(e->vocab), 64, 1.05f, 0.0f, 0.0f));
        llama_sampler_chain_add(smpl, llama_sampler_init_top_k(40));
        llama_sampler_chain_add(smpl, llama_sampler_init_top_p(0.95f, 1));
        llama_sampler_chain_add(smpl, llama_sampler_init_min_p(0.05f, 1));
        llama_sampler_chain_add(smpl, llama_sampler_init_temp(temperature));
        llama_sampler_chain_add(smpl, llama_sampler_init_dist(std::random_device{}()));
    }

    std::string stop_reason = "end_turn";
    std::string pending;
    int generated = 0;
    const double t_gen = now_ms();
    for (;;) {
        llama_token tok = llama_sampler_sample(smpl, e->ctx, -1);
        if (llama_vocab_is_eog(e->vocab, tok)) break;

        char piece[256];
        int32_t len = llama_token_to_piece(e->vocab, tok, piece, sizeof(piece), 0, false);
        if (len > 0) pending.append(piece, len);
        const size_t ready = complete_utf8_prefix(pending);
        if (ready > 0) {
            const bool go_on = emit(pending.substr(0, ready));
            pending.erase(0, ready);
            if (!go_on) { stop_reason = "aborted"; break; }
        }

        if (++generated >= max_tokens || int32_t(e->cached.size()) + 1 >= n_ctx) {
            stop_reason = "max_tokens";
            break;
        }
        if (llama_decode(e->ctx, llama_batch_get_one(&tok, 1)) != 0) {
            stop_reason = "max_tokens";
            break;
        }
        e->cached.push_back(tok);
    }
    const double gen_ms = now_ms() - t_gen;
    if (!pending.empty() && stop_reason != "aborted") emit(pending);
    llama_sampler_free(smpl);
    return result(stop_reason, n_new_prompt, prompt_ms, generated, gen_ms);
}

}  // extern "C"
