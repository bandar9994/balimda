// Balimda — © 2026 Bandar Altariqi. All rights reserved.
// Licensed under the Balimda License (see LICENSE): non-commercial use only;
// keep the Balimda name and the "Balimda by Bandar Altariqi" credit; no rebranding.

// Balimda's on-device engine: llama.cpp with the chat handling Balimda needs
// (the model's own chat template, keeping as much of the chat as fits, and
// reusing the KV cache between turns). A plain C interface, so the Android
// app (through JNI, balimda_llama.cpp) and the iOS app (from Swift) share it.

#ifndef BALIMDA_ENGINE_H
#define BALIMDA_ENGINE_H

#include <stdbool.h>
#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct be_engine be_engine;

// Receives each piece of the reply as UTF-8 text; "" is sent while the chat
// is being read so a cancel is noticed quickly. Return false to stop.
typedef bool (*be_token_fn)(void * user, const char * text);

// The compute devices, one per line: "<cpu|gpu|other>\t<name>\t<description>".
// Free with be_string_free.
char * be_devices(void);

// Loads a GGUF model. On failure returns NULL and sets *error (free with
// be_string_free) to a message for the user.
be_engine * be_load(const char * path, int n_ctx, int n_gpu_layers, int n_threads, char ** error);

// Where the loaded model runs, e.g. "offloaded 29/29 layers to GPU" ("" = CPU only).
const char * be_offload(const be_engine * engine);

// Loads a vision model's image part (its "mmproj" GGUF, made for this model),
// so messages can hold images. Returns false and sets *error on failure.
bool be_load_vision(be_engine * engine, const char * mmproj_path, bool use_gpu, int n_threads, char ** error);

// Whether the loaded model can see images (be_load_vision succeeded).
bool be_has_vision(const be_engine * engine);

// An image file (JPEG, PNG, ...) in memory.
typedef struct be_image {
    const unsigned char * data;
    size_t size;
} be_image;

// Writes a reply to the chat (roles "system", "user", "assistant"). Message i
// comes with image_counts[i] images (image_counts may be NULL: no images),
// taken in order from `images`; they go before the message's text. Images
// are left out when the model can't see (no be_load_vision). Returns
// "<reason>\t<prompt tokens>\t<prompt ms>\t<generated tokens>\t<generation ms>
// \t<chat tokens>\t<messages sent>\t<context size>" where reason is "end_turn",
// "max_tokens" or "aborted" (free with be_string_free); on failure NULL and *error.
// A background job (background != 0, e.g. updating memory) runs beside the
// chat in the KV cache instead of replacing it.
char * be_complete(be_engine * engine, const char * const * roles, const char * const * contents, int n_messages,
                   const int * image_counts, const be_image * images, int max_tokens, float temperature, int background,
                   be_token_fn on_token, void * user, char ** error);

void be_free(be_engine * engine);

void be_string_free(char * s);

#ifdef __cplusplus
}
#endif

#endif  // BALIMDA_ENGINE_H
