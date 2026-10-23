// Headless doomgeneric platform: no window, no audio device.
//
// Frames and sound events go out on fd 3 (stdout carries Doom's own log output) as records, see headless.h.
// Built with -DCMAP256 -DDOOMGENERIC_RESX=320 -DDOOMGENERIC_RESY=200 so DG_ScreenBuffer holds raw indices.
//
// Key events arrive on stdin as 2-byte records: [pressed (0/1), doom key code (doomkeys.h)].
// EOF on stdin means the parent server is gone, so we exit.

#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

#include "doomgeneric.h"
#include "headless.h"
#include "i_video.h"
#include "m_controls.h"

#define FRAME_FD 3
#define PALETTE_BYTES (256 * 3)
#define PIXEL_BYTES (DOOMGENERIC_RESX * DOOMGENERIC_RESY)

static uint8_t frame[PALETTE_BYTES + PIXEL_BYTES];
static uint8_t keybuf[256];
static size_t keylen = 0;
static struct timespec start;

static void write_all(int fd, const void *data, size_t len)
{
    const uint8_t *buf = data;
    while (len > 0)
    {
        ssize_t n = write(fd, buf, len);
        if (n < 0)
        {
            if (errno == EINTR) continue;
            exit(0); // server closed the frame pipe
        }
        buf += n;
        len -= (size_t)n;
    }
}

void headless_emit(uint8_t type, const void *payload, uint32_t len)
{
    uint8_t header[5] = { type, len & 0xff, (len >> 8) & 0xff, (len >> 16) & 0xff, (len >> 24) & 0xff };
    write_all(FRAME_FD, header, sizeof(header));
    write_all(FRAME_FD, payload, len);
}

void DG_Init()
{
    clock_gettime(CLOCK_MONOTONIC, &start);
    fcntl(STDIN_FILENO, F_SETFL, fcntl(STDIN_FILENO, F_GETFL) | O_NONBLOCK);
}

void DG_DrawFrame()
{
    for (int i = 0; i < 256; i++)
    {
        frame[i * 3 + 0] = colors[i].r;
        frame[i * 3 + 1] = colors[i].g;
        frame[i * 3 + 2] = colors[i].b;
    }
    memcpy(frame + PALETTE_BYTES, DG_ScreenBuffer, PIXEL_BYTES);
    headless_emit(HEADLESS_REC_FRAME, frame, sizeof(frame));
}

void DG_SleepMs(uint32_t ms)
{
    usleep(ms * 1000);
}

uint32_t DG_GetTicksMs()
{
    struct timespec now;
    clock_gettime(CLOCK_MONOTONIC, &now);
    return (uint32_t)((now.tv_sec - start.tv_sec) * 1000 + (now.tv_nsec - start.tv_nsec) / 1000000);
}

int DG_GetKey(int *pressed, unsigned char *key)
{
    if (keylen < 2)
    {
        ssize_t n = read(STDIN_FILENO, keybuf + keylen, sizeof(keybuf) - keylen);
        if (n == 0) exit(0);
        if (n > 0) keylen += (size_t)n;
    }
    if (keylen < 2) return 0;

    *pressed = keybuf[0];
    *key = keybuf[1];
    keylen -= 2;
    memmove(keybuf, keybuf + 2, keylen);
    return 1;
}

void DG_SetWindowTitle(const char *title)
{
    (void)title;
}

int main(int argc, char **argv)
{
    // stdout is a pipe to the server; line-buffer it so Doom's log shows up in container logs promptly.
    setvbuf(stdout, NULL, _IOLBF, 0);
    doomgeneric_Create(argc, argv);

    // Game key bindings, applied after doomgeneric_Create() has loaded the config file so they always win.
    // Only in-game actions change: menus keep arrows/Enter/Esc, and cheats/save names still get raw letters.
    // WASD = forward/back/turn, K = fire, L = use/open (K/L have no other default binding in menus or the automap).
    key_up = 'w';
    key_down = 's';
    key_left = 'a';
    key_right = 'd';
    key_fire = 'k';
    key_use = 'l';

    for (;;)
    {
        doomgeneric_Tick();
    }
    return 0;
}
