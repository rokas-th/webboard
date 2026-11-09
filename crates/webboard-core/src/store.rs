use std::collections::hash_map::Entry;
use std::collections::HashMap;
use std::ffi::OsStr;
use std::fs::{self, File, OpenOptions, TryLockError};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use crate::error::{CommandError, Result};

pub const SEGMENT_MAX_BYTES: u64 = 4 << 20;

const SNAPSHOT: &str = "snapshot.bin";
const SNAPSHOT_TMP: &str = "snapshot.bin.tmp";
const LOCK: &str = "lock";
const MAGIC: &[u8; 4] = b"WBS1";
const HEADER: usize = 12;
const TRAILER: usize = 4;
const PLAN_LIST_LOCKED: &str =
    "The plan list is open in another WebBoard process; close it there first.";
const PLAN_LOCKED: &str = "This plan is open in another WebBoard process; close it there first.";

#[derive(Debug, Clone, PartialEq)]
pub struct Loaded {
    pub torn: bool,
    pub snapshot: Vec<u8>,
    pub snapshot_seq: u64,
    pub records: Vec<(u64, Vec<u8>)>,
    pub last_seq: u64,
}

impl Loaded {
    pub fn encode(&self) -> Vec<u8> {
        let entries: Vec<&[u8]> = std::iter::once(self.snapshot.as_slice())
            .chain(self.records.iter().map(|(_, bytes)| bytes.as_slice()))
            .collect();
        let size = 13 + entries.iter().map(|e| 4 + e.len()).sum::<usize>();
        let mut out = Vec::with_capacity(size);
        out.push(u8::from(self.torn));
        out.extend_from_slice(&self.last_seq.to_le_bytes());
        out.extend_from_slice(&le_u32(entries.len()).to_le_bytes());
        entries.iter().for_each(|e| {
            out.extend_from_slice(&le_u32(e.len()).to_le_bytes());
            out.extend_from_slice(e);
        });
        out
    }
}

fn le_u32(n: usize) -> u32 {
    u32::try_from(n).expect("store lengths and counts are checked to fit in u32 when written")
}

#[derive(Debug)]
struct Segment {
    first: u64,
    path: PathBuf,
}

#[derive(Debug)]
struct OpenSegment {
    file: File,
    len: u64,
}

#[derive(Debug)]
struct State {
    snapshot_seq: u64,
    last_seq: u64,
    segments: Vec<Segment>,
    open: Option<OpenSegment>,
}

#[derive(Debug)]
pub struct DocStore {
    dir: PathBuf,
    segment_max: u64,
    _lock: File,
    state: Option<State>,
    torn_unreported: bool,
}

pub(crate) fn locked_error(id: &str) -> CommandError {
    let message = if id == "local" || id.starts_with("ix-") {
        PLAN_LIST_LOCKED
    } else {
        PLAN_LOCKED
    };
    CommandError::new("store.locked", message)
}

fn io_error(what: &str, path: &Path, e: io::Error) -> CommandError {
    CommandError::new("store.io", format!("{what} {}: {e}", path.display()))
}

fn corrupt(path: &Path, detail: &str) -> CommandError {
    CommandError::new("store.corrupt", format!("{}: {detail}", path.display()))
}

fn too_large(what: &str, len: usize) -> CommandError {
    CommandError::new(
        "store.io",
        format!("{what} of {len} bytes is too large to store"),
    )
}

fn sync_dir(dir: &Path) -> Result<()> {
    File::open(dir)
        .and_then(|d| d.sync_all())
        .map_err(|e| io_error("Could not sync the directory", dir, e))
}

fn doc_id(dir: &Path) -> String {
    dir.file_name().map_or_else(
        || dir.display().to_string(),
        |n| n.to_string_lossy().into_owned(),
    )
}

fn encode_record(seq: u64, bytes: &[u8], len: u32) -> Vec<u8> {
    let mut record = Vec::with_capacity(HEADER + bytes.len() + TRAILER);
    record.extend_from_slice(&seq.to_le_bytes());
    record.extend_from_slice(&len.to_le_bytes());
    record.extend_from_slice(bytes);
    let crc = crc32fast::hash(&record);
    record.extend_from_slice(&crc.to_le_bytes());
    record
}

