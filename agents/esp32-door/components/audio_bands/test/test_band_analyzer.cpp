// Host unit test for the audio_bands DSP core. Run from this directory:
//   g++ -std=c++20 -O2 -Wall -Wextra -I.. test_band_analyzer.cpp ../band_analyzer.cpp -o /tmp/test_band_analyzer && /tmp/test_band_analyzer

#include "band_analyzer.h"

#include <cmath>
#include <cstdio>
#include <random>
#include <vector>

using esphome::audio_bands::BandAnalyzer;

static int failures = 0;
static void check(bool ok, const char *what) {
  std::printf("  [%s] %s\n", ok ? "ok" : "FAIL", what);
  if (!ok)
    ++failures;
}

static constexpr uint32_t FS = 16000;
static constexpr uint32_t INTERVAL = 16000;  // 1 s
static const uint16_t CENTERS[] = {63, 125, 250, 500, 1000, 2000, 4000, 8000};
static constexpr size_t NB = 8;
static const double PI = 3.14159265358979323846;

static int16_t to_i16(double v) {
  const double s = std::round(v * 32768.0);
  return static_cast<int16_t>(std::max(-32768.0, std::min(32767.0, s)));
}

static std::vector<int16_t> sine(double f, double rms_dbfs, size_t n) {
  const double amp = std::sqrt(2.0) * std::pow(10.0, rms_dbfs / 20.0);
  std::vector<int16_t> out(n);
  for (size_t i = 0; i < n; ++i)
    out[i] = to_i16(amp * std::sin(2.0 * PI * f * i / FS + 0.3));
  return out;
}

static std::vector<int16_t> noise(double rms_dbfs, size_t n, uint32_t seed) {
  std::mt19937 rng(seed);
  std::normal_distribution<double> dist(0.0, std::pow(10.0, rms_dbfs / 20.0));
  std::vector<int16_t> out(n);
  for (auto &s : out)
    s = to_i16(dist(rng));
  return out;
}

// What sound_level's RMS sensor would read for these samples.
static double rms_dbfs(const std::vector<int16_t> &x) {
  double acc = 0.0;
  for (int16_t s : x)
    acc += static_cast<double>(s) * s;
  return 10.0 * std::log10(acc / (32768.0 * 32768.0) / x.size());
}

// Independent A-weighting (IEC 61672-1), not shared with the code under test.
static double ref_a_db(double f) {
  const double f2 = f * f;
  const double ra = 148693636.0 * f2 * f2 /
                    ((f2 + 424.36) * std::sqrt((f2 + 11599.29) * (f2 + 544496.41)) * (f2 + 148693636.0));
  return 20.0 * std::log10(ra) + 2.0;
}

// Feeds everything, returns all interval results.
static std::vector<BandAnalyzer::Result> run(BandAnalyzer &a, const std::vector<int16_t> &x, size_t chunk = 4096) {
  std::vector<BandAnalyzer::Result> results;
  size_t pos = 0;
  while (pos < x.size()) {
    pos += a.feed(x.data() + pos, std::min(chunk, x.size() - pos));
    if (a.result_ready()) {
      results.push_back(a.result());
      a.clear_result();
    }
  }
  return results;
}

static BandAnalyzer make() {
  BandAnalyzer a;
  if (!a.configure(FS, INTERVAL, CENTERS, NB))
    std::printf("configure failed\n");
  return a;
}

