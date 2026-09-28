// Balimda — © 2026 Bandar Altariqi. All rights reserved.
// Licensed under the Balimda License (see LICENSE): non-commercial use only;
// keep the Balimda name and the "Balimda by Bandar Altariqi" credit; no rebranding.

// Balimda's on-device engine (see include/balimda_engine.h).
//
// One engine = one loaded model + context. Chats are formatted with the
// model's own chat template, and the KV cache is reused between turns so only
// the new part of a conversation has to be processed.

#include "balimda_engine.h"

#include <algorithm>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <mutex>
#include <random>
#include <string>
#include <vector>

// The iOS build gets llama.cpp as a framework, the Android build as sources.
#if __has_include(<llama/llama.h>)
#include <llama/ggml-backend.h>
#include <llama/llama.h>
#else
#include "ggml-backend.h"
#include "llama.h"
#endif

#ifdef __ANDROID__
#include <android/log.h>
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, "BalimdaLlama", __VA_ARGS__)
#else
#define LOGI(...) (fprintf(stderr, __VA_ARGS__), fputc('\n', stderr))
#endif

struct be_engine {
    llama_model * model = nullptr;
    llama_context * ctx = nullptr;
    const llama_vocab * vocab = nullptr;
    std::vector<llama_token> cached;  // tokens currently in the KV cache
    std::string tmpl;                 // chat template ("" = built-in default)
    std::string offload;              // e.g. "offloaded 29/29 layers to GPU"
};

namespace {

std::once_flag backend_once;
std::mutex log_mutex;
std::string last_offload;  // captured from llama.cpp's log while a model loads

void on_log(ggml_log_level level, const char * text, void *) {
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
        llama_log_set(on_log, nullptr);
        llama_backend_init();
    });
}

char * copy_string(const std::string & s) {
    char * out = static_cast<char *>(malloc(s.size() + 1));
    if (out) memcpy(out, s.c_str(), s.size() + 1);
    return out;
}

void set_error(char ** error, const std::string & msg) {
    if (error) *error = copy_string(msg);
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

std::string apply_template(const be_engine & e, const std::vector<std::string> & roles,
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

char * be_devices(void) {
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
    return copy_string(out);
}

be_engine * be_load(const char * path, int n_ctx, int n_gpu_layers, int n_threads, char ** error) {
    init_backend();

    llama_model_params mp = llama_model_default_params();
    mp.n_gpu_layers = n_gpu_layers;
    {
        std::lock_guard<std::mutex> lock(log_mutex);
        last_offload.clear();
    }
    llama_model * model = llama_model_load_from_file(path, mp);
    if (!model) {
        set_error(error, "Couldn't load the model file. It may be incomplete or not a GGUF model; try deleting and downloading it again.");
        return nullptr;
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
        set_error(error, "Not enough memory for this model and context size. Try a smaller model or a smaller context.");
        return nullptr;
    }

    auto * e = new be_engine();
    e->model = model;
    e->ctx = ctx;
    e->vocab = llama_model_get_vocab(model);
    const char * tmpl = llama_model_chat_template(model, nullptr);
    if (tmpl) e->tmpl = tmpl;
    {
        std::lock_guard<std::mutex> lock(log_mutex);
        e->offload = last_offload;
    }
    LOGI("loaded %s (ctx %d, gpu layers %d, threads %d)", path, n_ctx, n_gpu_layers, n_threads);
    return e;
}

const char * be_offload(const be_engine * e) {
    return e ? e->offload.c_str() : "";
}

void be_free(be_engine * e) {
    if (!e) return;
    llama_free(e->ctx);
    llama_model_free(e->model);
    delete e;
}

void be_string_free(char * s) {
    free(s);
}

char * be_complete(be_engine * e, const char * const * c_roles, const char * const * c_contents, int n_messages,
                   int max_tokens, float temperature, be_token_fn on_token, void * user, char ** error) {
    if (!e) {
        set_error(error, "Model is not loaded");
        return nullptr;
    }
    std::vector<std::string> roles, contents;
    for (int i = 0; i < n_messages; i++) {
        roles.emplace_back(c_roles[i] ? c_roles[i] : "user");
        contents.emplace_back(c_contents[i] ? c_contents[i] : "");
    }

    // Tokenize a prompt (add BOS if the model wants it; the template's special tokens are parsed).
    auto tokenize = [&](const std::string & text) {
        std::vector<llama_token> out(text.size() + 16);
        int32_t n = llama_tokenize(e->vocab, text.c_str(), int32_t(text.size()), out.data(), int32_t(out.size()), true, true);
        if (n < 0) {
            out.resize(-n);
            n = llama_tokenize(e->vocab, text.c_str(), int32_t(text.size()), out.data(), int32_t(out.size()), true, true);
        }
        out.resize(std::max(n, 0));
        return out;
    };

    // Keep as much of the chat as fits, leaving room for the reply: the
    // oldest messages go first (the system prompt always stays), and the
    // chat always starts with a user message.
    const int32_t n_ctx = int32_t(llama_n_ctx(e->ctx));
    const int32_t reserve = std::max<int32_t>(256, std::min<int32_t>(max_tokens, n_ctx / 4));
    const size_t first = (!roles.empty() && roles[0] == "system") ? 1 : 0;
    size_t from = first;
    std::vector<llama_token> tokens;
    for (;;) {
        std::vector<std::string> r, c;
        if (first) {
            r.push_back(roles[0]);
            c.push_back(contents[0]);
        }
        for (size_t i = from; i < roles.size(); i++) {
            r.push_back(roles[i]);
            c.push_back(contents[i]);
        }
        const std::string prompt = apply_template(*e, r, c);
        if (prompt.empty()) {
            set_error(error, "Couldn't format the conversation for this model.");
            return nullptr;
        }
        tokens = tokenize(prompt);
        if (int32_t(tokens.size()) + reserve <= n_ctx) break;
        // Drop the oldest message, then up to the next user message.
        size_t next = from + 1;
        while (next < roles.size() && roles[next] != "user") next++;
        if (next >= roles.size()) break;  // only the last question is left
        from = next;
    }
    if (int32_t(tokens.size()) + 8 >= n_ctx) {
        set_error(error, "This message is longer than the model's memory. Shorten it, or raise the context size in Settings.");
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

    auto emit = [&](const std::string & text) -> bool {
        return on_token ? on_token(user, text.c_str()) : true;
    };

    // Also says how much of the chat the model was given: its size in tokens,
    // how many messages (not counting the system prompt) and the context size.
    const size_t n_sent = roles.size() - from;
    auto result = [&](const std::string & reason, size_t n_prompt, double prompt_ms, int n_gen, double gen_ms) {
        char buf[200];
        snprintf(buf, sizeof(buf), "%s\t%zu\t%.1f\t%d\t%.1f\t%zu\t%zu\t%d", reason.c_str(), n_prompt, prompt_ms, n_gen, gen_ms,
                 tokens.size(), n_sent, n_ctx);
        return copy_string(buf);
    };

    // Process the prompt in batches; an empty on_token("") call lets the user cancel.
    const double t_prompt = now_ms();
    const size_t n_new_prompt = tokens.size() - keep;
    const int32_t n_batch = int32_t(llama_n_batch(e->ctx));
    for (size_t i = keep; i < tokens.size(); i += n_batch) {
        const int32_t n = int32_t(std::min<size_t>(n_batch, tokens.size() - i));
        if (llama_decode(e->ctx, llama_batch_get_one(tokens.data() + i, n)) != 0) {
            llama_memory_clear(mem, true);
            e->cached.clear();
            set_error(error, "The model failed while reading the chat.");
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
