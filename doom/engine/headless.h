// Record stream from the headless engine to the server, on fd 3.
// Each record: [type u8][payload length u32 little-endian][payload].

#ifndef HEADLESS_H
#define HEADLESS_H

#include <stdint.h>

// Payload: 768 bytes palette (R,G,B x 256) + 320*200 bytes of palette indices.
#define HEADLESS_REC_FRAME 1

// Payload: struct headless_sound_event (12 bytes).
#define HEADLESS_REC_SOUND 2

#define HEADLESS_SOUND_START 1
#define HEADLESS_SOUND_UPDATE 2
#define HEADLESS_SOUND_STOP 3

struct headless_sound_event
{
    uint8_t op;      // HEADLESS_SOUND_*
    uint8_t channel; // engine sound channel (0..snd_channels-1)
    uint8_t vol;     // 0..127
    uint8_t sep;     // stereo separation: 0 = full left, 128 = center, 254 = full right
    char lump[8];    // sound lump name, e.g. "DSPISTOL" (NUL-padded, not necessarily terminated)
};

// Payload: struct headless_music_event (12 bytes).
#define HEADLESS_REC_MUSIC 3

#define HEADLESS_MUSIC_PLAY 1
#define HEADLESS_MUSIC_STOP 2
#define HEADLESS_MUSIC_PAUSE 3
#define HEADLESS_MUSIC_RESUME 4
#define HEADLESS_MUSIC_VOLUME 5

struct headless_music_event
{
    uint8_t op;      // HEADLESS_MUSIC_*
    uint8_t looping; // PLAY: 1 = loop
    uint8_t volume;  // 0..127, current music volume (sent with every event)
    uint8_t pad;
    char lump[8];    // PLAY: music lump name, e.g. "D_E1M1" (NUL-padded, not necessarily terminated)
};

void headless_emit(uint8_t type, const void *payload, uint32_t len);

#endif
