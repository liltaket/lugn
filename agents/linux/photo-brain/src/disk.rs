//! The originals' disk: is it there, and how much room is left.

use std::os::unix::fs::{DirBuilderExt, MetadataExt};
use std::path::Path;

/// Whether `path` is a mount point (its device differs from its parent's).
pub fn is_mount_point(path: &Path) -> bool {
    let Ok(meta) = std::fs::metadata(path) else {
        return false;
    };
    match path.parent() {
        None => true,
        Some(parent) => {
            std::fs::metadata(parent).is_ok_and(|p| p.dev() != meta.dev() || p.ino() == meta.ino())
        }
    }
}

/// Makes sure `store_dir` can be written to. It is created only when its parent
/// is a mounted filesystem, so a missing USB/NTFS disk never turns into a
/// directory on the system disk. `Err` explains why it is not ready.
pub fn prepare_store_dir(dir: &Path) -> Result<(), String> {
    match std::fs::metadata(dir) {
        Ok(meta) if meta.is_dir() => return Ok(()),
        Ok(_) => return Err(format!("{} is not a directory", dir.display())),
        Err(_) => {}
    }
    let Some(parent) = dir.parent().filter(|p| p.is_dir()) else {
        return Err(format!("{} is missing (disk not mounted?)", dir.display()));
    };
    if !is_mount_point(parent) {
        return Err(format!(
            "{} is missing and {} is not a mount point (disk not mounted? create the directory by hand if it belongs there)",
            dir.display(),
            parent.display()
        ));
    }
    std::fs::DirBuilder::new()
        .mode(0o700)
        .create(dir)
        .map_err(|e| format!("create {}: {e}", dir.display()))
}

/// Bytes available to this user on the filesystem holding `path`.
pub fn free_bytes(path: &Path) -> std::io::Result<u64> {
    use std::os::unix::ffi::OsStrExt;
    let c = std::ffi::CString::new(path.as_os_str().as_bytes()).map_err(|_| {
        std::io::Error::new(std::io::ErrorKind::InvalidInput, "path has a NUL byte")
    })?;
    // SAFETY: `c` is a valid NUL-terminated path and `stat` is a plain C struct
    // that statvfs fills in; it is only read after statvfs reported success.
    unsafe {
        let mut stat: libc::statvfs = std::mem::zeroed();
        if libc::statvfs(c.as_ptr(), &mut stat) != 0 {
            return Err(std::io::Error::last_os_error());
        }
        #[allow(clippy::useless_conversion)] // the field types differ between targets
        let free = u64::from(stat.f_bavail).saturating_mul(u64::from(stat.f_frsize));
        Ok(free)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn root_is_a_mount_point_and_tmp_subdirs_are_not() {
        assert!(is_mount_point(Path::new("/")));
        let dir = tempfile::tempdir().unwrap();
        let sub = dir.path().join("a");
        std::fs::create_dir(&sub).unwrap();
        assert!(!is_mount_point(&sub));
    }

    #[test]
    fn a_missing_mount_is_not_created() {
        let dir = tempfile::tempdir().unwrap();
        // Parent exists but is a plain directory: refuse.
        let store = dir.path().join("lugn-photos");
        assert!(prepare_store_dir(&store).is_err());
        assert!(!store.exists());
        // Parent missing altogether.
        let deep = dir.path().join("Filmer/lugn-photos");
        assert!(
            prepare_store_dir(&deep)
                .unwrap_err()
                .contains("not mounted")
        );
        assert!(!dir.path().join("Filmer").exists());
        // Existing directory: fine.
        std::fs::create_dir(&store).unwrap();
        assert!(prepare_store_dir(&store).is_ok());
        assert!(free_bytes(&store).unwrap() > 0);
    }
}
