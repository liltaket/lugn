#pragma once

#ifdef USE_ESP32

#include "band_analyzer.h"

#include "esphome/components/microphone/microphone_source.h"
#include "esphome/components/ring_buffer/ring_buffer.h"
#include "esphome/components/sensor/sensor.h"
#include "esphome/core/component.h"

#include <atomic>
#include <memory>

namespace esphome::audio_bands {

/// Octave band levels, LAeq and spectral flatness from a MicrophoneSource.
///
/// The microphone task only copies samples into a ring buffer (never blocks;
/// a capture that does not fit is dropped and counted). loop() reads the ring
/// buffer and runs at most a few FFT frames per call. All sensors of an
/// interval are published together in one loop() call, laeq last; an interval
/// with dropped samples is skipped and logged.
class AudioBandsComponent final : public Component {
  SUB_SENSOR(laeq)
  SUB_SENSOR(spectral_flatness)

 public:
  void dump_config() override;
  void setup() override;
  void loop() override;

  float get_setup_priority() const override { return setup_priority::AFTER_CONNECTION; }

  void set_measurement_duration(uint32_t measurement_duration_ms) {
    this->measurement_duration_ms_ = measurement_duration_ms;
  }
  void set_microphone_source(microphone::MicrophoneSource *microphone_source) {
    this->microphone_source_ = microphone_source;
  }
  void add_band(uint16_t center_hz, sensor::Sensor *band_sensor);

  /// Starts the MicrophoneSource (not in passive mode).
  void start();
  /// Stops the MicrophoneSource (not in passive mode).
  void stop();

 protected:
  bool start_();
  void publish_(const BandAnalyzer::Result &result);
  void restart_interval_();

  microphone::MicrophoneSource *microphone_source_{nullptr};

  // Allocated once on the first start and never freed, so the microphone
  // callback can never see a dangling pointer.
  std::unique_ptr<ring_buffer::RingBuffer> ring_buffer_;
  std::atomic<ring_buffer::RingBuffer *> ring_buffer_ptr_{nullptr};
  std::atomic<uint32_t> dropped_bytes_{0};
  uint32_t dropped_bytes_seen_{0};

  BandAnalyzer analyzer_;
  uint32_t configured_sample_rate_{0};
  bool running_{false};

  uint16_t band_centers_[BandAnalyzer::MAX_BANDS]{};
  sensor::Sensor *band_sensors_[BandAnalyzer::MAX_BANDS]{};
  size_t num_bands_{0};

  int16_t scratch_[BandAnalyzer::HOP];

  uint32_t measurement_duration_ms_{1000};
  uint32_t skipped_intervals_{0};
  uint32_t published_intervals_{0};
  uint32_t busy_us_{0};      // processing time in the current interval
  uint32_t max_loop_us_{0};  // longest loop() processing in the current interval
};

}  // namespace esphome::audio_bands

#endif
