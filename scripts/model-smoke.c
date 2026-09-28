// Balimda — © 2026 Bandar Altariqi. All rights reserved.
// Licensed under the Balimda License (see LICENSE): non-commercial use only;
// keep the Balimda name and the "Balimda by Bandar Altariqi" credit; no rebranding.

// Loads a model with the phone engine (native/llama/engine) and asks it one
// question, to check the model works with it. Used by model-links.yml.
//   model-smoke <model.gguf>

#include <stdio.h>
#include <string.h>
#include "balimda_engine.h"

static bool print_piece(void * user, const char * text) {
    (void) user;
    fputs(text, stdout);
    fflush(stdout);
    return true;
}

int main(int argc, char ** argv) {
    if (argc < 2) return 2;
    char * err = NULL;
    be_engine * e = be_load(argv[1], 2048, 0, 4, &err);
    if (!e) {
        printf("::error::couldn't load %s: %s\n", argv[1], err ? err : "?");
        return 1;
    }
    const char * roles[] = {"system", "user"};
    const char * contents[] = {"You are a helpful assistant. Be brief.", "What is the capital of France?"};
    printf("reply: ");
    char * r = be_complete(e, roles, contents, 2, 256, 0.0f, 0, print_piece, NULL, &err);
    printf("\n");
    if (!r) {
        printf("::error::%s failed to reply: %s\n", argv[1], err ? err : "?");
        return 1;
    }
    printf("stats: %s\n", r);
    int generated = 0;
    sscanf(r, "%*s %*s %*s %d", &generated);
    be_string_free(r);
    be_free(e);
    if (generated <= 0) {
        printf("::error::%s gave an empty reply\n", argv[1]);
        return 1;
    }
    return 0;
}