enum Parsed<'a> {
    Record {
        seq: u64,
        payload: &'a [u8],
        size: usize,
    },
    Short,
    BadCrc {
        reaches_end: bool,
    },
}

fn parse_record(rest: &[u8]) -> Parsed<'_> {
    if rest.len() < HEADER {
        return Parsed::Short;
    }
    let seq = u64::from_le_bytes(rest[..8].try_into().expect("8-byte slice"));
    let len = u32::from_le_bytes(rest[8..HEADER].try_into().expect("4-byte slice")) as usize;
    let size = HEADER + len + TRAILER;
    if rest.len() < size {
        return Parsed::Short;
    }
    let stored = u32::from_le_bytes(rest[HEADER + len..size].try_into().expect("4-byte slice"));
    if crc32fast::hash(&rest[..HEADER + len]) != stored {
        return Parsed::BadCrc {
            reaches_end: rest.len() == size,
        };
    }
    Parsed::Record {
        seq,
        payload: &rest[HEADER..HEADER + len],
        size,
    }
}

fn read_snapshot(dir: &Path) -> Result<(u64, Vec<u8>)> {
    let path = dir.join(SNAPSHOT);
    match fs::read(&path) {
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok((0, Vec::new())),
        Err(e) => Err(io_error("Could not read", &path, e)),
        Ok(bytes) if bytes.len() < 12 || &bytes[..4] != MAGIC => {
            Err(corrupt(&path, "not a WebBoard snapshot"))
        }
        Ok(bytes) if bytes.len() - 12 > u32::MAX as usize => {
            Err(corrupt(&path, "snapshot is larger than 4 GiB"))
        }
        Ok(bytes) => Ok((
            u64::from_le_bytes(bytes[4..12].try_into().expect("8-byte slice")),
            bytes[12..].to_vec(),
        )),
    }
}

fn segment_first(name: &OsStr, dir: &Path) -> Option<Result<u64>> {
    let digits = name.to_str()?.strip_prefix("seg-")?.strip_suffix(".log")?;
    Some(
        digits
            .parse::<u64>()
            .map_err(|_| corrupt(&dir.join(name), "segment name is not seg-<number>.log")),
    )
}

fn list_segments(dir: &Path) -> Result<Vec<Segment>> {
    let names = fs::read_dir(dir)
        .map_err(|e| io_error("Could not list", dir, e))?
        .map(|entry| {
            entry
                .map(|e| e.file_name())
                .map_err(|e| io_error("Could not list", dir, e))
        })
        .collect::<Result<Vec<_>>>()?;
    let mut segments = names
        .iter()
        .filter_map(|name| {
            segment_first(name, dir).map(|first| {
                first.map(|first| Segment {
                    first,
                    path: dir.join(name),
                })
            })
        })
        .collect::<Result<Vec<_>>>()?;
    segments.sort_by_key(|s| s.first);
    match segments.windows(2).find(|w| w[0].first == w[1].first) {
        Some(w) => Err(corrupt(
            &w[1].path,
            &format!("two segments start at seq {}", w[1].first),
        )),
        None => Ok(segments),
    }
}

fn truncate(path: &Path, len: u64) -> Result<()> {
    OpenOptions::new()
        .write(true)
        .open(path)
        .and_then(|f| f.set_len(len).and_then(|()| f.sync_all()))
        .map_err(|e| io_error("Could not cut the torn record from", path, e))
}

