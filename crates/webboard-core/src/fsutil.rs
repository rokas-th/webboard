use std::fs;
use std::io::Write;
use std::path::Path;

pub fn replace_file(dir: &Path, name: &str, bytes: &[u8]) -> std::io::Result<()> {
    fs::create_dir_all(dir)?;
    let tmp = dir.join(format!("{name}.tmp"));
    let mut file = fs::File::create(&tmp)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    drop(file);
    fs::rename(&tmp, dir.join(name))?;
    fs::File::open(dir)?.sync_all()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn replace_file_swaps_the_whole_file_and_leaves_no_temp() {
        let tmp = TempDir::new().expect("temp dir");
        let dir = tmp.path().join("nested");
        replace_file(&dir, "state.json", b"first").expect("first write");
        replace_file(&dir, "state.json", b"second").expect("second write");
        assert_eq!(fs::read(dir.join("state.json")).expect("read"), b"second");
        assert!(!dir.join("state.json.tmp").exists());
    }
}
