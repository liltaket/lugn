# audio_bands

ESPHome sensor platform that turns a microphone stream into one row of
spectral features per interval: octave band levels, an A-weighted equivalent
level (LAeq) and spectral flatness. Input for the adaptive music-volume data
set.

```yaml
external_components:
  - source: { type: local, path: components }
    components: [audio_bands]

sensor:
  - platform: audio_bands
    microphone: door_mic # microphone_source schema, 16-bit mono
    passive: false # true: only listen while another consumer runs the mic
    measurement_duration: 1s # 100 ms .. 60 s
    laeq: { name: Ljudnivå A-vägd }
    bands: # any subset of 63, 125, 250, 500, 1000, 2000, 4000, 8000
      - { center: 63, name: 'Band 63 Hz' }
      - { center: 1000, name: 'Band 1000 Hz' }
    spectral_flatness: { name: Spektral platthet }
```

Actions `audio_bands.start` / `audio_bands.stop` start and stop the
microphone source (not in passive mode).

## What the values mean

All levels are dB relative to digital full scale, on the same scale as
`sound_level`'s RMS sensor: a full-scale sine reads -3.01 dBFS.

- **Bands**: energy in the octave band, averaged over the interval, in dBFS.
  Bands follow IEC 61260-1 base-10 octaves (exact midbands 63.1, 125.9, ...,
  7943 Hz, edges at midband x 10^(+-0.15)). The bands are contiguous from
  44.7 Hz upward. At 16 kHz the **8000 Hz band is partial**: it covers
  5623-8000 Hz (Nyquist) instead of 5623-11220 Hz, and the microphone's own
  decimation filter rolls off near Nyquist, so it reads low compared with a
  full octave.
- **laeq**: A-weighted (IEC 61672-1 formula, applied per FFT bin) mean square
  over the interval, in dBFS(A). For a 1 kHz tone it equals the band level;
  for white noise over 0-8 kHz it reads about 0.2 dB above the unweighted
  RMS.
- **spectral_flatness**: geometric over arithmetic mean of the interval's
  average power spectrum over 89 Hz - 5.6 kHz (the 125-4000 Hz bands), 0..1.
  A pure tone reads ~0, white noise ~0.98; music and speech fall between,
  mostly through their spectral tilt and harmonics. It is computed on the
  averaged spectrum on purpose: the flatness of a single periodogram frame
  of white noise is biased to ~0.56 (e^-gamma) by estimator noise.
- **Silence** never produces NaN or -inf: levels are clamped to -120 dB, and
  digital silence reads flatness 1.0 (a flat, empty spectrum).

## Signal path

- 1024-point frames (15.6 Hz bins at 16 kHz), periodic Hann window, 50 %
  overlap (Welch). The real FFT runs as a 512-point complex radix-2 FFT plus
  a split step, self-contained in `band_analyzer.cpp`, so the target and the
  host test run identical code.
- 1024 rather than 512 points because of the 63 Hz band: with 31.25 Hz bins
  the band (44.7-89.1 Hz) holds a single bin and a tone loses ~1.8 dB to
  Hann leakage into neighbouring bands; with 15.6 Hz bins it holds three
  (46.9, 62.5, 78.1 Hz) and a tone reads within 0.01 dB. The cost per sample
  only grows by log2(1024)/log2(512) = 1.11.
- 50 % overlap so samples near frame edges are not discarded by the window
  (transients between frames would otherwise be missed). With Hann, the
  per-sample energy weight then ripples between 0.67 and 1.33; stationary
  levels are exact, a single click can read between -1.8 and +1.2 dB off.
- Each frame's one-sided power spectrum is scaled by 1/(N * sum w^2)
  (doubled for interior bins), so the bins sum to the frame's mean square
  (Parseval). Interval values are means over the frames that end in the
  interval (30-32 frames per second).
- Known limit: per-bin A-weighting at 63 Hz reads a tone ~0.4 dB high,
  because the Hann main lobe spans 47-78 Hz where A-weighting changes by
  7 dB. From 125 Hz up the error is below 0.1 dB.

## Runtime behaviour

- The microphone callback only copies captures into a 500 ms ring buffer in
  PSRAM with `write_without_replacement(..., 0)`: it never waits. A capture
  that does not fit is dropped and counted.
- `loop()` reads at most 512 samples per FFT frame and runs at most 2 frames
  per call (4 when the buffer is more than half full).
- All sensors of an interval are published in the same `loop()` call, laeq
  last, so a consumer can treat laeq as the end of the row.
- An interval with dropped samples is not published: the component logs a
  warning with the running count of skipped intervals and starts a new
  interval. Nothing is published while the microphone is stopped.
- At log level DEBUG each interval logs its frame count and the CPU time
  spent in `loop()`.

## Host test

The DSP core (`band_analyzer.h/.cpp`) has no ESPHome dependencies. Run from
`components/audio_bands/test/`:

```sh
g++ -std=c++20 -O2 -Wall -Wextra -I.. test_band_analyzer.cpp ../band_analyzer.cpp -o /tmp/test_band_analyzer && /tmp/test_band_analyzer
```

It checks the FFT against a direct DFT, Parseval scaling, A-weighting against
the IEC 61672-1 table, tones at every band midband, a 1 kHz tone at
-20 dBFS, white noise (LAeq, band sum, flatness), digital silence, chunking
independence and reset.