fn scan(dir: &Path) -> Result<(State, Loaded)> {
    let (snapshot_seq, snapshot) = read_snapshot(dir)?;
    let mut segments = list_segments(dir)?;
    let mut records = Vec::new();
    let mut last: Option<u64> = None;
    let mut torn = false;
    let mut last_len = 0u64;
    let count = segments.len();
    for (i, seg) in segments.iter().enumerate() {
        let bytes = fs::read(&seg.path).map_err(|e| io_error("Could not read", &seg.path, e))?;
        let is_last = i + 1 == count;
        let mut offset = 0usize;
        while offset < bytes.len() {
            match parse_record(&bytes[offset..]) {
                Parsed::Record { seq, payload, size } => {
                    if let Some(prev) = last.filter(|prev| seq <= *prev) {
                        return Err(corrupt(
                            &seg.path,
                            &format!("record at offset {offset} has seq {seq}, not after {prev}"),
                        ));
                    }
                    last = Some(seq);
                    if seq > snapshot_seq {
                        records.push((seq, payload.to_vec()));
                    }
                    offset += size;
                }
                Parsed::Short | Parsed::BadCrc { reaches_end: true } if is_last => {
                    truncate(&seg.path, offset as u64)?;
                    torn = true;
                    break;
                }
                Parsed::Short => {
                    return Err(corrupt(
                        &seg.path,
                        &format!("record at offset {offset} is cut short"),
                    ))
                }
                Parsed::BadCrc { .. } => {
                    return Err(corrupt(
                        &seg.path,
                        &format!("record at offset {offset} fails its checksum"),
                    ))
                }
            }
        }
        last_len = offset as u64;
    }
    if last_len == 0 {
        if let Some(seg) = segments.pop() {
            fs::remove_file(&seg.path)
                .map_err(|e| io_error("Could not remove the empty segment", &seg.path, e))?;
            sync_dir(dir)?;
        }
    }
    let open = segments
        .last()
        .map(|seg| {
            OpenOptions::new()
                .append(true)
                .open(&seg.path)
                .map(|file| OpenSegment {
                    file,
                    len: last_len,
                })
                .map_err(|e| io_error("Could not open", &seg.path, e))
        })
        .transpose()?;
    let last_seq = last.map_or(snapshot_seq, |l| l.max(snapshot_seq));
    Ok((
        State {
            snapshot_seq,
            last_seq,
            segments,
            open,
        },
        Loaded {
            torn,
            snapshot,
            snapshot_seq,
            records,
            last_seq,
        },
    ))
}

fn ensure<'a>(
    dir: &Path,
    state: &'a mut Option<State>,
    torn_unreported: &mut bool,
) -> Result<&'a mut State> {
    if state.is_none() {
        let (scanned, loaded) = scan(dir)?;
        *torn_unreported |= loaded.torn;
        *state = Some(scanned);
    }
    Ok(state.as_mut().expect("state was set above"))
}

fn write_snapshot(dir: &Path, seq: u64, body: &[u8]) -> Result<()> {
    let tmp = dir.join(SNAPSHOT_TMP);
    let path = dir.join(SNAPSHOT);
    let mut bytes = Vec::with_capacity(12 + body.len());
    bytes.extend_from_slice(MAGIC);
    bytes.extend_from_slice(&seq.to_le_bytes());
    bytes.extend_from_slice(body);
    File::create(&tmp)
        .and_then(|mut f| f.write_all(&bytes).and_then(|()| f.sync_all()))
        .map_err(|e| io_error("Could not write", &tmp, e))?;
    fs::rename(&tmp, &path).map_err(|e| io_error("Could not rename into", &path, e))?;
    sync_dir(dir)
}

#[cfg(test)]
fn pause_requested(point: &str) -> bool {
    std::env::var("WEBBOARD_STORE_PAUSE").is_ok_and(|p| p == point)
}

#[cfg(test)]
fn pause(dir: &Path, point: &str) {
    if pause_requested(point) {
        fs::write(dir.join("paused"), b"").expect("write the pause marker");
        loop {
            std::thread::park();
        }
    }
}

#[cfg(test)]
fn pause_mid_append(file: &mut File, record: &[u8], dir: &Path) -> io::Result<()> {
    if pause_requested("append-mid") {
        let half = HEADER + (record.len() - HEADER - TRAILER) / 2;
        file.write_all(&record[..half])?;
        file.sync_data()?;
        pause(dir, "append-mid");
    }
    Ok(())
}

impl DocStore {
    pub fn open(dir: &Path) -> Result<Self> {
        Self::open_with(dir, SEGMENT_MAX_BYTES)
    }

