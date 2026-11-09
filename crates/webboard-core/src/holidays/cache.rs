use std::fs::{self, File};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use chrono::{SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::error::{CommandError, Result};

static TEMP_SEQ: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub fetched_at: String,
    pub body: String,
}

#[derive(Debug, Clone)]
pub struct Cache {
    dir: PathBuf,
}

fn io_error(what: &str, path: &Path, e: io::Error) -> CommandError {
    CommandError::new(
        "holidays.io",
        format!("{what} the holiday cache {}: {e}", path.display()),
    )
}

pub fn url_key(url: &str) -> String {
    Sha256::digest(url.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn discard(tmp: &Path, failure: CommandError) -> CommandError {
    match fs::remove_file(tmp) {
        Ok(()) => failure,
        Err(e) if e.kind() == io::ErrorKind::NotFound => failure,
        Err(e) => CommandError::new(
            &failure.code,
            format!(
                "{}; the temporary file {} could not be removed either: {e}",
                failure.message,
                tmp.display()
            ),
        ),
    }
}

fn sync_dir(dir: &Path) -> Result<()> {
    File::open(dir)
        .and_then(|d| d.sync_all())
        .map_err(|e| io_error("Could not sync", dir, e))
}

impl Cache {
    pub fn new(dir: PathBuf) -> Result<Self> {
        fs::create_dir_all(&dir).map_err(|e| io_error("Could not create", &dir, e))?;
        Ok(Self { dir })
    }

    fn path(&self, src: &str, key: &str) -> PathBuf {
        self.dir.join(src).join(format!("{key}.json"))
    }

    pub fn read(&self, src: &str, key: &str) -> Result<Option<Entry>> {
        let path = self.path(src, key);
        let bytes = match fs::read(&path) {
            Ok(bytes) => bytes,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(io_error("Could not read", &path, e)),
        };
        serde_json::from_slice(&bytes).map(Some).map_err(|e| {
            CommandError::new(
                "holidays.parse",
                format!("The holiday cache {} is damaged: {e}", path.display()),
            )
        })
    }

    pub fn write(&self, src: &str, key: &str, body: String) -> Result<Entry> {
        let entry = Entry {
            fetched_at: Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true),
            body,
        };
        let dir = self.dir.join(src);
        fs::create_dir_all(&dir).map_err(|e| io_error("Could not create", &dir, e))?;
        let path = self.path(src, key);
        let tmp = dir.join(format!(
            "{key}.json.tmp-{}-{}",
            std::process::id(),
            TEMP_SEQ.fetch_add(1, Ordering::Relaxed)
        ));
        let bytes = serde_json::to_vec(&entry).map_err(|e| {
            CommandError::new(
                "holidays.io",
                format!("Could not encode the holiday cache {}: {e}", path.display()),
            )
        })?;
        File::create(&tmp)
            .and_then(|mut f| f.write_all(&bytes).and_then(|()| f.sync_all()))
            .map_err(|e| io_error("Could not write", &tmp, e))
            .and_then(|()| {
                fs::rename(&tmp, &path).map_err(|e| io_error("Could not rename into", &path, e))
            })
            .map_err(|e| discard(&tmp, e))?;
        sync_dir(&dir)?;
        Ok(entry)
    }
}
