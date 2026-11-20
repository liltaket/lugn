#include "band_analyzer.h"

#include <algorithm>
#include <cmath>
#include <cstring>

namespace esphome::audio_bands {

static constexpr double K_PI = 3.14159265358979323846;
static constexpr uint8_t NO_BAND = 0xFF;
// Power floor per bin for the spectral flatness logarithm (-200 dBFS).
static constexpr float FLATNESS_EPSILON = 1e-20f;
static constexpr double LN2 = 0.69314718055994531;
static constexpr double FULL_SCALE = 32768.0;

// Unity-gain A-weighting response R_A(f) from IEC 61672-1 (before the +2.00 dB offset).
static double a_weighting_response(double f) {
  const double f2 = f * f;
  const double c1 = 20.598997 * 20.598997;
  const double c2 = 107.65265 * 107.65265;
  const double c3 = 737.86223 * 737.86223;
  const double c4 = 12194.217 * 12194.217;
  return (c4 * f2 * f2) / ((f2 + c1) * std::sqrt((f2 + c2) * (f2 + c3)) * (f2 + c4));
}

double BandAnalyzer::a_weighting_db(double f) { return 20.0 * std::log10(a_weighting_response(f)) + 2.0; }

float BandAnalyzer::power_to_db(double p) {
  // !(p > x) also catches NaN.
  if (!(p > 1e-12))
    return FLOOR_DB;
  return std::max(FLOOR_DB, static_cast<float>(10.0 * std::log10(p)));
}

bool BandAnalyzer::configure(uint32_t sample_rate, uint32_t interval_samples, const uint16_t *band_centers_hz,
                             size_t num_bands) {
  if (sample_rate == 0 || interval_samples < HOP || num_bands > MAX_BANDS)
    return false;

  this->sample_rate_ = sample_rate;
  this->interval_samples_ = interval_samples;
  this->num_bands_ = num_bands;

  const size_t m = FFT_SIZE / 2;
  this->window_.resize(FFT_SIZE);
  for (size_t n = 0; n < FFT_SIZE; ++n)
    this->window_[n] = static_cast<float>(0.5 - 0.5 * std::cos(2.0 * K_PI * n / FFT_SIZE));

  this->cos_.resize(m);
  this->sin_.resize(m);
  for (size_t k = 0; k < m; ++k) {
    this->cos_[k] = static_cast<float>(std::cos(2.0 * K_PI * k / FFT_SIZE));
    this->sin_[k] = static_cast<float>(std::sin(2.0 * K_PI * k / FFT_SIZE));
  }

  size_t bits = 0;
  while ((static_cast<size_t>(1) << bits) < m)
    ++bits;
  this->bitrev_.resize(m);
  for (size_t i = 0; i < m; ++i) {
    size_t r = 0;
    for (size_t b = 0; b < bits; ++b)
      r |= ((i >> b) & 1u) << (bits - 1 - b);
    this->bitrev_[i] = static_cast<uint16_t>(r);
  }

  const double bin_hz = static_cast<double>(sample_rate) / FFT_SIZE;
  const double nyquist = sample_rate / 2.0;

  this->a_weight_.resize(NUM_BINS);
  for (size_t k = 0; k < NUM_BINS; ++k) {
    const double r = a_weighting_response(k * bin_hz);
    this->a_weight_[k] = static_cast<float>(r * r * std::pow(10.0, 0.2));
  }

  // Octave bands with base-10 exact midband frequencies (IEC 61260-1):
  // f_m = 1000 * 10^(3x/10), edges f_m * 10^(+-3/20). Nominal 63 -> x = -4, ..., 8000 -> x = 3.
  this->bin_band_.assign(NUM_BINS, NO_BAND);
  for (size_t b = 0; b < num_bands; ++b) {
    const double nominal = band_centers_hz[b];
    if (nominal <= 0.0)
      return false;
    const long x = std::lround(std::log2(nominal / 1000.0));
    const double mid = 1000.0 * std::pow(10.0, 0.3 * x);
    const double lo = mid * std::pow(10.0, -0.15);
    const double hi = mid * std::pow(10.0, 0.15);
    this->band_low_hz_[b] = static_cast<float>(lo);
    this->band_high_hz_[b] = static_cast<float>(std::min(hi, nyquist));
    this->band_bins_[b] = 0;
    for (size_t k = 0; k < NUM_BINS; ++k) {
      const double f = k * bin_hz;
      // A band whose upper edge lies above Nyquist keeps every bin up to and including Nyquist.
      const bool inside = f >= lo && (f < hi || hi >= nyquist);
      if (inside && this->bin_band_[k] == NO_BAND) {
        this->bin_band_[k] = static_cast<uint8_t>(b);
        ++this->band_bins_[b];
      }
    }
  }

  this->flat_lo_bin_ = static_cast<size_t>(std::ceil(static_cast<double>(FLATNESS_LOW_HZ) / bin_hz));
  this->flat_hi_bin_ = std::min(static_cast<size_t>(std::floor(static_cast<double>(FLATNESS_HIGH_HZ) / bin_hz)), NUM_BINS - 2);
  if (this->flat_lo_bin_ > this->flat_hi_bin_)
    return false;

  this->history_.assign(FFT_SIZE, 0);
  this->re_.assign(m, 0.0f);
  this->im_.assign(m, 0.0f);
  this->power_.assign(NUM_BINS, 0.0f);
  this->spectrum_acc_.assign(this->flat_hi_bin_ - this->flat_lo_bin_ + 1, 0.0f);
  this->reset();
  return true;
}

void BandAnalyzer::reset() {
  this->history_fill_ = 0;
  this->interval_count_ = 0;
  this->frames_ = 0;
  this->laeq_acc_ = 0.0;
  for (double &acc : this->band_acc_)
    acc = 0.0;
  std::fill(this->spectrum_acc_.begin(), this->spectrum_acc_.end(), 0.0f);
  this->result_ready_ = false;
}

size_t BandAnalyzer::feed(const int16_t *samples, size_t n) {
  if (this->sample_rate_ == 0)
    return n;  // not configured: discard
  size_t consumed = 0;
  while (consumed < n && !this->result_ready_) {
    size_t take = std::min(n - consumed, FFT_SIZE - this->history_fill_);
    take = std::min<size_t>(take, this->interval_samples_ - this->interval_count_);
    std::memcpy(&this->history_[this->history_fill_], samples + consumed, take * sizeof(int16_t));
    this->history_fill_ += take;
    this->interval_count_ += take;
    consumed += take;

    if (this->history_fill_ == FFT_SIZE) {
      this->process_frame_();
      std::memmove(this->history_.data(), this->history_.data() + HOP, (FFT_SIZE - HOP) * sizeof(int16_t));
      this->history_fill_ = FFT_SIZE - HOP;
    }
    if (this->interval_count_ == this->interval_samples_)
      this->finish_interval_();
  }
  return consumed;
}

void BandAnalyzer::fft_() {
  // In-place iterative radix-2 decimation-in-time FFT of re_/im_ (FFT_SIZE / 2 points).
  const size_t m = FFT_SIZE / 2;
  float *re = this->re_.data();
  float *im = this->im_.data();
  for (size_t i = 0; i < m; ++i) {
    const size_t j = this->bitrev_[i];
    if (j > i) {
      std::swap(re[i], re[j]);
      std::swap(im[i], im[j]);
    }
  }
  for (size_t len = 2; len <= m; len <<= 1) {
    const size_t half = len >> 1;
    // Twiddle e^{-2 pi i j / len} = table[j * FFT_SIZE / len]
    const size_t step = FFT_SIZE / len;
    for (size_t start = 0; start < m; start += len) {
      for (size_t j = 0; j < half; ++j) {
        const float wr = this->cos_[j * step];
        const float wi = -this->sin_[j * step];
        const size_t a = start + j;
        const size_t b = a + half;
        const float vr = re[b] * wr - im[b] * wi;
        const float vi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - vr;
        im[b] = im[a] - vi;
        re[a] += vr;
        im[a] += vi;
      }
    }
  }
}

void BandAnalyzer::frame_power(const int16_t *frame, float *power_out) {
  const size_t m = FFT_SIZE / 2;
  const float in_scale = static_cast<float>(1.0 / FULL_SCALE);
  // Pack even samples into the real part and odd samples into the imaginary part.
  for (size_t i = 0; i < m; ++i) {
    this->re_[i] = frame[2 * i] * in_scale * this->window_[2 * i];
    this->im_[i] = frame[2 * i + 1] * in_scale * this->window_[2 * i + 1];
  }
  this->fft_();

  // Parseval: sum_n (w x)^2 = (1/N) sum_k |X_k|^2. Dividing by sum_n w^2 (= 3N/8 for Hann)
  // gives the mean square; one-sided bins count twice except DC and Nyquist.
  const float sum_w2 = 3.0f * FFT_SIZE / 8.0f;
  const float edge_scale = 1.0f / (FFT_SIZE * sum_w2);
  const float interior_scale = 2.0f * edge_scale;

  // Split the packed spectrum Z into the real-input spectrum X:
  // X_k = (Z_k + conj Z_{M-k}) / 2 - i e^{-2 pi i k / N} (Z_k - conj Z_{M-k}) / 2
  for (size_t k = 0; k <= m; ++k) {
    const size_t k1 = k % m;
    const size_t k2 = (m - k) % m;
    const float zr = this->re_[k1], zi = this->im_[k1];
    const float cr = this->re_[k2], ci = -this->im_[k2];
    const float er = 0.5f * (zr + cr), ei = 0.5f * (zi + ci);
    const float orr = 0.5f * (zi - ci), oi = -0.5f * (zr - cr);
    const float wr = (k < m) ? this->cos_[k] : -1.0f;
    const float wi = (k < m) ? -this->sin_[k] : 0.0f;
    const float xr = er + wr * orr - wi * oi;
    const float xi = ei + wr * oi + wi * orr;
    const float scale = (k == 0 || k == m) ? edge_scale : interior_scale;
    power_out[k] = (xr * xr + xi * xi) * scale;
  }
}

void BandAnalyzer::process_frame_() {
  float *p = this->power_.data();
  this->frame_power(this->history_.data(), p);

  float laeq = 0.0f;
  float bands[MAX_BANDS] = {};
  for (size_t k = 0; k < NUM_BINS; ++k) {
    laeq += p[k] * this->a_weight_[k];
    const uint8_t b = this->bin_band_[k];
    if (b != NO_BAND)
      bands[b] += p[k];
  }

  float *acc = this->spectrum_acc_.data();
  for (size_t k = this->flat_lo_bin_; k <= this->flat_hi_bin_; ++k)
    acc[k - this->flat_lo_bin_] += p[k];

  this->laeq_acc_ += static_cast<double>(laeq);
  for (size_t b = 0; b < this->num_bands_; ++b)
    this->band_acc_[b] += static_cast<double>(bands[b]);
  ++this->frames_;
}

void BandAnalyzer::finish_interval_() {
  if (this->frames_ > 0) {
    const double frames = this->frames_;
    this->result_.laeq_db = power_to_db(this->laeq_acc_ / frames);
    for (size_t b = 0; b < MAX_BANDS; ++b)
      this->result_.band_db[b] = b < this->num_bands_ ? power_to_db(this->band_acc_[b] / frames) : FLOOR_DB;
    this->result_.flatness = this->flatness_();
    this->result_.frames = this->frames_;
    this->result_ready_ = true;
  }
  this->interval_count_ = 0;
  this->frames_ = 0;
  this->laeq_acc_ = 0.0;
  for (double &acc : this->band_acc_)
    acc = 0.0;
  std::fill(this->spectrum_acc_.begin(), this->spectrum_acc_.end(), 0.0f);
}

float BandAnalyzer::flatness_() const {
  // Geometric mean through a normalised mantissa product, so only one log per interval. The
  // common 1/frames factor cancels in the ratio; the epsilon keeps digital silence finite.
  float mantissa = 1.0f;
  int exponent_sum = 0;
  double sum = 0.0;
  for (float a : this->spectrum_acc_) {
    const float v = a + FLATNESS_EPSILON;
    sum += static_cast<double>(v);
    int e;
    mantissa = std::frexp(mantissa * v, &e);
    exponent_sum += e;
  }
  const double count = static_cast<double>(this->spectrum_acc_.size());
  const double log_geo = (std::log(static_cast<double>(mantissa)) + exponent_sum * LN2) / count;
  const double log_arith = std::log(sum / count);
  return static_cast<float>(std::min(1.0, std::max(0.0, std::exp(log_geo - log_arith))));
}

}  // namespace esphome::audio_bands