    pub(crate) fn open_with(dir: &Path, segment_max: u64) -> Result<Self> {
        fs::create_dir_all(dir).map_err(|e| io_error("Could not create", dir, e))?;
        let path = dir.join(LOCK);
        let lock = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(&path)
            .map_err(|e| io_error("Could not open", &path, e))?;
        match lock.try_lock() {
            Ok(()) => Ok(Self {
                dir: dir.to_path_buf(),
                segment_max,
                _lock: lock,
                state: None,
                torn_unreported: false,
            }),
            Err(TryLockError::WouldBlock) => Err(locked_error(&doc_id(dir))),
            Err(TryLockError::Error(e)) => Err(io_error("Could not lock", &path, e)),
        }
    }

    pub fn load(&mut self) -> Result<Loaded> {
        self.state = None;
        let (state, mut loaded) = scan(&self.dir)?;
        loaded.torn |= std::mem::take(&mut self.torn_unreported);
        self.state = Some(state);
        Ok(loaded)
    }

    pub fn append(&mut self, seq: u64, bytes: &[u8]) -> Result<()> {
        let result = self.try_append(seq, bytes);
        if result.as_ref().is_err_and(|e| e.code != "store.seq") {
            self.state = None;
        }
        result
    }

    pub fn compact(&mut self, seq: u64, state: &[u8]) -> Result<()> {
        let result = self.try_compact(seq, state);
        if result.as_ref().is_err_and(|e| e.code != "store.seq") {
            self.state = None;
        }
        result
    }

    fn try_append(&mut self, seq: u64, bytes: &[u8]) -> Result<()> {
        let len = u32::try_from(bytes.len()).map_err(|_| too_large("an update", bytes.len()))?;
        let Self {
            dir,
            segment_max,
            state,
            torn_unreported,
            ..
        } = self;
        let state = ensure(dir, state, torn_unreported)?;
        if seq <= state.last_seq {
            return Err(CommandError::new(
                "store.seq",
                format!("seq {seq} is not after {}", state.last_seq),
            ));
        }
        let record = encode_record(seq, bytes, len);
        let size = record.len() as u64;
        let roll = state
            .open
            .as_ref()
            .is_none_or(|o| o.len > 0 && o.len + size > *segment_max);
        if roll {
            state.open = None;
            let path = dir.join(format!("seg-{seq}.log"));
            let file = OpenOptions::new()
                .append(true)
                .create_new(true)
                .open(&path)
                .map_err(|e| io_error("Could not create", &path, e))?;
            sync_dir(dir)?;
            state.segments.push(Segment { first: seq, path });
            state.open = Some(OpenSegment { file, len: 0 });
        }
        let path = &state
            .segments
            .last()
            .expect("an open segment is listed")
            .path;
        let open = state.open.as_mut().expect("a segment is open");
        #[cfg(test)]
        pause_mid_append(&mut open.file, &record, dir)
            .map_err(|e| io_error("Could not append to", path, e))?;
        match open
            .file
            .write_all(&record)
            .and_then(|()| open.file.sync_data())
        {
            Ok(()) => {
                open.len += size;
                state.last_seq = seq;
                Ok(())
            }
            Err(e) => match open.file.set_len(open.len) {
                Ok(()) => Err(io_error("Could not append to", path, e)),
                Err(t) => Err(CommandError::new(
                    "store.io",
                    format!(
                        "Could not append to {}: {e}; cutting the partial record back failed: {t}",
                        path.display()
                    ),
                )),
            },
        }
    }

    fn try_compact(&mut self, seq: u64, body: &[u8]) -> Result<()> {
        u32::try_from(body.len()).map_err(|_| too_large("a snapshot", body.len()))?;
        let Self {
            dir,
            state,
            torn_unreported,
            ..
        } = self;
        let state = ensure(dir, state, torn_unreported)?;
        if seq < state.snapshot_seq || seq > state.last_seq {
            return Err(CommandError::new(
                "store.seq",
                format!(
                    "compact seq {seq} is not between {} and {}",
                    state.snapshot_seq, state.last_seq
                ),
            ));
        }
        write_snapshot(dir, seq, body)?;
        #[cfg(test)]
        pause(dir, "after-rename");
        state.open = None;
        let ends: Vec<u64> = state
            .segments
            .windows(2)
            .map(|w| w[1].first - 1)
            .chain(state.segments.last().map(|_| state.last_seq))
            .collect();
        let (covered, kept): (Vec<_>, Vec<_>) = std::mem::take(&mut state.segments)
            .into_iter()
            .zip(ends)
            .partition(|(_, end)| *end <= seq);
        covered.iter().try_for_each(|(seg, _)| {
            fs::remove_file(&seg.path)
                .map_err(|e| io_error("Could not remove the compacted segment", &seg.path, e))
        })?;
        if !covered.is_empty() {
            sync_dir(dir)?;
        }
        state.segments = kept.into_iter().map(|(seg, _)| seg).collect();
        state.snapshot_seq = seq;
        Ok(())
    }
}

