// Headless sound: instead of mixing audio, report sound effect and music events to the server, which forwards
// them to the browser. The browser has the samples (sent once by the server) and plays them with Web Audio;
// music tracks are pre-rendered to MP3 at image build time and fetched by lump name.

#include <string.h>

#include "doomgeneric.h"
#include "headless.h"
#include "i_sound.h"
#include "w_wad.h"
#include "z_zone.h"

#define NUM_CHANNELS 16

// Normally defined by the SDL sound/music modules; referenced by i_sound.c / m_config.c under FEATURE_SOUND.
int use_libsamplerate = 0;
float libsamplerate_scale = 0.65f;

void I_InitTimidityConfig(void)
{
}

static boolean use_prefix;

// Per channel: when the current sound ends (DG_GetTicksMs), 0 if idle; last params sent, to skip no-op updates.
static uint32_t channel_end[NUM_CHANNELS];
static uint8_t channel_vol[NUM_CHANNELS];
static uint8_t channel_sep[NUM_CHANNELS];

static void emit(uint8_t op, int channel, int vol, int sep, int lumpnum)
{
    struct headless_sound_event ev = {
        .op = op,
        .channel = (uint8_t)channel,
        .vol = (uint8_t)(vol < 0 ? 0 : vol > 127 ? 127 : vol),
        .sep = (uint8_t)(sep < 0 ? 0 : sep > 254 ? 254 : sep),
    };
    if (lumpnum >= 0) memcpy(ev.lump, lumpinfo[lumpnum].name, sizeof(ev.lump));
    headless_emit(HEADLESS_REC_SOUND, &ev, sizeof(ev));
}

// Sample duration in ms, from the DMX lump header (format 3, rate u16, length u32 incl. 32 padding bytes).
// Cached in sfxinfo->driver_data as ms + 1 so that 0 means "not computed yet".
static uint32_t sound_duration_ms(sfxinfo_t *sfx)
{
    if (sfx->driver_data == NULL)
    {
        uint32_t ms = 0;
        int lumplen = W_LumpLength(sfx->lumpnum);
        const uint8_t *data = W_CacheLumpNum(sfx->lumpnum, PU_STATIC);
        if (lumplen >= 8 && data[0] == 3 && data[1] == 0)
        {
            uint32_t rate = data[2] | (data[3] << 8);
            uint32_t length = data[4] | (data[5] << 8) | (data[6] << 16) | ((uint32_t)data[7] << 24);
            if (rate > 0 && length > 32) ms = (uint32_t)((uint64_t)(length - 32) * 1000 / rate);
        }
        W_ReleaseLumpNum(sfx->lumpnum);
        sfx->driver_data = (void *)(uintptr_t)(ms + 1);
    }
    return (uint32_t)(uintptr_t)sfx->driver_data - 1;
}

static boolean Snd_Init(boolean use_sfx_prefix)
{
    use_prefix = use_sfx_prefix;
    memset(channel_end, 0, sizeof(channel_end));
    return true;
}

static void Snd_Shutdown(void)
{
}

// Same lookup as the SDL module: linked sounds use the lump of the sound they link to.
static int Snd_GetSfxLumpNum(sfxinfo_t *sfx)
{
    char name[9];
    if (sfx->link != NULL) sfx = sfx->link;
    if (use_prefix)
    {
        name[0] = 'd';
        name[1] = 's';
        strncpy(name + 2, sfx->name, 6);
        name[8] = '\0';
    }
    else
    {
        strncpy(name, sfx->name, 8);
        name[8] = '\0';
    }
    return W_GetNumForName(name);
}

static void Snd_Update(void)
{
}

static void Snd_UpdateSoundParams(int channel, int vol, int sep)
{
    if (channel < 0 || channel >= NUM_CHANNELS || channel_end[channel] == 0) return;
    if (channel_vol[channel] == vol && channel_sep[channel] == sep) return;
    channel_vol[channel] = (uint8_t)vol;
    channel_sep[channel] = (uint8_t)sep;
    emit(HEADLESS_SOUND_UPDATE, channel, vol, sep, -1);
}

static int Snd_StartSound(sfxinfo_t *sfx, int channel, int vol, int sep)
{
    if (channel < 0 || channel >= NUM_CHANNELS || sfx->lumpnum < 0) return -1;
    channel_end[channel] = DG_GetTicksMs() + sound_duration_ms(sfx) + 1;
    channel_vol[channel] = (uint8_t)vol;
    channel_sep[channel] = (uint8_t)sep;
    emit(HEADLESS_SOUND_START, channel, vol, sep, sfx->lumpnum);
    return channel;
}

