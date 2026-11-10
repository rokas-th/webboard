use std::collections::hash_map::Entry;
use std::collections::HashMap;
use std::ffi::OsStr;
use std::fs::{self, File, OpenOptions, TryLockError};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::error::{CommandError, Result};

pub const SEGMENT_MAX_BYTES: u64 = 4 << 20;

const SNAPSHOT: &str = "snapshot.bin";
const SNAPSHOT_TMP: &str = "snapshot.bin.tmp";
const LOCK: &str = "lock";
const LOCK_WAIT: Duration = Duration::from_millis(500);
const LOCK_RETRY: Duration = Duration::from_millis(10);
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
    last_record: Option<Vec<u8>>,
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
    #[cfg(test)]
    fail_next_append: bool,
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
    BadCrc,
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
        return Parsed::BadCrc;
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
    let not_a_number = || corrupt(&dir.join(name), "segment name is not seg-<number>.log");
    Some(
        if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
            Err(not_a_number())
        } else {
            digits.parse::<u64>().map_err(|_| not_a_number())
        },
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

fn torn_path(seg: &Path, offset: usize) -> PathBuf {
    let mut name = seg.as_os_str().to_os_string();
    name.push(format!(".torn-{offset}"));
    PathBuf::from(name)
}

fn save_torn(dir: &Path, seg: &Path, offset: usize, tail: &[u8]) -> Result<()> {
    let path = torn_path(seg, offset);
    File::create(&path)
        .and_then(|mut f| f.write_all(tail).and_then(|()| f.sync_all()))
        .map_err(|e| io_error("Could not keep the torn record in", &path, e))?;
    sync_dir(dir)
}

fn later_record(tail: &[u8], after: Option<u64>) -> Option<(usize, u64)> {
    (1..tail.len()).find_map(|i| match parse_record(&tail[i..]) {
        Parsed::Record { seq, .. } if after.is_none_or(|prev| seq > prev) => Some((i, seq)),
        _ => None,
    })
}

struct Scan {
    snapshot_seq: u64,
    last: Option<u64>,
    last_record: Option<Vec<u8>>,
    records: Vec<(u64, Vec<u8>)>,
    torn: bool,
}

impl Scan {
    fn segment(&mut self, dir: &Path, seg: &Segment, is_last: bool) -> Result<u64> {
        let bytes = fs::read(&seg.path).map_err(|e| io_error("Could not read", &seg.path, e))?;
        if bytes.is_empty() && !is_last {
            return Err(corrupt(
                &seg.path,
                &format!("segment is empty, but it should start at seq {}", seg.first),
            ));
        }
        let mut offset = 0usize;
        let mut last_payload: Option<&[u8]> = None;
        while offset < bytes.len() {
            match parse_record(&bytes[offset..]) {
                Parsed::Record { seq, payload, size } => {
                    if offset == 0 && seq != seg.first {
                        return Err(corrupt(
                            &seg.path,
                            &format!(
                                "first record has seq {seq}, but the segment is named for seq {}",
                                seg.first
                            ),
                        ));
                    }
                    if let Some(prev) = self.last.filter(|prev| seq <= *prev) {
                        return Err(corrupt(
                            &seg.path,
                            &format!("record at offset {offset} has seq {seq}, not after {prev}"),
                        ));
                    }
                    self.last = Some(seq);
                    last_payload = Some(payload);
                    if seq > self.snapshot_seq {
                        self.records.push((seq, payload.to_vec()));
                    }
                    offset += size;
                }
                Parsed::Short | Parsed::BadCrc if is_last => {
                    let tail = &bytes[offset..];
                    if let Some((at, seq)) = later_record(tail, self.last) {
                        return Err(corrupt(
                            &seg.path,
                            &format!(
                                "record at offset {offset} is damaged, but an intact record with seq {seq} follows at offset {}",
                                offset + at
                            ),
                        ));
                    }
                    save_torn(dir, &seg.path, offset, tail)?;
                    truncate(&seg.path, offset as u64)?;
                    self.torn = true;
                    break;
                }
                Parsed::Short => {
                    return Err(corrupt(
                        &seg.path,
                        &format!("record at offset {offset} is cut short"),
                    ))
                }
                Parsed::BadCrc => {
                    return Err(corrupt(
                        &seg.path,
                        &format!("record at offset {offset} fails its checksum"),
                    ))
                }
            }
        }
        if let Some(payload) = last_payload {
            self.last_record = Some(payload.to_vec());
        }
        Ok(offset as u64)
    }
}