fn check_id(id: &str) -> Result<()> {
    let valid = (1..=64).contains(&id.len())
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-');
    if valid {
        Ok(())
    } else {
        Err(CommandError::new(
            "store.io",
            format!("invalid document id: {id:?}"),
        ))
    }
}

#[derive(Debug)]
pub struct Store {
    root: PathBuf,
    docs: Mutex<HashMap<String, Arc<Mutex<DocStore>>>>,
}

impl Store {
    pub fn new(root: PathBuf) -> Self {
        Self {
            root,
            docs: Mutex::new(HashMap::new()),
        }
    }

    pub fn doc(&self, id: &str) -> Result<Arc<Mutex<DocStore>>> {
        check_id(id)?;
        let mut docs = self.docs.lock().map_err(|_| {
            CommandError::new(
                "store.io",
                "The document table is unusable after an earlier panic; restart WebBoard.",
            )
        })?;
        match docs.entry(id.to_string()) {
            Entry::Occupied(e) => Ok(Arc::clone(e.get())),
            Entry::Vacant(v) => {
                let doc = DocStore::open(&self.root.join(id))?;
                Ok(Arc::clone(v.insert(Arc::new(Mutex::new(doc)))))
            }
        }
    }

    pub fn list(&self) -> Result<Vec<String>> {
        let entries = match fs::read_dir(&self.root) {
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(io_error("Could not list", &self.root, e)),
            Ok(entries) => entries,
        };
        let mut ids = entries
            .map(|entry| {
                entry
                    .and_then(|e| Ok((e.file_name(), e.file_type()?.is_dir())))
                    .map_err(|e| io_error("Could not list", &self.root, e))
            })
            .collect::<Result<Vec<_>>>()?
            .into_iter()
            .filter(|(_, is_dir)| *is_dir)
            .filter_map(|(name, _)| name.to_str().map(str::to_string))
            .filter(|name| check_id(name).is_ok())
            .collect::<Vec<_>>();
        ids.sort();
        Ok(ids)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};
    use tempfile::TempDir;

    fn payload(seq: u64) -> Vec<u8> {
        format!("u{seq}").into_bytes()
    }

    fn seg_names(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .filter(|n| n.starts_with("seg-"))
            .collect();
        names.sort();
        names
    }

    fn append_range(s: &mut DocStore, seqs: std::ops::RangeInclusive<u64>) {
        seqs.for_each(|seq| s.append(seq, &payload(seq)).unwrap());
    }

    fn seqs(l: &Loaded) -> Vec<u64> {
        l.records.iter().map(|(seq, _)| *seq).collect()
    }

    #[test]
    fn append_then_load() {
        let tmp = TempDir::new().unwrap();
        {
            let mut s = DocStore::open(tmp.path()).unwrap();
            append_range(&mut s, 1..=3);
        }
        let mut s = DocStore::open(tmp.path()).unwrap();
        let l = s.load().unwrap();
        assert!(!l.torn);
        assert_eq!(l.snapshot, Vec::<u8>::new());
        assert_eq!(l.snapshot_seq, 0);
        assert_eq!(
            l.records,
            (1..=3).map(|q| (q, payload(q))).collect::<Vec<_>>()
        );
        assert_eq!(l.last_seq, 3);
    }

    #[test]
    fn seq_must_increase() {
        let tmp = TempDir::new().unwrap();
        let mut s = DocStore::open(tmp.path()).unwrap();
        s.append(3, b"a").unwrap();
        assert_eq!(
            s.append(3, b"b").unwrap_err(),
            CommandError::new("store.seq", "seq 3 is not after 3")
        );
        assert_eq!(s.load().unwrap().records, vec![(3, b"a".to_vec())]);
    }

