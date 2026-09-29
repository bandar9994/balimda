// Balimda — © 2026 Bandar Altariqi. All rights reserved.
// Licensed under the Balimda License (see LICENSE): non-commercial use only;
// keep the Balimda name and the "Balimda by Bandar Altariqi" credit; no rebranding.

// Balimda's on-device engine (see include/balimda_engine.h).
//
// One engine = one loaded model + context. Chats are formatted with the
// model's own chat template, and the KV cache is reused between turns so only
// the new part of a conversation has to be processed.
//
// The chat lives in sequence 0 of the KV cache. Background jobs (e.g. updating
// memory after a reply) run in sequence 1 and are removed afterwards, so they
// don't throw away the chat and the next message doesn't have to re-read it.
//
// Images (vision models, with their mmproj file) go through llama.cpp's mtmd:
// the prompt is split into text and image pieces. In the token lists below an
// image's tokens are stood in for by one negative number made from the image's
// hash, so the same image in the same place is recognised in the KV cache.

#include "balimda_engine.h"

#include <algorithm>
#include <chrono>
#include <functional>
#include <memory>
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
#include <llama/mtmd-helper.h>
#include <llama/mtmd.h>
#else
#include "ggml-backend.h"
#include "llama.h"
#include "mtmd-helper.h"
#include "mtmd.h"
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
    mtmd_context * vision = nullptr;  // the image part, when loaded
    std::vector<llama_token> cached;  // tokens currently in the KV cache (images as negative ids)
    std::vector<llama_pos> cached_pos;  // the position of each (an image's tokens share its first)
    std::string tmpl;                 // chat template ("" = built-in default)
    std::string offload;              // e.g. "offloaded 29/29 layers to GPU"
    // Where the kept part of the chat started last time (when it had to be
    // shortened). Starting there again while it fits keeps the start of the
    // prompt the same, so the KV cache can be reused.
    std::string start_role, start_content;
};