fn scan(dir: &Path) -> Result<(State, Loaded)> {
    let (snapshot_seq, snapshot) = read_snapshot(dir)?;
    let mut segments = list_segments(dir)?;
    let mut scanned = Scan {
        snapshot_seq,
        last: None,
        last_record: None,
        records: Vec::new(),
        torn: false,
    };
    let count = segments.len();
    let mut lens = segments
        .iter()
        .enumerate()
        .map(|(i, seg)| scanned.segment(dir, seg, i + 1 == count))
        .collect::<Result<Vec<u64>>>()?;
    if lens.last() == Some(&0) {
        let seg = segments.pop().expect("a segment per length");
        lens.pop();
        fs::remove_file(&seg.path)
            .map_err(|e| io_error("Could not remove the empty segment", &seg.path, e))?;
        sync_dir(dir)?;
    }
    let open = segments
        .last()
        .zip(lens.last())
        .map(|(seg, &len)| {
            OpenOptions::new()
                .append(true)
                .open(&seg.path)
                .map(|file| OpenSegment { file, len })
                .map_err(|e| io_error("Could not open", &seg.path, e))
        })
        .transpose()?;
    let Scan {
        last,
        last_record,
        records,
        torn,
        ..
    } = scanned;
    let last_seq = last.map_or(snapshot_seq, |l| l.max(snapshot_seq));
    Ok((
        State {
            snapshot_seq,
            last_seq,
            last_record,
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

#[cfg(test)]
fn injected_fault(file: &mut File, record: &[u8], fail: bool) -> io::Result<()> {
    if fail {
        file.write_all(&record[..record.len() / 2])?;
        return Err(io::Error::other("injected append fault"));
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
        lock_waiting(&lock, &path, &doc_id(dir))?;
        Ok(Self {
            dir: dir.to_path_buf(),
            segment_max,
            _lock: lock,
            state: None,
            torn_unreported: false,
            #[cfg(test)]
            fail_next_append: false,
        })
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
            #[cfg(test)]
            fail_next_append,
            ..
        } = self;
        let state = ensure(dir, state, torn_unreported)?;
        if seq == state.last_seq && state.last_record.as_deref() == Some(bytes) {
            return Ok(());
        }
        if seq <= state.last_seq {
            return Err(CommandError::new(
                "store.seq",
                format!("seq {seq} is not after {}", state.last_seq),
            ));
        }
        if state.last_seq == 0 && seq > 1 {
            return Err(CommandError::new(
                "store.seq",
                format!("seq {seq} into an empty document"),
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
        #[cfg(test)]
        let ready = injected_fault(&mut open.file, &record, std::mem::take(fail_next_append));
        #[cfg(not(test))]
        let ready = io::Result::Ok(());
        match ready
            .and_then(|()| open.file.write_all(&record))
            .and_then(|()| open.file.sync_data())
        {
            Ok(()) => {
                open.len += size;
                state.last_seq = seq;
                state.last_record = Some(bytes.to_vec());
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
        if state.segments.is_empty() {
            state.last_record = None;
        }
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

type DocTable = HashMap<String, Arc<Mutex<DocStore>>>;

#[derive(Debug, Clone)]
pub struct Store {
    root: PathBuf,
    docs: Arc<Mutex<DocTable>>,
}

impl Store {
    pub fn new(root: PathBuf) -> Self {
        Self {
            root,
            docs: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    fn table(&self) -> Result<std::sync::MutexGuard<'_, DocTable>> {
        self.docs.lock().map_err(|_| {
            CommandError::new(
                "store.io",
                "The document table is unusable after an earlier panic; restart WebBoard.",
            )
        })
    }

    pub fn doc(&self, id: &str) -> Result<Arc<Mutex<DocStore>>> {
        check_id(id)?;
        let mut docs = self.table()?;
        match docs.entry(id.to_string()) {
            Entry::Occupied(e) => Ok(Arc::clone(e.get())),
            Entry::Vacant(v) => {
                let doc = DocStore::open(&self.root.join(id))?;
                Ok(Arc::clone(v.insert(Arc::new(Mutex::new(doc)))))
            }
        }
    }

    pub fn set_aside(&self, id: &str, secs: u64) -> Result<()> {
        check_id(id)?;
        let mut docs = self.table()?;
        let dir = self.root.join(id);
        if !dir.is_dir() {
            return Err(CommandError::new("store.io", format!("no document {id}")));
        }
        let target = self.root.join(format!("{id}.bad-{secs}"));
        if target.exists() {
            return Err(CommandError::new(
                "store.io",
                format!("{} already exists", target.display()),
            ));
        }
        if docs.get(id).is_some_and(|d| Arc::strong_count(d) > 1) {
            return Err(CommandError::new(
                "store.locked",
                format!("Plan {id} is still being saved in this window; try again."),
            ));
        }
        let held = match docs.remove(id) {
            Some(doc) => Held::Doc(doc),
            None => Held::File(lock_dir(&dir, id)?),
        };
        if let Err(e) = fs::rename(&dir, &target) {
            if let Held::Doc(doc) = held {
                docs.insert(id.to_string(), doc);
            }
            return Err(CommandError::new(
                "store.io",
                format!(
                    "Could not move {} to {}: {e}",
                    dir.display(),
                    target.display()
                ),
            ));
        }
        sync_dir(&self.root).map_err(|e| {
            CommandError::new(
                "store.io",
                format!(
                    "{} was moved to {}, but {}",
                    dir.display(),
                    target.display(),
                    e.message
                ),
            )
        })?;
        match held {
            Held::Doc(doc) => drop(doc),
            Held::File(lock) => lock
                .unlock()
                .map_err(|e| io_error("Could not unlock", &target.join(LOCK), e))?,
        }
        drop(docs);
        Ok(())
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
            .map(|(name, _)| self.listed_id(&name))
            .filter_map(Result::transpose)
            .collect::<Result<Vec<_>>>()?;
        ids.sort();
        Ok(ids)
    }

    fn listed_id(&self, name: &OsStr) -> Result<Option<String>> {
        match name.to_str() {
            Some(id) if check_id(id).is_ok() => Ok(Some(id.to_string())),
            Some(name) if is_set_aside(name) => Ok(None),
            _ => Err(CommandError::new(
                "store.foreign",
                self.root.join(name).display().to_string(),
            )),
        }
    }
}

enum Held {
    Doc(Arc<Mutex<DocStore>>),
    File(File),
}

fn lock_dir(dir: &Path, id: &str) -> Result<File> {
    let path = dir.join(LOCK);
    let lock = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(&path)
        .map_err(|e| io_error("Could not open", &path, e))?;
    lock_waiting(&lock, &path, id)?;
    Ok(lock)
}

fn lock_waiting(lock: &File, path: &Path, id: &str) -> Result<()> {
    let start = Instant::now();
    loop {
        match lock.try_lock() {
            Ok(()) => return Ok(()),
            Err(TryLockError::WouldBlock) if start.elapsed() < LOCK_WAIT => {
                std::thread::sleep(LOCK_RETRY)
            }
            Err(TryLockError::WouldBlock) => return Err(locked_error(id)),
            Err(TryLockError::Error(e)) => return Err(io_error("Could not lock", path, e)),
        }
    }
}

fn is_set_aside(name: &str) -> bool {
    name.rsplit_once(".bad-").is_some_and(|(id, secs)| {
        check_id(id).is_ok() && !secs.is_empty() && secs.bytes().all(|b| b.is_ascii_digit())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;
    use std::process::{Command, Stdio};
    use tempfile::TempDir;

    fn payload(seq: u64) -> Vec<u8> {
        format!("u{seq}").into_bytes()
    }

    fn seg_names(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .filter(|n| n.starts_with("seg-") && n.ends_with(".log"))
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
        append_range(&mut s, 1..=2);
        s.append(3, b"a").unwrap();
        assert_eq!(
            s.append(3, b"b").unwrap_err(),
            CommandError::new("store.seq", "seq 3 is not after 3")
        );
        assert_eq!(seqs(&s.load().unwrap()), [1, 2, 3]);
        assert_eq!(s.load().unwrap().records[2], (3, b"a".to_vec()));
    }

    #[test]
    fn resend_of_the_last_record_is_accepted() {
        let tmp = TempDir::new().unwrap();
        let mut s = DocStore::open(tmp.path()).unwrap();
        append_range(&mut s, 1..=2);
        let before = fs::read(tmp.path().join("seg-1.log")).unwrap();
        s.append(2, &payload(2)).unwrap();
        assert_eq!(fs::read(tmp.path().join("seg-1.log")).unwrap(), before);
        assert_eq!(
            s.append(2, b"other").unwrap_err(),
            CommandError::new("store.seq", "seq 2 is not after 2")
        );
        assert_eq!(
            s.append(1, &payload(1)).unwrap_err(),
            CommandError::new("store.seq", "seq 1 is not after 2")
        );
        drop(s);
        let mut s = DocStore::open(tmp.path()).unwrap();
        s.append(2, &payload(2)).unwrap();
        assert_eq!(
            s.append(2, b"other").unwrap_err(),
            CommandError::new("store.seq", "seq 2 is not after 2")
        );
        assert_eq!(fs::read(tmp.path().join("seg-1.log")).unwrap(), before);
        assert_eq!(seqs(&s.load().unwrap()), [1, 2]);
        s.compact(2, b"S").unwrap();
        assert_eq!(
            s.append(2, &payload(2)).unwrap_err(),
            CommandError::new("store.seq", "seq 2 is not after 2")
        );
    }

    #[test]
    fn empty_doc_starts_at_seq_one() {
        let tmp = TempDir::new().unwrap();
        let mut s = DocStore::open(tmp.path()).unwrap();
        assert_eq!(
            s.append(2, &payload(2)).unwrap_err(),
            CommandError::new("store.seq", "seq 2 into an empty document")
        );
        assert_eq!(seg_names(tmp.path()), Vec::<String>::new());
        s.append(1, &payload(1)).unwrap();
        s.append(3, &payload(3)).unwrap();
        assert_eq!(seqs(&s.load().unwrap()), [1, 3]);
    }

    #[test]
    fn compact_keeps_later_records() {
        let tmp = TempDir::new().unwrap();
        {
            let mut s = DocStore::open(tmp.path()).unwrap();
            append_range(&mut s, 1..=5);
            s.compact(3, b"S").unwrap();
            s.append(6, &payload(6)).unwrap();
            assert_eq!(seg_names(tmp.path()), ["seg-1.log", "seg-6.log"]);
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

    fn raw_records(seqs: impl IntoIterator<Item = u64>) -> Vec<u8> {
        seqs.into_iter()
            .flat_map(|q| {
                let p = payload(q);
                encode_record(q, &p, u32::try_from(p.len()).unwrap())
            })
            .collect()
    }

    fn torn_names(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .filter(|n| n.contains(".torn-"))
            .collect();
        names.sort();
        names
    }

    fn corrupt_load(dir: &Path) -> CommandError {
        let e = DocStore::open(dir).unwrap().load().unwrap_err();
        assert_eq!(e.code, "store.corrupt", "{}", e.message);
        e
    }

    fn seg1_full_and_empty_seg4(dir: &Path) -> Vec<u8> {
        {
            let mut s = DocStore::open_with(dir, 54).unwrap();
            append_range(&mut s, 1..=3);
        }
        File::create(dir.join("seg-4.log")).unwrap();
        let seg1 = fs::read(dir.join("seg-1.log")).unwrap();
        assert_eq!(seg1.len(), 54);
        seg1
    }

    #[test]
    fn empty_last_segment_reopens_the_previous_at_its_length() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path();
        let seg1 = seg1_full_and_empty_seg4(dir);
        let mut s = DocStore::open_with(dir, 54).unwrap();
        let l = s.load().unwrap();
        assert!(!l.torn);
        assert_eq!(seqs(&l), vec![1, 2, 3]);
        assert_eq!(seg_names(dir), ["seg-1.log"]);
        append_range(&mut s, 4..=5);
        assert_eq!(fs::read(dir.join("seg-1.log")).unwrap(), seg1);
        assert_eq!(seg_names(dir), ["seg-1.log", "seg-4.log"]);
        assert_eq!(seqs(&s.load().unwrap()), vec![1, 2, 3, 4, 5]);
    }

    #[test]
    fn append_failure_after_reopen_keeps_acked_records() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path();
        let seg1 = seg1_full_and_empty_seg4(dir);
        let mut s = DocStore::open_with(dir, 54).unwrap();
        s.load().unwrap();
        s.fail_next_append = true;
        let e = s.append(4, &payload(4)).unwrap_err();
        assert_eq!(e.code, "store.io");
        assert!(e.message.contains("injected append fault"), "{}", e.message);
        assert_eq!(fs::read(dir.join("seg-1.log")).unwrap(), seg1);
        append_range(&mut s, 4..=5);
        assert_eq!(fs::read(dir.join("seg-1.log")).unwrap(), seg1);
        assert_eq!(seg_names(dir), ["seg-1.log", "seg-4.log"]);
        let l = s.load().unwrap();
        assert!(!l.torn);
        assert_eq!(seqs(&l), vec![1, 2, 3, 4, 5]);
    }

    #[test]
    fn append_failure_cuts_back_to_the_acked_length() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path();
        let seg1 = seg1_full_and_empty_seg4(dir);
        let mut s = DocStore::open(dir).unwrap();
        s.load().unwrap();
        s.fail_next_append = true;
        assert_eq!(s.append(4, &payload(4)).unwrap_err().code, "store.io");
        assert_eq!(fs::read(dir.join("seg-1.log")).unwrap(), seg1);
        s.append(4, &payload(4)).unwrap();
        assert_eq!(seg_names(dir), ["seg-1.log"]);
        assert_eq!(fs::read(dir.join("seg-1.log")).unwrap().len(), 72);
        drop(s);
        let l = DocStore::open(dir).unwrap().load().unwrap();
        assert!(!l.torn);
        assert_eq!(
            l.records,
            (1..=4).map(|q| (q, payload(q))).collect::<Vec<_>>()
        );
    }

    #[test]
    fn a_zero_tail_longer_than_a_header_in_the_last_segment_is_torn() {
        let tmp = TempDir::new().unwrap();
        {
            let mut s = DocStore::open(tmp.path()).unwrap();
            append_range(&mut s, 1..=3);
        }
        let seg = tmp.path().join("seg-1.log");
        let mut bytes = fs::read(&seg).unwrap();
        bytes.extend_from_slice(&[0u8; 40]);
        fs::write(&seg, &bytes).unwrap();
        let l = DocStore::open(tmp.path()).unwrap().load().unwrap();
        assert!(l.torn);
        assert_eq!(seqs(&l), vec![1, 2, 3]);
        assert_eq!(fs::read(&seg).unwrap(), bytes[..54]);
        assert_eq!(torn_names(tmp.path()), ["seg-1.log.torn-54"]);
        assert_eq!(
            fs::read(tmp.path().join("seg-1.log.torn-54")).unwrap(),
            vec![0u8; 40]
        );
    }

    #[test]
    fn a_zero_tail_in_an_earlier_segment_is_corrupt() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path();
        {
            let mut s = DocStore::open_with(dir, 54).unwrap();
            append_range(&mut s, 1..=5);
        }
        assert_eq!(seg_names(dir), ["seg-1.log", "seg-4.log"]);
        let seg = dir.join("seg-1.log");
        let mut bytes = fs::read(&seg).unwrap();
        bytes.extend_from_slice(&[0u8; 40]);
        fs::write(&seg, &bytes).unwrap();
        let e = corrupt_load(dir);
        assert!(e.message.contains("seg-1.log"), "{}", e.message);
        assert!(
            e.message.contains("offset 54 fails its checksum"),
            "{}",
            e.message
        );
        assert_eq!(fs::read(&seg).unwrap(), bytes);
        assert_eq!(torn_names(dir), Vec::<String>::new());
    }

    #[test]
    fn flipped_len_bit_in_last_segment_is_corrupt() {
        let tmp = TempDir::new().unwrap();
        {
            let mut s = DocStore::open(tmp.path()).unwrap();
            append_range(&mut s, 1..=5);
        }
        let seg = tmp.path().join("seg-1.log");
        let mut bytes = fs::read(&seg).unwrap();
        bytes[18 + 11] ^= 0x01;
        fs::write(&seg, &bytes).unwrap();
        let e = corrupt_load(tmp.path());
        assert!(e.message.contains("seg-1.log"), "{}", e.message);
        assert!(e.message.contains("offset 18"), "{}", e.message);
        assert!(e.message.contains("seq 3"), "{}", e.message);
        assert_eq!(fs::read(&seg).unwrap(), bytes);
        assert_eq!(torn_names(tmp.path()), Vec::<String>::new());
    }

    #[test]
    fn torn_tail_is_kept_aside() {
        let tmp = TempDir::new().unwrap();
        {
            let mut s = DocStore::open(tmp.path()).unwrap();
            append_range(&mut s, 1..=3);
        }
        let seg = tmp.path().join("seg-1.log");
        let cut = raw_records([4])[..10].to_vec();
        let mut bytes = fs::read(&seg).unwrap();
        bytes.extend_from_slice(&cut);
        fs::write(&seg, &bytes).unwrap();
        let l = DocStore::open(tmp.path()).unwrap().load().unwrap();
        assert!(l.torn);
        assert_eq!(seqs(&l), vec![1, 2, 3]);
        assert_eq!(fs::read(&seg).unwrap(), bytes[..54]);
        assert_eq!(torn_names(tmp.path()), ["seg-1.log.torn-54"]);
        assert_eq!(fs::read(tmp.path().join("seg-1.log.torn-54")).unwrap(), cut);
        let mut s = DocStore::open(tmp.path()).unwrap();
        let l = s.load().unwrap();
        assert!(!l.torn);
        assert_eq!(seqs(&l), vec![1, 2, 3]);
        s.append(4, &payload(4)).unwrap();
        assert_eq!(seqs(&s.load().unwrap()), vec![1, 2, 3, 4]);
    }

    #[test]
    fn segment_name_must_be_digits() {
        ["seg-+7.log", "seg-abc.log", "seg-.log", "seg-7a.log"]
            .iter()
            .for_each(|name| {
                let tmp = TempDir::new().unwrap();
                fs::write(tmp.path().join(name), raw_records([7])).unwrap();
                let e = corrupt_load(tmp.path());
                assert!(e.message.contains(name), "{}", e.message);
            });
    }

    #[test]
    fn segment_first_seq_must_match_its_name() {
        let tmp = TempDir::new().unwrap();
        fs::write(tmp.path().join("seg-5.log"), raw_records([1, 2])).unwrap();
        let e = corrupt_load(tmp.path());
        assert!(e.message.contains("seg-5.log"), "{}", e.message);
        assert!(e.message.contains("named for seq 5"), "{}", e.message);
    }

    #[test]
    fn duplicate_segment_starts_are_corrupt() {
        let tmp = TempDir::new().unwrap();
        fs::write(tmp.path().join("seg-1.log"), raw_records([1])).unwrap();
        fs::write(tmp.path().join("seg-01.log"), raw_records([1])).unwrap();
        let e = corrupt_load(tmp.path());
        assert!(
            e.message.contains("two segments start at seq 1"),
            "{}",
            e.message
        );
    }

    #[test]
    fn empty_earlier_segment_is_corrupt() {
        let tmp = TempDir::new().unwrap();
        fs::write(tmp.path().join("seg-1.log"), b"").unwrap();
        fs::write(tmp.path().join("seg-4.log"), raw_records([4])).unwrap();
        let e = corrupt_load(tmp.path());
        assert!(e.message.contains("seg-1.log"), "{}", e.message);
        assert!(e.message.contains("segment is empty"), "{}", e.message);
    }

    #[test]
    fn bad_snapshot_is_corrupt() {
        let mut short = MAGIC.to_vec();
        short.extend_from_slice(&[0; 7]);
        let mut bad_magic = b"XBS1".to_vec();
        bad_magic.extend_from_slice(&3u64.to_le_bytes());
        [short, bad_magic].iter().for_each(|bytes| {
            let tmp = TempDir::new().unwrap();
            fs::write(tmp.path().join(SNAPSHOT), bytes).unwrap();
            let e = corrupt_load(tmp.path());
            assert!(e.message.contains("snapshot.bin"), "{}", e.message);
        });
    }

    #[test]
    fn seq_must_increase_across_segments() {
        let tmp = TempDir::new().unwrap();
        fs::write(tmp.path().join("seg-1.log"), raw_records([1, 2])).unwrap();
        fs::write(tmp.path().join("seg-2.log"), raw_records([2])).unwrap();
        let e = corrupt_load(tmp.path());
        assert!(e.message.contains("seg-2.log"), "{}", e.message);
        assert!(e.message.contains("seq 2, not after 2"), "{}", e.message);
    }

    #[test]
    fn short_record_in_earlier_segment_is_corrupt() {
        let tmp = TempDir::new().unwrap();
        let mut first = raw_records([1, 2]);
        first.extend_from_slice(&raw_records([3])[..10]);
        fs::write(tmp.path().join("seg-1.log"), &first).unwrap();
        fs::write(tmp.path().join("seg-5.log"), raw_records([5])).unwrap();
        let e = corrupt_load(tmp.path());
        assert!(e.message.contains("seg-1.log"), "{}", e.message);
        assert!(
            e.message.contains("offset 36 is cut short"),
            "{}",
            e.message
        );
        assert_eq!(fs::read(tmp.path().join("seg-1.log")).unwrap(), first);
        assert_eq!(torn_names(tmp.path()), Vec::<String>::new());
    }

    #[test]
    fn list_refuses_unknown_folders() {
        let tmp = TempDir::new().unwrap();
        let docs = tmp.path().join("docs");
        let store = Store::new(docs.clone());
        store.doc("ab12").unwrap();
        fs::create_dir(docs.join("ab12.bad-123")).unwrap();
        fs::write(docs.join("stray.txt"), b"").unwrap();
        fs::write(docs.join(".DS_Store"), b"").unwrap();
        assert_eq!(store.list().unwrap(), ["ab12"]);
        ["ab12 (1)", "ab12.bad-", "ab12.bad-12x", "a b.bad-1"]
            .iter()
            .for_each(|name| {
                fs::create_dir(docs.join(name)).unwrap();
                let e = store.list().unwrap_err();
                assert_eq!(
                    e,
                    CommandError::new("store.foreign", docs.join(name).display().to_string())
                );
                fs::remove_dir(docs.join(name)).unwrap();
            });
        assert_eq!(store.list().unwrap(), ["ab12"]);
    }

    #[test]
    fn set_aside_names_the_second() {
        let tmp = TempDir::new().unwrap();
        let docs = tmp.path().join("docs");
        let store = Store::new(docs.clone());
        append_range(&mut store.doc("P").unwrap().lock().unwrap(), 1..=2);
        store.doc("Q").unwrap();
        let before = fs::read(docs.join("P").join("seg-1.log")).unwrap();
        store.set_aside("P", 1_700_000_000).unwrap();
        assert!(docs.join("P.bad-1700000000").is_dir());
        assert!(!docs.join("P").exists());
        assert_eq!(
            fs::read(docs.join("P.bad-1700000000").join("seg-1.log")).unwrap(),
            before
        );
        assert_eq!(store.list().unwrap(), ["Q"]);

        store.doc("P").unwrap();
        let e = store.set_aside("P", 1_700_000_000).unwrap_err();
        assert_eq!(e.code, "store.io");
        assert!(
            e.message.ends_with("docs/P.bad-1700000000 already exists"),
            "{}",
            e.message
        );
        assert!(docs.join("P").is_dir());
        assert_eq!(store.list().unwrap(), ["P", "Q"]);

        assert_eq!(
            store.set_aside("R", 1_700_000_000).unwrap_err(),
            CommandError::new("store.io", "no document R")
        );
        assert_eq!(store.set_aside("a b", 1).unwrap_err().code, "store.io");
        let l = store.doc("P").unwrap().lock().unwrap().load().unwrap();
        assert_eq!(l.last_seq, 0);
    }

    #[test]
    fn set_aside_keeps_the_entry_when_a_check_fails() {
        let tmp = TempDir::new().unwrap();
        let docs = tmp.path().join("docs");
        let store = Store::new(docs.clone());
        append_range(&mut store.doc("P").unwrap().lock().unwrap(), 1..=2);
        let entry = Arc::downgrade(store.table().unwrap().get("P").unwrap());
        fs::create_dir(docs.join("P.bad-1700000000")).unwrap();
        let e = store.set_aside("P", 1_700_000_000).unwrap_err();
        assert_eq!(e.code, "store.io");
        assert!(e.message.ends_with("already exists"), "{}", e.message);
        let kept = entry.upgrade().expect("the table entry was dropped");
        assert!(Arc::ptr_eq(&store.doc("P").unwrap(), &kept));
        drop(kept);
        store
            .doc("P")
            .unwrap()
            .lock()
            .unwrap()
            .append(3, &payload(3))
            .unwrap();
        assert_eq!(
            seqs(&store.doc("P").unwrap().lock().unwrap().load().unwrap()),
            [1, 2, 3]
        );
        store.set_aside("P", 1_700_000_001).unwrap();
        assert!(docs.join("P.bad-1700000001").join("seg-1.log").is_file());
        assert!(!store.table().unwrap().contains_key("P"));
    }

    #[test]
    fn set_aside_refuses_a_doc_in_use() {
        let tmp = TempDir::new().unwrap();
        let docs = tmp.path().join("docs");
        let store = Store::new(docs.clone());
        let held = store.doc("P").unwrap();
        append_range(&mut held.lock().unwrap(), 1..=2);
        assert_eq!(
            store.set_aside("P", 1_700_000_000).unwrap_err(),
            CommandError::new(
                "store.locked",
                "Plan P is still being saved in this window; try again."
            )
        );
        assert!(docs.join("P").is_dir());
        assert!(!docs.join("P.bad-1700000000").exists());
        assert!(Arc::ptr_eq(&store.doc("P").unwrap(), &held));
        drop(held);
        store.set_aside("P", 1_700_000_000).unwrap();
        assert!(docs.join("P.bad-1700000000").is_dir());
        assert!(!docs.join("P").exists());
    }

    #[test]
    fn set_aside_refuses_locked() {
        let tmp = TempDir::new().unwrap();
        let docs = tmp.path().join("docs");
        let store = Store::new(docs.clone());
        [("P", PLAN_LOCKED), ("local", PLAN_LIST_LOCKED)]
            .iter()
            .for_each(|(id, message)| {
                let dir = docs.join(id);
                spawn_child("hold", &dir, SEGMENT_MAX_BYTES, "", || {
                    assert_eq!(
                        store.set_aside(id, 1_700_000_000).unwrap_err(),
                        CommandError::new("store.locked", *message)
                    );
                    assert!(dir.is_dir());
                });
                assert!(dir.is_dir());
                assert!(!docs.join(format!("{id}.bad-1700000000")).exists());
            });
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
            "roll" => {
                (1..=9).for_each(|seq| ack(&mut s, seq));
                arm();
                ack(&mut s, 10);
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
            let exited = child
                .try_wait()
                .unwrap_or_else(|e| panic!("child {mode}: try_wait failed: {e}"))
                .is_some();
            if exited || start.elapsed() > Duration::from_secs(10) {
                let out = stop_child(child, mode);
                panic!(
                    "child {mode} did not pause within 10 s ({}): {}",
                    out.status,
                    String::from_utf8_lossy(&out.stderr)
                );
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        let checked = std::panic::catch_unwind(std::panic::AssertUnwindSafe(while_paused));
        let out = stop_child(child, mode);
        if let Err(p) = checked {
            std::panic::resume_unwind(p);
        }
        String::from_utf8(out.stdout).unwrap()
    }

    fn stop_child(mut child: std::process::Child, mode: &str) -> std::process::Output {
        let running = child
            .try_wait()
            .unwrap_or_else(|e| panic!("child {mode}: try_wait failed: {e}"))
            .is_none();
        let killed = if running { child.kill() } else { Ok(()) };
        let out = child
            .wait_with_output()
            .unwrap_or_else(|e| panic!("child {mode}: wait failed: {e}"));
        if let Err(e) = killed {
            panic!(
                "child {mode}: kill failed: {e} ({}): {}",
                out.status,
                String::from_utf8_lossy(&out.stderr)
            );
        }
        out
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
    fn kill_mid_roll_keeps_acked_records() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path();
        let acked = acks(&spawn_child("roll", dir, 54, "append-mid", || {}));
        assert_eq!(acked, (1..=9).collect());
        assert_eq!(
            seg_names(dir),
            ["seg-1.log", "seg-10.log", "seg-4.log", "seg-7.log"]
        );
        let before: Vec<Vec<u8>> = ["seg-1.log", "seg-4.log", "seg-7.log"]
            .iter()
            .map(|n| fs::read(dir.join(n)).unwrap())
            .collect();
        {
            let mut s = DocStore::open_with(dir, 54).unwrap();
            let l = s.load().unwrap();
            assert!(l.torn);
            assert_eq!(seqs(&l), (1..=9).collect::<Vec<_>>());
        }
        assert_eq!(seg_names(dir), ["seg-1.log", "seg-4.log", "seg-7.log"]);
        assert_eq!(torn_names(dir), ["seg-10.log.torn-0"]);
        assert_eq!(
            fs::read(dir.join("seg-10.log.torn-0")).unwrap(),
            raw_records([10])[..HEADER + 1]
        );
        let mut s = DocStore::open_with(dir, 54).unwrap();
        assert!(!s.load().unwrap().torn);
        s.fail_next_append = true;
        assert_eq!(s.append(10, &payload(10)).unwrap_err().code, "store.io");
        append_range(&mut s, 10..=11);
        let after: Vec<Vec<u8>> = ["seg-1.log", "seg-4.log", "seg-7.log"]
            .iter()
            .map(|n| fs::read(dir.join(n)).unwrap())
            .collect();
        assert_eq!(after, before);
        assert_eq!(
            seg_names(dir),
            ["seg-1.log", "seg-10.log", "seg-4.log", "seg-7.log"]
        );
        drop(s);
        let l = DocStore::open_with(dir, 54).unwrap().load().unwrap();
        assert!(!l.torn);
        assert_eq!(
            l.records,
            (1..=11).map(|q| (q, payload(q))).collect::<Vec<_>>()
        );
    }

    fn hold_lock(dir: &Path, for_ms: u64) -> std::thread::JoinHandle<()> {
        fs::create_dir_all(dir).unwrap();
        let held = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(dir.join(LOCK))
            .unwrap();
        held.try_lock().unwrap();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(for_ms));
            drop(held);
        })
    }

    #[test]
    fn a_lock_held_briefly_is_waited_out() {
        let tmp = TempDir::new().unwrap();
        let doc = tmp.path().join("P");
        let holder = hold_lock(&doc, 100);
        let start = Instant::now();
        DocStore::open(&doc).unwrap();
        assert!(start.elapsed() >= Duration::from_millis(100));
        holder.join().unwrap();
        let other = tmp.path().join("Q");
        let holder = hold_lock(&other, 100);
        lock_dir(&other, "Q").unwrap();
        holder.join().unwrap();
    }

    #[test]
    fn a_lock_held_longer_than_the_wait_is_locked() {
        let tmp = TempDir::new().unwrap();
        let doc = tmp.path().join("P");
        let holder = hold_lock(&doc, 1500);
        let start = Instant::now();
        let Err(e) = DocStore::open(&doc) else {
            panic!("opened a store whose lock is held");
        };
        let waited = start.elapsed();
        assert_eq!(e, locked_error("P"));
        assert!(waited >= LOCK_WAIT, "{waited:?}");
        assert!(waited < Duration::from_millis(1500), "{waited:?}");
        let start = Instant::now();
        assert_eq!(lock_dir(&doc, "P").unwrap_err(), locked_error("P"));
        assert!(start.elapsed() >= LOCK_WAIT);
        holder.join().unwrap();
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
