//! The little vector arithmetic the grouping needs.

/// Dot product, written so the compiler vectorises it (eight independent sums).
#[inline]
pub(crate) fn dot(a: &[f32], b: &[f32]) -> f32 {
    debug_assert_eq!(a.len(), b.len());
    let mut acc = [0f32; 8];
    let (ac, ar) = a.as_chunks::<8>();
    let (bc, br) = b.as_chunks::<8>();
    for (x, y) in ac.iter().zip(bc) {
        for k in 0..8 {
            acc[k] += x[k] * y[k];
        }
    }
    let mut sum = acc.iter().sum::<f32>();
    for (x, y) in ar.iter().zip(br) {
        sum += x * y;
    }
    sum
}

/// `into += weight * v`.
#[inline]
pub(crate) fn add_scaled(into: &mut [f32], v: &[f32], weight: f32) {
    for (o, x) in into.iter_mut().zip(v) {
        *o += weight * x;
    }
}

/// Scales `v` to unit length; `None` when it is (nearly) zero or not finite.
pub(crate) fn normalized(v: &[f32]) -> Option<Vec<f32>> {
    let norm = dot(v, v).sqrt();
    if !norm.is_finite() || norm < 1e-6 {
        return None;
    }
    Some(v.iter().map(|x| x / norm).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dot_matches_the_plain_sum_for_odd_lengths() {
        let a: Vec<f32> = (0..19).map(|i| i as f32 * 0.5).collect();
        let b: Vec<f32> = (0..19).map(|i| 1.0 - i as f32 * 0.1).collect();
        let plain: f32 = a.iter().zip(&b).map(|(x, y)| x * y).sum();
        assert!((dot(&a, &b) - plain).abs() < 1e-3);
    }

    #[test]
    fn zero_vectors_have_no_direction() {
        assert!(normalized(&[0.0, 0.0]).is_none());
        assert!(normalized(&[f32::NAN, 1.0]).is_none());
        let unit = normalized(&[3.0, 4.0]).unwrap();
        assert!((unit[0] - 0.6).abs() < 1e-6 && (unit[1] - 0.8).abs() < 1e-6);
    }
}