namespace {

std::once_flag backend_once;
std::mutex log_mutex;
std::string last_offload;  // captured from llama.cpp's log while a model loads
std::string last_error;    // llama.cpp's last error, to explain a model that won't load

void on_log(ggml_log_level level, const char * text, void *) {
    if (level >= GGML_LOG_LEVEL_WARN) LOGI("%s", text);
    if (level == GGML_LOG_LEVEL_ERROR && strstr(text, "error loading model")) {
        std::lock_guard<std::mutex> lock(log_mutex);
        last_error = text;
    }
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
        mtmd_helper_log_set(on_log, nullptr);
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

// Why llama.cpp couldn't load a model, in words for the user, with its own
// reason at the end (from the log, e.g. "llama_model_load: error loading
// model: error loading model hyperparameters: key ... has wrong array length").
std::string load_error(std::string reason) {
    const std::string marker = "error loading model: ";
    size_t at;
    while ((at = reason.find(marker)) != std::string::npos) reason.erase(0, at + marker.size());
    while (!reason.empty() && (reason.back() == '\n' || reason.back() == ' ')) reason.pop_back();
    const auto has = [&](const char * s) { return reason.find(s) != std::string::npos; };

    // An unreadable or cut-off file (llama.cpp then names the file, not the problem).
    if (reason.empty() || has("failed to load model from") || has("not within the file bounds")) {
        return "Couldn't load the model file. It may be incomplete or not a GGUF model; try deleting and downloading it again.";
    }
    std::string msg;
    if (has("unknown model architecture") || has("unknown pre-tokenizer")) {
        msg = "This version of Balimda can't run this kind of model yet. Try another model, or update Balimda.";
    } else {
        // Wrong or missing settings or parts: the file was made for another app
        // (e.g. Ollama, whose files can hold the vision part too) or by a tool
        // llama.cpp doesn't read. Downloading it again gives the same file.
        msg = "This GGUF file isn't in the format Balimda (llama.cpp) reads. It was probably made for another app, "
              "such as Ollama, so downloading it again won't help. Look for a version of this model made for "
              "llama.cpp, e.g. from bartowski, unsloth or mradermacher on Hugging Face.";
    }
    msg += " (" + reason + ")";
    return msg;
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

// Stands in for an image's tokens in the token lists: a negative number made
// from the image's id (its SHA-256, set by mtmd), never a real token.
llama_token image_token(const char * id) {
    const size_t h = std::hash<std::string>{}(id ? id : "");
    return -2 - llama_token(h % 0x3fffffff);
}

// Decodes tokens into one sequence of the KV cache, starting at position
// `pos`. Only the last token gets logits (that's the one sampled from).
int decode(llama_context * ctx, const llama_token * tokens, int32_t n, llama_pos pos, llama_seq_id seq) {
    llama_batch batch = llama_batch_init(n, 0, 1);
    for (int32_t i = 0; i < n; i++) {
        batch.token[i] = tokens[i];
        batch.pos[i] = pos + i;
        batch.n_seq_id[i] = 1;
        batch.seq_id[i][0] = seq;
        batch.logits[i] = i == n - 1;
    }
    batch.n_tokens = n;
    const int rc = llama_decode(ctx, batch);
    llama_batch_free(batch);
    return rc;
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
        last_error.clear();
    }
    llama_model * model = llama_model_load_from_file(path, mp);
    if (!model) {
        std::string reason;
        {
            std::lock_guard<std::mutex> lock(log_mutex);
            reason = last_error;
        }
        set_error(error, load_error(reason));
        return nullptr;
    }

    llama_context_params cp = llama_context_default_params();
    cp.n_ctx = uint32_t(n_ctx);
    cp.n_batch = 512;
    cp.n_ubatch = 512;
    cp.n_threads = n_threads;
    cp.n_threads_batch = n_threads;
    // Two sequences sharing one cache of n_ctx: the chat, and a background job.
    cp.n_seq_max = 2;
    cp.kv_unified = true;
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

bool be_load_vision(be_engine * e, const char * mmproj_path, bool use_gpu, int n_threads, char ** error) {
    if (!e) {
        set_error(error, "Model is not loaded");
        return false;
    }
    if (e->vision) return true;
    mtmd_context_params mp = mtmd_context_params_default();
    mp.use_gpu = use_gpu;
    mp.n_threads = n_threads;
    mp.print_timings = false;
    mp.warmup = false;
    // Phones: big photos are scaled down to about a thousand tokens.
    mp.image_max_tokens = 1024;
    e->vision = mtmd_init_from_file(mmproj_path, e->model, mp);
    if (!e->vision) {
        set_error(error, "Couldn't load the vision file. It must be the mmproj file made for this model (same family and "
                         "size); if it is, try deleting and downloading it again.");
        return false;
    }
    if (!mtmd_support_vision(e->vision)) {
        mtmd_free(e->vision);
        e->vision = nullptr;
        set_error(error, "This mmproj file is for sound, not images.");
        return false;
    }
    LOGI("vision loaded from %s (gpu %d)", mmproj_path, use_gpu ? 1 : 0);
    return true;
}

bool be_has_vision(const be_engine * e) {
    return e && e->vision;
}

void be_free(be_engine * e) {
    if (!e) return;
    if (e->vision) mtmd_free(e->vision);
    llama_free(e->ctx);
    llama_model_free(e->model);
    delete e;
}

void be_string_free(char * s) {
    free(s);
}

char * be_complete(be_engine * e, const char * const * c_roles, const char * const * c_contents, int n_messages,
                   const int * image_counts, const be_image * images, int max_tokens, float temperature, int background,
                   be_token_fn on_token, void * user, char ** error) {
    if (!e) {
        set_error(error, "Model is not loaded");
        return nullptr;
    }
    // Each message's images go before its text, as mtmd's marker. `keys`
    // tell messages apart by their text and images (to find where the kept
    // part of the chat started last time).
    const std::string marker = mtmd_default_marker();
    struct Bitmaps {
        std::vector<mtmd_bitmap *> all;
        ~Bitmaps() { for (auto * b : all) mtmd_bitmap_free(b); }
    } bitmaps;
    std::vector<std::vector<const mtmd_bitmap *>> message_images(size_t(std::max(n_messages, 0)));
    std::vector<std::string> roles, contents, keys;
    size_t next_image = 0;
    for (int i = 0; i < n_messages; i++) {
        std::string text = c_contents[i] ? c_contents[i] : "";
        // The marker typed in a message would be taken for an image.
        for (size_t at; (at = text.find(marker)) != std::string::npos;) text.erase(at, marker.size());
        std::string prefix, key = text;
        const int n_images = image_counts ? std::max(image_counts[i], 0) : 0;
        for (int k = 0; k < n_images; k++) {
            const be_image & img = images[next_image++];
            if (!e->vision) continue;  // the model can't see: text only
            mtmd_helper_bitmap_wrapper w = mtmd_helper_bitmap_init_from_buf(e->vision, img.data, img.size, false,
                                                                            mtmd_helper_init_opt_default());
            if (w.video_ctx) mtmd_helper_video_free(w.video_ctx);
            if (!w.bitmap || w.video_ctx || mtmd_bitmap_is_audio(w.bitmap)) {
                if (w.bitmap) mtmd_bitmap_free(w.bitmap);
                set_error(error, "Couldn't read one of the images. Try a JPEG or PNG picture.");
                return nullptr;
            }
            bitmaps.all.push_back(w.bitmap);
            message_images[size_t(i)].push_back(w.bitmap);
            prefix += marker + "\n";
            const char * id = mtmd_bitmap_get_id(w.bitmap);
            key += std::string("\x01") + (id ? id : "");
        }
        roles.emplace_back(c_roles[i] ? c_roles[i] : "user");
        contents.push_back(prefix + text);
        keys.push_back(key);
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
    const int32_t fits = n_ctx - reserve;
    const size_t first = (!roles.empty() && roles[0] == "system") ? 1 : 0;
    // The prompt: its tokens (an image's as its image_token), the position of
    // each, the position after the last, and the pieces mtmd made of it.
    std::vector<llama_token> tokens;
    std::vector<llama_pos> pos;
    llama_pos end_pos = 0;
    std::unique_ptr<mtmd_input_chunks, void (*)(mtmd_input_chunks *)> chunks(nullptr, mtmd_input_chunks_free);
    std::vector<std::pair<size_t, const mtmd_input_chunk *>> image_chunks;  // (first token, piece)
    bool images_failed = false;
    // The prompt for the chat from message `from` on (plus the system prompt).
    auto build = [&](size_t from) {
        std::vector<std::string> r, c;
        std::vector<const mtmd_bitmap *> bm;
        auto add = [&](size_t i) {
            r.push_back(roles[i]);
            c.push_back(contents[i]);
            bm.insert(bm.end(), message_images[i].begin(), message_images[i].end());
        };
        if (first) add(0);
        for (size_t i = from; i < roles.size(); i++) add(i);
        const std::string prompt = apply_template(*e, r, c);
        if (prompt.empty()) return false;
        tokens.clear();
        pos.clear();
        image_chunks.clear();
        chunks.reset();
        if (bm.empty()) {
            tokens = tokenize(prompt);
            for (size_t i = 0; i < tokens.size(); i++) pos.push_back(llama_pos(i));
            end_pos = llama_pos(tokens.size());
            return true;
        }
        chunks.reset(mtmd_input_chunks_init());
        const mtmd_input_text input{prompt.c_str(), prompt.size(), true, true};
        if (mtmd_tokenize(e->vision, chunks.get(), &input, bm.data(), bm.size()) != 0) {
            images_failed = true;
            return false;
        }
        llama_pos p = 0;
        for (size_t k = 0; k < mtmd_input_chunks_size(chunks.get()); k++) {
            const mtmd_input_chunk * chunk = mtmd_input_chunks_get(chunks.get(), k);
            if (mtmd_input_chunk_get_type(chunk) == MTMD_INPUT_CHUNK_TYPE_TEXT) {
                size_t n = 0;
                const llama_token * t = mtmd_input_chunk_get_tokens_text(chunk, &n);
                for (size_t j = 0; j < n; j++) {
                    tokens.push_back(t[j]);
                    pos.push_back(p++);
                }
            } else {
                image_chunks.emplace_back(tokens.size(), chunk);
                const llama_token id = image_token(mtmd_input_chunk_get_id(chunk));
                tokens.insert(tokens.end(), mtmd_input_chunk_get_n_tokens(chunk), id);
                pos.insert(pos.end(), mtmd_input_chunk_get_n_tokens(chunk), p);
                p += mtmd_input_chunk_get_n_pos(chunk);
            }
        }
        end_pos = p;
        return true;
    };
    // The next user message after `from` (roles.size() if there's none).
    auto next_user = [&](size_t from) {
        size_t next = from + 1;
        while (next < roles.size() && roles[next] != "user") next++;
        return next;
    };
    auto format_failed = [&]() {
        set_error(error, images_failed ? "Couldn't prepare the images for this model."
                                       : "Couldn't format the conversation for this model.");
        return nullptr;
    };

    size_t from = first;
    if (!build(from) || tokens.empty()) return format_failed();
    if (int32_t(tokens.size()) > fits) {
        // Start where the kept part started last time, while that still fits:
        // cutting one more message each turn would change the start of the
        // prompt, and the whole chat would have to be read again every time.
        bool done = false;
        if (!background && !e->start_content.empty()) {
            for (size_t i = first + 1; i < roles.size(); i++) {
                if (roles[i] != e->start_role || keys[i] != e->start_content) continue;
                from = i;
                if (!build(from)) return format_failed();
                done = int32_t(tokens.size()) <= fits;
                break;
            }
        }
        // Otherwise drop the oldest messages, with room to spare, so the next
        // few messages fit without moving the start again.
        const int32_t target = background ? fits : fits - n_ctx / 4;
        while (!done) {
            const size_t next = next_user(from);
            if (next >= roles.size()) break;  // only the last question is left
            from = next;
            if (!build(from)) return format_failed();
            done = int32_t(tokens.size()) <= target;
        }
    }
    if (int32_t(tokens.size()) + 8 >= n_ctx) {
        set_error(error, "This message is longer than the model's memory. Shorten it, or raise the context size in Settings.");
        return nullptr;
    }
    if (!background) {
        e->start_role = from > first ? roles[from] : "";
        e->start_content = from > first ? keys[from] : "";
    }

    llama_memory_t mem = llama_get_memory(e->ctx);
    size_t keep = 0;
    llama_seq_id seq = 0;
    if (background) {
        // Runs next to the chat. If there isn't room for both, the chat makes
        // way (it's read again with the next message).
        seq = 1;
        llama_memory_seq_rm(mem, 1, -1, -1);
        if (e->cached.size() + tokens.size() + size_t(std::max(max_tokens, 0)) + 1 > size_t(n_ctx)) {
            llama_memory_seq_rm(mem, 0, -1, -1);
            e->cached.clear();
            e->cached_pos.clear();
        }
    } else {
        // Reuse the part of the conversation that's already in the KV cache.
        while (keep < e->cached.size() && keep < tokens.size() && e->cached[keep] == tokens[keep]) keep++;
        if (keep == tokens.size() && keep > 0) keep--;  // must decode at least one token to get logits
        // An image is read as a whole, so none of it is kept if it has to be read again.
        while (keep > 0 && tokens[keep] < 0 && tokens[keep - 1] == tokens[keep]) keep--;
        if (!llama_memory_seq_rm(mem, 0, pos[keep], -1)) {
            llama_memory_clear(mem, true);
            keep = 0;
        }
        e->cached.assign(tokens.begin(), tokens.begin() + keep);
        e->cached_pos.assign(pos.begin(), pos.begin() + keep);
    }
    // A background job always leaves the cache as it found it.
    struct Cleanup {
        llama_memory_t mem;
        bool on;
        ~Cleanup() { if (on) llama_memory_seq_rm(mem, 1, -1, -1); }
    } cleanup{mem, background != 0};
    // Tokens in this job's sequence; the other sequence's are in e->cached.
    size_t n_pos = keep;
    auto used = [&]() { return background ? e->cached.size() + n_pos : n_pos; };

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
    auto failed = [&](const char * msg) {
        if (background) {
            llama_memory_seq_rm(mem, 1, -1, -1);
        } else {
            llama_memory_clear(mem, true);
            e->cached.clear();
            e->cached_pos.clear();
        }
        set_error(error, msg);
        return nullptr;
    };

    // Process the prompt in batches; an empty on_token("") call lets the user cancel.
    const double t_prompt = now_ms();
    const size_t n_new_prompt = tokens.size() - keep;
    const int32_t n_batch = int32_t(llama_n_batch(e->ctx));
    for (size_t i = keep; i < tokens.size();) {
        size_t n = 0;
        if (tokens[i] >= 0) {
            // Text, up to the next image, in batches.
            while (n < size_t(n_batch) && i + n < tokens.size() && tokens[i + n] >= 0) n++;
            if (decode(e->ctx, tokens.data() + i, int32_t(n), pos[i], seq) != 0) return failed("The model failed while reading the chat.");
        } else {
            // An image: mtmd encodes it and puts it in the KV cache.
            const mtmd_input_chunk * chunk = nullptr;
            for (auto & ic : image_chunks) if (ic.first == i) chunk = ic.second;
            if (!chunk) return failed("The model failed while reading the images.");
            n = mtmd_input_chunk_get_n_tokens(chunk);
            llama_pos after = 0;
            if (mtmd_helper_eval_chunk_single(e->vision, e->ctx, chunk, pos[i], seq, n_batch, false, &after) != 0) {
                return failed("The model failed while looking at the images. Try a smaller picture, or free up memory.");
            }
        }
        n_pos += n;
        if (!background) {
            e->cached.insert(e->cached.end(), tokens.begin() + i, tokens.begin() + i + n);
            e->cached_pos.insert(e->cached_pos.end(), pos.begin() + i, pos.begin() + i + n);
        }
        i += n;
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
    llama_pos next_pos = end_pos;
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

        if (++generated >= max_tokens || int32_t(used()) + 1 >= n_ctx) {
            stop_reason = "max_tokens";
            break;
        }
        if (decode(e->ctx, &tok, 1, next_pos, seq) != 0) {
            stop_reason = "max_tokens";
            break;
        }
        n_pos++;
        if (!background) {
            e->cached.push_back(tok);
            e->cached_pos.push_back(next_pos);
        }
        next_pos++;
    }
    const double gen_ms = now_ms() - t_gen;
    if (!pending.empty() && stop_reason != "aborted") emit(pending);
    llama_sampler_free(smpl);
    return result(stop_reason, n_new_prompt, prompt_ms, generated, gen_ms);
}

}  // extern "C"