    #[test]
    fn compact_keeps_later_records() {
        let tmp = TempDir::new().unwrap();
        {
            let mut s = DocStore::open(tmp.path()).unwrap();
            append_range(&mut s, 1..=5);
            s.compact(3, b"S").unwrap();
            s.append(6, &payload(6)).unwrap();
        }
        let mut s = DocStore::open(tmp.path()).unwrap();
        let l = s.load().unwrap();
        assert_eq!(l.snapshot, b"S".to_vec());
        assert_eq!(l.snapshot_seq, 3);
        assert_eq!(seqs(&l), vec![4, 5, 6]);
        assert_eq!(l.last_seq, 6);
        assert!(!l.torn);
    }

    #[test]
    fn compact_deletes_covered_segments() {
        let tmp = TempDir::new().unwrap();
        let mut s = DocStore::open_with(tmp.path(), 54).unwrap();
        append_range(&mut s, 1..=9);
        assert_eq!(
            seg_names(tmp.path()),
            ["seg-1.log", "seg-4.log", "seg-7.log"]
        );
        s.compact(6, b"S").unwrap();
        assert_eq!(seg_names(tmp.path()), ["seg-7.log"]);
        let l = s.load().unwrap();
        assert_eq!(l.snapshot_seq, 6);
        assert_eq!(seqs(&l), vec![7, 8, 9]);
    }

    #[test]
    fn compact_seq_bounds() {
        let tmp = TempDir::new().unwrap();
        let mut s = DocStore::open(tmp.path()).unwrap();
        append_range(&mut s, 1..=9);
        s.compact(3, b"S").unwrap();
        assert_eq!(
            s.compact(0, b"S").unwrap_err(),
            CommandError::new("store.seq", "compact seq 0 is not between 3 and 9")
        );
        assert_eq!(
            s.compact(10, b"S").unwrap_err(),
            CommandError::new("store.seq", "compact seq 10 is not between 3 and 9")
        );
        assert_eq!(s.load().unwrap().snapshot_seq, 3);
    }

    #[test]
    fn bad_crc_mid_log_is_corrupt() {
        let tmp = TempDir::new().unwrap();
        {
            let mut s = DocStore::open(tmp.path()).unwrap();
            append_range(&mut s, 1..=3);
        }
        let seg = tmp.path().join("seg-1.log");
        let mut bytes = fs::read(&seg).unwrap();
        bytes[18 + 12] ^= 0xff;
        fs::write(&seg, &bytes).unwrap();
        let e = DocStore::open(tmp.path()).unwrap().load().unwrap_err();
        assert_eq!(e.code, "store.corrupt");
        assert!(e.message.contains("seg-1.log"), "{}", e.message);
        assert!(e.message.contains("offset 18"), "{}", e.message);
        assert_eq!(fs::read(&seg).unwrap(), bytes);
    }

    #[test]
    fn bad_crc_last_record_is_torn() {
        let tmp = TempDir::new().unwrap();
        {
            let mut s = DocStore::open(tmp.path()).unwrap();
            append_range(&mut s, 1..=3);
        }
        let seg = tmp.path().join("seg-1.log");
        let mut bytes = fs::read(&seg).unwrap();
        bytes[36 + 12] ^= 0xff;
        fs::write(&seg, &bytes).unwrap();
        let l = DocStore::open(tmp.path()).unwrap().load().unwrap();
        assert!(l.torn);
        assert_eq!(seqs(&l), vec![1, 2]);
        assert_eq!(fs::read(&seg).unwrap().len(), 36);
    }

    #[test]
    fn bad_doc_ids_refused() {
        let tmp = TempDir::new().unwrap();
        let store = Store::new(tmp.path().join("docs"));
        ["../x".to_string(), String::new(), "a".repeat(65)]
            .iter()
            .for_each(|id| {
                let e = store.doc(id).unwrap_err();
                assert_eq!(e.code, "store.io");
                assert!(e.message.contains("invalid document id"), "{}", e.message);
            });
        store.doc(&"a".repeat(64)).unwrap();
        assert!(!tmp.path().join("x").exists());
    }