int main() {
  std::printf("Band layout (bin %.3f Hz):\n", FS / 1024.0);
  {
    BandAnalyzer a = make();
    for (size_t b = 0; b < NB; ++b)
      std::printf("  %5u Hz: %7.1f .. %7.1f Hz, %3zu bins\n", CENTERS[b], a.band_low_hz(b), a.band_high_hz(b),
                  a.band_bins(b));
    check(a.band_bins(0) == 3, "63 Hz band has 3 bins (46.9, 62.5, 78.1 Hz)");
    check(std::fabs(a.band_high_hz(7) - 8000.0f) < 0.01f, "8000 Hz band clipped to Nyquist");
  }

  std::printf("A-weighting vs IEC 61672-1 table:\n");
  {
    const double f[] = {31.5, 63, 125, 250, 500, 1000, 2000, 4000, 8000};
    const double table[] = {-39.4, -26.2, -16.1, -8.6, -3.2, 0.0, 1.2, 1.0, -1.1};
    bool ok = true;
    for (size_t i = 0; i < 9; ++i) {
      const double v = BandAnalyzer::a_weighting_db(f[i]);
      std::printf("  %6.1f Hz: %6.2f dB (table %5.1f)\n", f[i], v, table[i]);
      ok &= std::fabs(v - table[i]) < 0.15;
    }
    check(ok, "A-weighting within 0.15 dB of the table");
  }

  std::printf("FFT against a direct DFT:\n");
  {
    BandAnalyzer a = make();
    auto x = noise(-10.0, 1024, 7);
    std::vector<float> p(BandAnalyzer::NUM_BINS);
    a.frame_power(x.data(), p.data());
    double max_err = 0.0, total = 0.0, windowed_ms = 0.0;
    for (size_t n = 0; n < 1024; ++n) {
      const double w = 0.5 - 0.5 * std::cos(2.0 * PI * n / 1024);
      windowed_ms += std::pow(w * x[n] / 32768.0, 2);
    }
    windowed_ms /= 1024 * 0.375;
    for (size_t k = 0; k <= 512; ++k) {
      double re = 0, im = 0;
      for (size_t n = 0; n < 1024; ++n) {
        const double w = 0.5 - 0.5 * std::cos(2.0 * PI * n / 1024);
        re += w * x[n] / 32768.0 * std::cos(2.0 * PI * k * n / 1024);
        im -= w * x[n] / 32768.0 * std::sin(2.0 * PI * k * n / 1024);
      }
      const double ref = (re * re + im * im) * ((k == 0 || k == 512) ? 1.0 : 2.0) / (1024 * 1024 * 0.375);
      max_err = std::max(max_err, std::fabs(ref - p[k]));
      total += p[k];
    }
    std::printf("  max bin error %.3g, Parseval sum %.6g vs windowed mean square %.6g\n", max_err, total,
                windowed_ms);
    check(max_err < 1e-6 * windowed_ms * 512, "FFT bins match the DFT");
    check(std::fabs(total / windowed_ms - 1.0) < 1e-4, "bins sum to the windowed mean square (Parseval)");
  }

  std::printf("Full-scale 1 kHz sine:\n");
  {
    BandAnalyzer a = make();
    std::vector<int16_t> x(3 * INTERVAL);
    for (size_t i = 0; i < x.size(); ++i)
      x[i] = to_i16((32767.0 / 32768.0) * std::sin(2.0 * PI * 1000.0 * i / FS));
    auto r = run(a, x);
    std::printf("  band 1000: %.2f dBFS, laeq %.2f, sound_level RMS %.2f\n", r[1].band_db[4], r[1].laeq_db,
                rms_dbfs(x));
    check(std::fabs(r[1].band_db[4] + 3.01f) < 0.1f, "full-scale sine reads -3.01 dBFS in its band");
  }

  std::printf("1 kHz sine at -20 dBFS RMS:\n");
  {
    BandAnalyzer a = make();
    auto x = sine(1000.0, -20.0, 5 * INTERVAL);
    auto r = run(a, x);
    check(r.size() == 5, "one result per second of audio");
    bool others_low = true;
    for (size_t b = 0; b < NB; ++b)
      if (b != 4)
        others_low &= r[2].band_db[b] < -60.0f;
    std::printf("  band 1000 %.3f, laeq %.3f, flatness %.4f, frames %u, sound_level RMS %.3f\n", r[2].band_db[4],
                r[2].laeq_db, r[2].flatness, r[2].frames, rms_dbfs(x));
    check(std::fabs(r[2].band_db[4] + 20.0f) < 0.5f, "band 1000 reads -20 +- 0.5");
    check(std::fabs(r[2].laeq_db + 20.0f) < 0.1f, "laeq reads -20 (A = 0 dB at 1 kHz)");
    check(others_low, "other bands below -60 dBFS");
    check(r[2].flatness < 0.01f, "pure tone flatness near 0");
  }

  std::printf("Sines at the exact band midbands, -10 dBFS RMS:\n");
  {
    bool level_ok = true, leak_ok = true, laeq_ok = true;
    for (size_t b = 0; b < NB; ++b) {
      const double mid = 1000.0 * std::pow(10.0, 0.3 * (static_cast<int>(b) - 4));
      BandAnalyzer a = make();
      auto r = run(a, sine(mid, -10.0, 3 * INTERVAL));
      float worst_other = -200.0f;
      for (size_t o = 0; o < NB; ++o)
        if (o != b)
          worst_other = std::max(worst_other, r[1].band_db[o]);
      const double laeq_expected = -10.0 + ref_a_db(mid);
      std::printf("  %7.1f Hz: own band %7.3f dBFS, loudest other %7.1f, laeq %7.2f (expected %7.2f)\n", mid,
                  r[1].band_db[b], worst_other, r[1].laeq_db, laeq_expected);
      level_ok &= std::fabs(r[1].band_db[b] + 10.0f) < 0.5f;
      leak_ok &= worst_other < -10.0f - 30.0f;
      // At 63 Hz the Hann main lobe spans 47..78 Hz, where A-weighting changes by 7 dB, so
      // per-bin weighting reads a tone up to ~0.5 dB high; from 125 Hz up the error is < 0.1 dB.
      laeq_ok &= std::fabs(r[1].laeq_db - laeq_expected) < (b == 0 ? 0.5 : 0.1);
    }
    check(level_ok, "each tone reads -10 +- 0.5 dBFS in its own band");
    check(leak_ok, "neighbouring bands at least 30 dB lower");
    check(laeq_ok, "laeq matches -10 dB + A(f) (0.5 dB at 63 Hz, 0.1 dB above)");
  }

  std::printf("White noise, -20 dBFS RMS:\n");
  {
    BandAnalyzer a = make();
    auto x = noise(-20.0, 10 * INTERVAL, 42);
    auto r = run(a, x);
    // Expected LAeq: noise power is uniform over the one-sided bins.
    double weight = 0.0;
    for (size_t k = 0; k <= 512; ++k) {
      const double f = k * FS / 1024.0;
      const double g = k == 0 ? 0.0 : std::pow(10.0, ref_a_db(f) / 10.0);
      weight += g * ((k == 0 || k == 512) ? 0.5 : 1.0);
    }
    const double expected = rms_dbfs(x) + 10.0 * std::log10(weight / 512.0);
    double laeq = 0, flat = 0, total = 0;
    for (size_t i = 1; i < r.size(); ++i) {
      laeq += r[i].laeq_db;
      flat += r[i].flatness;
      double band_power = 0;
      for (size_t b = 0; b < NB; ++b)
        band_power += std::pow(10.0, r[i].band_db[b] / 10.0);
      total += 10.0 * std::log10(band_power);
    }
    laeq /= r.size() - 1;
    flat /= r.size() - 1;
    total /= r.size() - 1;
    std::printf("  laeq %.2f, expected %.2f, sound_level RMS %.2f, band sum %.2f, flatness %.3f\n", laeq, expected,
                rms_dbfs(x), total, flat);
    check(std::fabs(laeq - expected) < 0.3, "laeq matches the A-weighted noise level within 0.3 dB");
    check(std::fabs(laeq - rms_dbfs(x)) < 1.0, "laeq within 1 dB of sound_level RMS for white noise");
    check(std::fabs(total - rms_dbfs(x)) < 0.3, "bands sum to the broadband level (44.7 Hz..8 kHz)");
    check(flat > 0.9 && flat <= 1.0, "white noise flatness near 1");
  }

  std::printf("Digital silence:\n");
  {
    BandAnalyzer a = make();
    auto r = run(a, std::vector<int16_t>(2 * INTERVAL, 0));
    bool ok = r.size() == 2;
    for (auto &res : r) {
      ok &= res.laeq_db == BandAnalyzer::FLOOR_DB && std::isfinite(res.flatness);
      for (size_t b = 0; b < NB; ++b)
        ok &= res.band_db[b] == BandAnalyzer::FLOOR_DB;
    }
    std::printf("  laeq %.1f, band 63 %.1f, flatness %.3f\n", r[0].laeq_db, r[0].band_db[0], r[0].flatness);
    check(ok, "silence reads the -120 dB floor, nothing NaN or infinite");
  }

  std::printf("Chunking and reset:\n");
  {
    auto x = noise(-30.0, 6 * INTERVAL, 3);
    BandAnalyzer a = make(), b = make();
    auto whole = run(a, x, x.size());
    std::vector<BandAnalyzer::Result> pieces;
    std::mt19937 rng(9);
    size_t pos = 0;
    while (pos < x.size()) {
      const size_t n = std::min<size_t>(1 + rng() % 700, x.size() - pos);
      size_t done = 0;
      while (done < n) {
        done += b.feed(x.data() + pos + done, n - done);
        if (b.result_ready()) {
          pieces.push_back(b.result());
          b.clear_result();
        }
      }
      pos += n;
    }
    bool same = whole.size() == pieces.size() && whole.size() == 6;
    for (size_t i = 0; same && i < whole.size(); ++i) {
      same &= whole[i].laeq_db == pieces[i].laeq_db && whole[i].frames == pieces[i].frames &&
              whole[i].flatness == pieces[i].flatness;
      std::printf("  interval %zu: %u frames\n", i, whole[i].frames);
    }
    check(same, "results independent of how the stream is chunked");

    BandAnalyzer c = make();
    auto loud = sine(1000.0, -6.0, INTERVAL / 2);
    c.feed(loud.data(), loud.size());
    c.reset();
    auto quiet = run(c, std::vector<int16_t>(INTERVAL, 0));
    check(quiet.size() == 1 && quiet[0].laeq_db == BandAnalyzer::FLOOR_DB, "reset() discards the interval");
  }

  std::printf("%s (%d failure%s)\n", failures ? "FAILED" : "PASSED", failures, failures == 1 ? "" : "s");
  return failures ? 1 : 0;
}
