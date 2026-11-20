#pragma once

// Spectral band analysis for the audio_bands component. Plain C++ without
// ESPHome or ESP-IDF dependencies, so the same code runs in the host unit
// test (test/test_band_analyzer.cpp) and on the node.
//
// Signal path per frame: 1024 samples, periodic Hann window, 50 % overlap
// (hop 512), real FFT computed as a 512-point complex radix-2 FFT, one-sided
// power spectrum scaled so that the bins of a frame sum to the frame's mean
// square in full-scale units (a full-scale sine reads -3.01 dBFS, like
// sound_level's RMS). Frame powers are averaged over the interval.

#include <cstddef>
#include <cstdint>
#include <vector>

namespace esphome::audio_bands {

class BandAnalyzer {
 public:
  static constexpr size_t FFT_SIZE = 1024;
  static constexpr size_t HOP = FFT_SIZE / 2;
  static constexpr size_t NUM_BINS = FFT_SIZE / 2 + 1;
  static constexpr size_t MAX_BANDS = 8;
  /// Lowest level ever reported, in dB. Silence reads this instead of -inf.
  static constexpr float FLOOR_DB = -120.0f;
  /// Spectral flatness (geometric / arithmetic mean of the interval's average
  /// power spectrum) uses the bins of the 125..4000 Hz octave bands.
  static constexpr float FLATNESS_LOW_HZ = 88.39f;
  static constexpr float FLATNESS_HIGH_HZ = 5623.4f;

  struct Result {
    float laeq_db;
    float band_db[MAX_BANDS];
    float flatness;
    uint32_t frames;
  };

  /// Builds the window, FFT tables, A-weighting table and bin-to-band map.
  /// band_centers_hz are nominal octave centres (63, 125, ..., 8000). Returns
  /// false for an unusable configuration. Resets all state.
  bool configure(uint32_t sample_rate, uint32_t interval_samples, const uint16_t *band_centers_hz,
                 size_t num_bands);

  /// Drops the frame history and the interval in progress (after a gap in
  /// the stream). A pending result is discarded too.
  void reset();

  /// Feeds up to n samples and returns how many were consumed. Stops right
  /// after the sample that completes an interval; then result_ready() is true
  /// and feed() consumes nothing until clear_result(). Work per call is one
  /// FFT per HOP samples fed, so callers bound CPU time by bounding n.
  size_t feed(const int16_t *samples, size_t n);

  bool result_ready() const { return this->result_ready_; }
  const Result &result() const { return this->result_; }
  void clear_result() { this->result_ready_ = false; }

  // Band layout, valid after configure().
  size_t num_bands() const { return this->num_bands_; }
  /// Lower and upper band edges actually covered (the upper one is clipped
  /// to Nyquist), and the number of FFT bins in the band.
  float band_low_hz(size_t band) const { return this->band_low_hz_[band]; }
  float band_high_hz(size_t band) const { return this->band_high_hz_[band]; }
  size_t band_bins(size_t band) const { return this->band_bins_[band]; }
  float bin_hz() const { return static_cast<float>(this->sample_rate_) / FFT_SIZE; }

  /// One-sided power spectrum (NUM_BINS values, full-scale units, summing to
  /// the windowed frame's mean square) of FFT_SIZE samples. Exposed for tests.
  void frame_power(const int16_t *frame, float *power_out);

  /// IEC 61672-1 A-weighting gain in dB at frequency f.
  static double a_weighting_db(double f);

  /// 10*log10(p) clamped to FLOOR_DB; never NaN or -inf.
  static float power_to_db(double p);

 protected:
  void process_frame_();
  void finish_interval_();
  float flatness_() const;
  void fft_();

  uint32_t sample_rate_{0};
  uint32_t interval_samples_{0};
  size_t num_bands_{0};

  // Tables
  std::vector<float> window_;     // FFT_SIZE, periodic Hann
  std::vector<float> cos_;        // FFT_SIZE / 2: cos(2*pi*k/N)
  std::vector<float> sin_;        // FFT_SIZE / 2: sin(2*pi*k/N)
  std::vector<uint16_t> bitrev_;  // FFT_SIZE / 2
  std::vector<float> a_weight_;    // NUM_BINS, power gain
  std::vector<uint8_t> bin_band_;  // NUM_BINS, band index or NO_BAND
  size_t flat_lo_bin_{0};
  size_t flat_hi_bin_{0};  // inclusive
  float band_low_hz_[MAX_BANDS]{};
  float band_high_hz_[MAX_BANDS]{};
  size_t band_bins_[MAX_BANDS]{};

  // Working buffers
  std::vector<int16_t> history_;  // FFT_SIZE samples, oldest first
  size_t history_fill_{0};
  std::vector<float> re_;  // FFT_SIZE / 2 complex values
  std::vector<float> im_;
  std::vector<float> power_;  // NUM_BINS

  // Interval accumulators
  uint32_t interval_count_{0};
  uint32_t frames_{0};
  double laeq_acc_{0.0};
  double band_acc_[MAX_BANDS]{};
  std::vector<float> spectrum_acc_;  // flatness bins, summed frame power

  Result result_{};
  bool result_ready_{false};
};

}  // namespace esphome::audio_bands