    #[test]
    fn list_docs() {
        let tmp = TempDir::new().unwrap();
        let store = Store::new(tmp.path().join("docs"));
        assert_eq!(store.list().unwrap(), Vec::<String>::new());
        store.doc("local").unwrap();
        store.doc("ab12").unwrap();
        fs::create_dir(tmp.path().join("docs/ab12.bad-1700000000")).unwrap();
        assert_eq!(store.list().unwrap(), ["ab12", "local"]);
        assert!(Arc::ptr_eq(
            &store.doc("local").unwrap(),
            &store.doc("local").unwrap()
        ));
    }

    #[test]
    fn loaded_encode_layout() {
        let l = Loaded {
            torn: true,
            snapshot: b"S".to_vec(),
            snapshot_seq: 3,
            records: vec![(4, b"ab".to_vec())],
            last_seq: 4,
        };
        let mut want = vec![0x01];
        want.extend_from_slice(&4u64.to_le_bytes());
        want.extend_from_slice(&2u32.to_le_bytes());
        want.extend_from_slice(&1u32.to_le_bytes());
        want.extend_from_slice(b"S");
        want.extend_from_slice(&2u32.to_le_bytes());
        want.extend_from_slice(b"ab");
        assert_eq!(l.encode(), want);
    }

    fn snapshot_body(seqs: std::ops::RangeInclusive<u64>) -> Vec<u8> {
        seqs.map(|q| format!("u{q}"))
            .collect::<Vec<_>>()
            .join("\n")
            .into_bytes()
    }

    fn park_forever() -> ! {
        loop {
            std::thread::park();
        }
    }

    fn env(name: &str) -> String {
        std::env::var(name).unwrap_or_else(|e| panic!("{name}: {e}"))
    }

    #[test]
    #[ignore]
    fn child_main() {
        let mode = match std::env::var("WEBBOARD_STORE_CHILD") {
            Err(std::env::VarError::NotPresent) => return,
            other => other.unwrap(),
        };
        let dir = PathBuf::from(env("WEBBOARD_STORE_DIR"));
        let max: u64 = env("WEBBOARD_STORE_SEGMENT_MAX").parse().unwrap();
        let point = env("WEBBOARD_STORE_PAUSE");
        std::env::remove_var("WEBBOARD_STORE_PAUSE");
        let arm = || std::env::set_var("WEBBOARD_STORE_PAUSE", &point);
        let mut s = DocStore::open_with(&dir, max).unwrap();
        let ack = |s: &mut DocStore, seq: u64| {
            s.append(seq, &payload(seq)).unwrap();
            println!("ack {seq}");
        };
        match mode.as_str() {
            "hold" => {
                fs::write(dir.join("paused"), b"").unwrap();
                park_forever();
            }
            "compact" => {
                (1..=20).for_each(|seq| ack(&mut s, seq));
                arm();
                s.compact(15, &snapshot_body(1..=15)).unwrap();
            }
            "append" => {
                (1..=10).for_each(|seq| ack(&mut s, seq));
                arm();
                ack(&mut s, 11);
            }
            other => panic!("unknown child mode {other}"),
        }
    }