static void Snd_StopSound(int channel)
{
    if (channel < 0 || channel >= NUM_CHANNELS || channel_end[channel] == 0) return;
    channel_end[channel] = 0;
    emit(HEADLESS_SOUND_STOP, channel, 0, 0, -1);
}

static boolean Snd_SoundIsPlaying(int channel)
{
    if (channel < 0 || channel >= NUM_CHANNELS || channel_end[channel] == 0) return false;
    if (DG_GetTicksMs() < channel_end[channel]) return true;
    channel_end[channel] = 0;
    return false;
}

static void Snd_CacheSounds(sfxinfo_t *sounds, int num_sounds)
{
    (void)sounds;
    (void)num_sounds;
}

static snddevice_t sound_devices[] = {
    SNDDEVICE_SB, SNDDEVICE_PAS, SNDDEVICE_GUS, SNDDEVICE_WAVEBLASTER, SNDDEVICE_SOUNDCANVAS, SNDDEVICE_AWE32,
};

sound_module_t DG_sound_module = {
    sound_devices,
    sizeof(sound_devices) / sizeof(*sound_devices),
    Snd_Init,
    Snd_Shutdown,
    Snd_GetSfxLumpNum,
    Snd_Update,
    Snd_UpdateSoundParams,
    Snd_StartSound,
    Snd_StopSound,
    Snd_SoundIsPlaying,
    Snd_CacheSounds,
};

// ---- Music: report which track plays; the browser plays the pre-rendered MP3 ----

static int music_volume = 127;
static boolean music_playing = false;

static void emit_music(uint8_t op, int lumpnum, boolean looping)
{
    struct headless_music_event ev = {
        .op = op,
        .looping = looping ? 1 : 0,
        .volume = (uint8_t)music_volume,
    };
    if (lumpnum >= 0) memcpy(ev.lump, lumpinfo[lumpnum].name, sizeof(ev.lump));
    headless_emit(HEADLESS_REC_MUSIC, &ev, sizeof(ev));
}

static boolean Mus_Init(void) { return true; }

static void Mus_Shutdown(void) {}

static void Mus_SetMusicVolume(int volume)
{
    music_volume = volume < 0 ? 0 : volume > 127 ? 127 : volume;
    emit_music(HEADLESS_MUSIC_VOLUME, -1, false);
}

static void Mus_PauseMusic(void) { emit_music(HEADLESS_MUSIC_PAUSE, -1, false); }

static void Mus_ResumeMusic(void) { emit_music(HEADLESS_MUSIC_RESUME, -1, false); }

// S_ChangeMusic passes W_CacheLumpNum(lump) as data, so the lump is the one whose cache is that pointer.
// Handle = lump number + 1 (NULL would mean failure).
static void *Mus_RegisterSong(void *data, int len)
{
    (void)len;
    for (unsigned int i = 0; i < numlumps; i++)
    {
        if (lumpinfo[i].cache == data) return (void *)(uintptr_t)(i + 1);
    }
    return NULL;
}

static void Mus_UnRegisterSong(void *handle) { (void)handle; }

static void Mus_PlaySong(void *handle, boolean looping)
{
    if (handle == NULL) return;
    music_playing = true;
    emit_music(HEADLESS_MUSIC_PLAY, (int)((uintptr_t)handle - 1), looping);
}

static void Mus_StopSong(void)
{
    music_playing = false;
    emit_music(HEADLESS_MUSIC_STOP, -1, false);
}

static boolean Mus_MusicIsPlaying(void) { return music_playing; }

static void Mus_Poll(void) {}

static snddevice_t music_devices[] = { SNDDEVICE_SB, SNDDEVICE_GENMIDI };

music_module_t DG_music_module = {
    music_devices,
    sizeof(music_devices) / sizeof(*music_devices),
    Mus_Init,
    Mus_Shutdown,
    Mus_SetMusicVolume,
    Mus_PauseMusic,
    Mus_ResumeMusic,
    Mus_RegisterSong,
    Mus_UnRegisterSong,
    Mus_PlaySong,
    Mus_StopSong,
    Mus_MusicIsPlaying,
    Mus_Poll,
};
