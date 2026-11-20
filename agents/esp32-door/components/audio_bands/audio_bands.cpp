#include "audio_bands.h"

#ifdef USE_ESP32

#include "esphome/core/hal.h"
#include "esphome/core/log.h"

#include <algorithm>
#include <cinttypes>

namespace esphome::audio_bands {

ESPHOME_LOG_TAG(TAG, "audio_bands");

// Audio buffered between the microphone task and loop(). loop() can stall
// this long (camera, WiFi, API) before samples are dropped.
static const uint32_t RING_BUFFER_DURATION_MS = 500;
// FFT frames per loop() call; each costs roughly 1 ms. Twice real time at a
// 16 ms loop interval, four frames when the backlog passes half the buffer.
static const size_t FRAMES_PER_LOOP = 2;
static const size_t FRAMES_PER_LOOP_BACKLOG = 4;

void AudioBandsComponent::add_band(uint16_t center_hz, sensor::Sensor *band_sensor) {
  if (this->num_bands_ >= BandAnalyzer::MAX_BANDS)
    return;
  this->band_centers_[this->num_bands_] = center_hz;
  this->band_sensors_[this->num_bands_] = band_sensor;
  ++this->num_bands_;
}

void AudioBandsComponent::dump_config() {
  ESP_LOGCONFIG(TAG,
                "Audio Bands:\n"
                "  Measurement Duration: %" PRIu32 " ms\n"
                "  FFT: %u points, Hann window, 50 %% overlap",
                this->measurement_duration_ms_, static_cast<unsigned>(BandAnalyzer::FFT_SIZE));
  LOG_SENSOR("  ", "LAeq:", this->laeq_sensor_);
  LOG_SENSOR("  ", "Spectral flatness:", this->spectral_flatness_sensor_);
  for (size_t b = 0; b < this->num_bands_; ++b) {
    if (this->configured_sample_rate_ != 0) {
      ESP_LOGCONFIG(TAG, "  Band %u Hz: %.1f .. %.1f Hz, %u bins", this->band_centers_[b],
                    this->analyzer_.band_low_hz(b), this->analyzer_.band_high_hz(b),
                    static_cast<unsigned>(this->analyzer_.band_bins(b)));
    }
    LOG_SENSOR("  ", "Band:", this->band_sensors_[b]);
  }
}

void AudioBandsComponent::setup() {
  this->microphone_source_->add_data_callback([this](const microphone::AudioCapture &capture) {
    // Runs in the microphone task: copy only, never wait.
    ring_buffer::RingBuffer *ring_buffer = this->ring_buffer_ptr_.load(std::memory_order_acquire);
    if (ring_buffer == nullptr)
      return;
    const size_t size = capture.data.size();
    // Whole captures or nothing, so the buffer always holds whole samples.
    const size_t written = ring_buffer->write_without_replacement(capture.data.data(), size, 0, false);
    if (written < size)
      this->dropped_bytes_.fetch_add(static_cast<uint32_t>(size - written), std::memory_order_relaxed);
  });

  if (!this->microphone_source_->is_passive()) {
    this->microphone_source_->start();
  }
}

bool AudioBandsComponent::start_() {
  const audio::AudioStreamInfo stream_info = this->microphone_source_->get_audio_stream_info();
  const uint32_t sample_rate = stream_info.get_sample_rate();

  if (sample_rate != this->configured_sample_rate_) {
    const uint32_t interval_samples = stream_info.ms_to_samples(this->measurement_duration_ms_);
    if (!this->analyzer_.configure(sample_rate, interval_samples, this->band_centers_, this->num_bands_)) {
      ESP_LOGE(TAG, "Unsupported stream: %" PRIu32 " Hz, %" PRIu32 " samples per interval", sample_rate,
               interval_samples);
      this->mark_failed();
      return false;
    }
    this->configured_sample_rate_ = sample_rate;
    for (size_t b = 0; b < this->num_bands_; ++b) {
      if (this->analyzer_.band_bins(b) == 0)
        ESP_LOGW(TAG, "Band %u Hz lies above Nyquist at %" PRIu32 " Hz and is never published", this->band_centers_[b],
                 sample_rate);
    }
  }

  if (this->ring_buffer_ == nullptr) {
    const size_t size = stream_info.ms_to_bytes(RING_BUFFER_DURATION_MS) & ~static_cast<size_t>(1);
    this->ring_buffer_ = ring_buffer::RingBuffer::create(size);
    if (this->ring_buffer_ == nullptr) {
      ESP_LOGE(TAG, "Could not allocate a %u byte ring buffer", static_cast<unsigned>(size));
      this->status_momentary_error(15000);
      return false;
    }
    this->ring_buffer_ptr_.store(this->ring_buffer_.get(), std::memory_order_release);
  }

  this->restart_interval_();
  this->running_ = true;
  this->status_clear_warning();
  return true;
}

void AudioBandsComponent::restart_interval_() {
  this->ring_buffer_->reset();
  this->dropped_bytes_seen_ = this->dropped_bytes_.load(std::memory_order_relaxed);
  this->analyzer_.reset();
  this->busy_us_ = 0;
  this->max_loop_us_ = 0;
}

void AudioBandsComponent::loop() {
  if (!this->microphone_source_->is_running()) {
    if (this->running_ || !this->status_has_warning()) {
      // No values are published while the microphone is off; the gap shows as missing rows.
      this->running_ = false;
      this->analyzer_.reset();
      this->status_set_warning(LOG_STR("Microphone isn't running, can't compute band levels"));
    }
    return;
  }

  if (!this->running_ && !this->start_())
    return;

  const uint32_t dropped = this->dropped_bytes_.load(std::memory_order_relaxed);
  if (dropped != this->dropped_bytes_seen_) {
    ++this->skipped_intervals_;
    ESP_LOGW(TAG, "Audio buffer overflowed (%" PRIu32 " bytes dropped); interval skipped, %" PRIu32 " skipped so far",
             dropped - this->dropped_bytes_seen_, this->skipped_intervals_);
    this->restart_interval_();
    return;
  }

  const uint32_t start_us = micros();
  const size_t frames = this->ring_buffer_->available() > this->ring_buffer_->free() ? FRAMES_PER_LOOP_BACKLOG
                                                                                      : FRAMES_PER_LOOP;
  // Each read of at most HOP samples completes at most one FFT frame.
  for (size_t i = 0; i < frames; ++i) {
    const size_t bytes = this->ring_buffer_->read(this->scratch_, sizeof(this->scratch_), 0);
    if (bytes == 0)
      break;
    const size_t samples = bytes / sizeof(int16_t);
    size_t done = 0;
    while (done < samples) {
      done += this->analyzer_.feed(this->scratch_ + done, samples - done);
      if (this->analyzer_.result_ready()) {
        this->publish_(this->analyzer_.result());
        this->analyzer_.clear_result();
      }
    }
    if (bytes < sizeof(this->scratch_))
      break;
  }
  const uint32_t elapsed_us = micros() - start_us;
  this->busy_us_ += elapsed_us;
  this->max_loop_us_ = std::max(this->max_loop_us_, elapsed_us);
}

void AudioBandsComponent::publish_(const BandAnalyzer::Result &result) {
  // One row per interval: everything goes out in this call, laeq last so a
  // consumer can treat it as the end of the row.
  for (size_t b = 0; b < this->num_bands_; ++b) {
    if (this->analyzer_.band_bins(b) > 0)
      this->band_sensors_[b]->publish_state(result.band_db[b]);
  }
  if (this->spectral_flatness_sensor_ != nullptr)
    this->spectral_flatness_sensor_->publish_state(result.flatness);
  if (this->laeq_sensor_ != nullptr)
    this->laeq_sensor_->publish_state(result.laeq_db);

  ++this->published_intervals_;
  ESP_LOGD(TAG,
           "Interval %" PRIu32 ": %" PRIu32 " frames, LAeq %.1f dB, flatness %.3f, CPU %" PRIu32 " us (max %" PRIu32
           " us per loop)",
           this->published_intervals_, result.frames, result.laeq_db, result.flatness, this->busy_us_,
           this->max_loop_us_);
  this->busy_us_ = 0;
  this->max_loop_us_ = 0;
}

void AudioBandsComponent::start() {
  if (this->microphone_source_->is_passive()) {
    ESP_LOGW(TAG, "Can't start the microphone in passive mode");
    return;
  }
  this->microphone_source_->start();
}

void AudioBandsComponent::stop() {
  if (this->microphone_source_->is_passive()) {
    ESP_LOGW(TAG, "Can't stop the microphone in passive mode");
    return;
  }
  this->microphone_source_->stop();
}

}  // namespace esphome::audio_bands

#endif
