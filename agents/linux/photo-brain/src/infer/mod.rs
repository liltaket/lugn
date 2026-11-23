use crate::analysis::PictureAnalyzer;
use std::path::Path;
/// Opens the ONNX models found in `models_dir`. Replaced by the inference module.
pub fn open(_models_dir: &Path, _threads: usize) -> anyhow::Result<Box<dyn PictureAnalyzer>> {
    anyhow::bail!("inference module not built yet")
}
