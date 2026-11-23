//! The 0-1 component scores (ported from `src/runtime/photo-intel/grouping.ts`).

/// Equirectangular distance; good to well under 1 % at the distances that matter.
/// Uses the mean latitude, so it is symmetric.
pub fn distance_km(a: LatLon, b: LatLon) -> f64 {
    let dy = (a.lat - b.lat) * 111.32;
    let dx = (a.lon - b.lon) * 111.32 * ((a.lat + b.lat) * 0.5).to_radians().cos();
    dx.hypot(dy)
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LatLon {
    pub lat: f64,
    pub lon: f64,
}

fn log_knots(x: f64, knots: &[(f64, f64)]) -> f64 {
    if x <= knots[0].0 {
        return knots[0].1;
    }
    for pair in knots.windows(2) {
        let ((x1, s1), (x2, s2)) = (pair[0], pair[1]);
        if x <= x2 {
            let k = (x.ln() - x1.ln()) / (x2.ln() - x1.ln());
            return s1 + (s2 - s1) * k;
        }
    }
    0.0
}

/// Piecewise-linear in log time: 1 within half an hour, 0 after a month.
pub fn time_score(delta_ms: i64) -> f32 {
    let hours = delta_ms.unsigned_abs() as f64 / 3_600_000.0;
    log_knots(
        hours,
        &[
            (0.5, 1.0),
            (3.0, 0.85),
            (8.0, 0.6),
            (36.0, 0.35),
            (24.0 * 7.0, 0.15),
            (24.0 * 30.0, 0.0),
        ],
    ) as f32
}

/// 1 within 300 m, 0 beyond 200 km.
pub fn place_score(km: f64) -> f32 {
    log_knots(
        km,
        &[
            (0.3, 1.0),
            (3.0, 0.85),
            (15.0, 0.6),
            (60.0, 0.3),
            (200.0, 0.08),
        ],
    ) as f32
}

/// Picture-to-picture cosine: ~0.5 is unrelated, 0.85 is the same scene.
pub fn visual_score(cosine: f32) -> f32 {
    ((cosine - 0.5) / 0.35).clamp(0.0, 1.0)
}

/// Dot product written so the compiler vectorises it (eight running sums).
pub fn dot(a: &[f32], b: &[f32]) -> f32 {
    let n = a.len().min(b.len());
    let (a, b) = (&a[..n], &b[..n]);
    let mut acc = [0f32; 8];
    let (ca, ra) = a.as_chunks::<8>();
    let (cb, rb) = b.as_chunks::<8>();
    for (x, y) in ca.iter().zip(cb) {
        for k in 0..8 {
            acc[k] += x[k] * y[k];
        }
    }
    let mut sum: f32 = acc.iter().sum();
    for (x, y) in ra.iter().zip(rb) {
        sum += x * y;
    }
    sum
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn time_score_matches_the_typescript_knots() {
        assert_eq!(time_score(0), 1.0);
        assert_eq!(time_score(30 * 60_000), 1.0);
        assert!((time_score(3 * 3_600_000) - 0.85).abs() < 1e-6);
        assert!((time_score(36 * 3_600_000) - 0.35).abs() < 1e-6);
        assert_eq!(time_score(31 * 86_400_000), 0.0);
        assert!(time_score(5 * 3_600_000) < 0.85 && time_score(5 * 3_600_000) > 0.6);
        assert_eq!(time_score(-3_600_000), time_score(3_600_000));
    }

    #[test]
    fn place_score_matches_the_typescript_knots() {
        assert_eq!(place_score(0.0), 1.0);
        assert!((place_score(15.0) - 0.6).abs() < 1e-6);
        assert_eq!(place_score(300.0), 0.0);
    }

    #[test]
    fn distance_is_symmetric_and_about_right() {
        let stockholm = LatLon {
            lat: 59.3293,
            lon: 18.0686,
        };
        let uppsala = LatLon {
            lat: 59.8586,
            lon: 17.6389,
        };
        let d = distance_km(stockholm, uppsala);
        assert!((d - 64.0).abs() < 2.0, "{d}");
        assert_eq!(d, distance_km(uppsala, stockholm));
    }

    #[test]
    fn dot_handles_any_length() {
        let a: Vec<f32> = (0..13).map(|i| i as f32).collect();
        let expected: f32 = a.iter().map(|x| x * x).sum();
        assert_eq!(dot(&a, &a), expected);
        assert_eq!(visual_score(0.5), 0.0);
        assert_eq!(visual_score(0.9), 1.0);
    }
}