    fn spawn_child(
        mode: &str,
        dir: &Path,
        max: u64,
        point: &str,
        while_paused: impl FnOnce(),
    ) -> String {
        let mut child = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "store::tests::child_main",
                "--include-ignored",
                "--nocapture",
            ])
            .env("WEBBOARD_STORE_CHILD", mode)
            .env("WEBBOARD_STORE_DIR", dir)
            .env("WEBBOARD_STORE_SEGMENT_MAX", max.to_string())
            .env("WEBBOARD_STORE_PAUSE", point)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let marker = dir.join("paused");
        let start = Instant::now();
        while !marker.exists() {
            if child.try_wait().unwrap().is_some() || start.elapsed() > Duration::from_secs(10) {
                child.kill().unwrap();
                let out = child.wait_with_output().unwrap();
                panic!(
                    "child {mode} did not pause within 10 s ({}): {}",
                    out.status,
                    String::from_utf8_lossy(&out.stderr)
                );
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        let checked = std::panic::catch_unwind(std::panic::AssertUnwindSafe(while_paused));
        child.kill().unwrap();
        let out = child.wait_with_output().unwrap();
        if let Err(p) = checked {
            std::panic::resume_unwind(p);
        }
        String::from_utf8(out.stdout).unwrap()
    }

    fn acks(stdout: &str) -> BTreeSet<u64> {
        stdout
            .lines()
            .filter_map(|l| l.strip_prefix("ack "))
            .map(|n| n.parse().unwrap())
            .collect()
    }

    #[test]
    fn kill_after_rename_loses_nothing() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path();
        let acked = acks(&spawn_child("compact", dir, 64, "after-rename", || {}));
        assert_eq!(acked, (1..=20).collect());
        assert!(dir.join("seg-13.log").exists(), "{:?}", seg_names(dir));
        let mut s = DocStore::open_with(dir, 64).unwrap();
        let l = s.load().unwrap();
        assert!(!l.torn);
        assert_eq!(l.snapshot_seq, 15);
        assert_eq!(seqs(&l), (16..=20).collect::<Vec<_>>());
        let snapshot = String::from_utf8(l.snapshot.clone()).unwrap();
        let mut seen: Vec<String> = snapshot
            .lines()
            .map(str::to_string)
            .chain(
                l.records
                    .iter()
                    .map(|(_, b)| String::from_utf8(b.clone()).unwrap()),
            )
            .collect();
        seen.sort();
        let unique: BTreeSet<String> = seen.iter().cloned().collect();
        assert_eq!(seen.len(), unique.len(), "duplicates in {seen:?}");
        assert_eq!(
            unique,
            acked
                .iter()
                .map(|q| format!("u{q}"))
                .collect::<BTreeSet<_>>()
        );
        s.compact(20, &snapshot_body(1..=20)).unwrap();
        assert_eq!(seg_names(dir), Vec::<String>::new());
    }

    #[test]
    fn kill_mid_append_flags_torn() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path();
        let acked = acks(&spawn_child(
            "append",
            dir,
            SEGMENT_MAX_BYTES,
            "append-mid",
            || {},
        ));
        assert_eq!(acked, (1..=10).collect());
        {
            let mut s = DocStore::open(dir).unwrap();
            let l = s.load().unwrap();
            assert!(l.torn);
            assert_eq!(seqs(&l), (1..=10).collect::<Vec<_>>());
            s.append(11, &payload(11)).unwrap();
        }
        let l = DocStore::open(dir).unwrap().load().unwrap();
        assert!(!l.torn);
        assert_eq!(
            l.records,
            (1..=11).map(|q| (q, payload(q))).collect::<Vec<_>>()
        );
    }

    #[test]
    fn kill_holder_releases_lock() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path().join("P");
        spawn_child("hold", &dir, SEGMENT_MAX_BYTES, "", || {
            assert_eq!(DocStore::open(&dir).unwrap_err().code, "store.locked");
        });
        let start = Instant::now();
        while let Err(e) = DocStore::open(&dir) {
            assert!(
                start.elapsed() < Duration::from_secs(2),
                "still locked after 2 s: {e:?}"
            );
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    #[test]
    fn locked_message_by_doc() {
        let tmp = TempDir::new().unwrap();
        [
            ("local", PLAN_LIST_LOCKED),
            ("ix-sp000000000", PLAN_LIST_LOCKED),
            ("P", PLAN_LOCKED),
        ]
        .iter()
        .for_each(|(name, message)| {
            let dir = tmp.path().join("docs").join(name);
            spawn_child("hold", &dir, SEGMENT_MAX_BYTES, "", || {
                assert_eq!(
                    DocStore::open(&dir).unwrap_err(),
                    CommandError::new("store.locked", *message)
                );
            });
        });
        assert_eq!(
            PLAN_LIST_LOCKED,
            "The plan list is open in another WebBoard process; close it there first."
        );
        assert_eq!(
            PLAN_LOCKED,
            "This plan is open in another WebBoard process; close it there first."
        );
    }
}
