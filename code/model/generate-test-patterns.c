#include <stdio.h>

// This generates various test patterns for sectors, which can be used
// to exercise the encoder and decoder.

int main() {
    FILE* f = fopen("test1.raw", "wb");
    for (unsigned i = 0; i < 30; i++) {
        for (unsigned j = 0; j < 98; j++) {
            for (unsigned k = 0; k < 24; k++) {
                unsigned char c = k;
                fwrite(&c, 1, 1, f);
            }
        }
    }
    fclose(f);
    f = fopen("test2.raw", "wb");
    for (unsigned i = 0; i < 30; i++) {
        for (unsigned j = 0; j < 98; j++) {
            for (unsigned k = 0; k < 24; k++) {
                unsigned char c = j;
                fwrite(&c, 1, 1, f);
            }
        }
    }
    fclose(f);
    f = fopen("test3.raw", "wb");
    for (unsigned i = 0; i < 30; i++) {
        for (unsigned j = 0; j < 98; j++) {
            for (unsigned k = 0; k < 24; k++) {
                unsigned char c = i;
                fwrite(&c, 1, 1, f);
            }
        }
    }
    fclose(f);
    f = fopen("test4.raw", "wb");
    for (unsigned i = 0; i < 30; i++) {
        for (unsigned j = 0; j < 2352; j++) {
            unsigned char c = j;
            fwrite(&c, 1, 1, f);
        }
    }
    fclose(f);
    return 0;
}