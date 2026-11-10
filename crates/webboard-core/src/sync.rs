use std::collections::HashMap;
use std::fs;
use std::io::ErrorKind;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use reqwest::header::{HeaderMap, AUTHORIZATION, RETRY_AFTER};
use reqwest::{RequestBuilder, Response, StatusCode, Url};
use serde::de::{DeserializeOwned, IgnoredAny};
use serde::{Deserialize, Serialize};

use crate::error::CommandError;
use crate::fsutil::replace_file;
use crate::net::{client_builder, innermost};

const HOST: &str = "webboard.rokass.org";
const FILE: &str = "sync.json";
const TIMEOUT: Duration = Duration::from_secs(10);

const BAD_ADDRESS: &str = "The server address must start with https://";
const OTHER_HOST: &str = "This build syncs only with webboard.rokass.org.";
const NOT_JOINED: &str = "This device is not in a space yet. Set up sync or join with a code.";
const MISSING: &str = "This device has no sync key. Join the space again with a pairing code.";
const REVOKED: &str = "This device was removed from the space.";
const NOT_CONFIGURED: &str =
    "Sync is not set up on the server: its owner runs wrangler secret put SETUP_SECRET.";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SyncError {
    pub code: &'static str,
    pub message: String,
}

impl SyncError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl From<SyncError> for CommandError {
    fn from(e: SyncError) -> Self {
        CommandError::new(e.code, e.message)
    }
}

pub trait TokenStore: Send + Sync {
    fn probe(&self) -> Result<(), SyncError>;
    fn get(&self, space: &str) -> Result<Option<String>, SyncError>;
    fn put(&self, space: &str, token: &str) -> Result<(), SyncError>;
    fn delete(&self, space: &str) -> Result<(), SyncError>;
}

#[derive(Default)]
pub struct MemoryTokens {
    tokens: Mutex<HashMap<String, String>>,
}

impl MemoryTokens {
    pub fn new() -> Self {
        Self::default()
    }

    fn with<T>(&self, f: impl FnOnce(&mut HashMap<String, String>) -> T) -> Result<T, SyncError> {
        let mut tokens = self.tokens.lock().map_err(|_| {
            SyncError::new(
                "keychain.io",
                "The in-memory token store is unusable after an earlier panic.",
            )
        })?;
        Ok(f(&mut tokens))
    }
}

impl TokenStore for MemoryTokens {
    fn probe(&self) -> Result<(), SyncError> {
        self.with(|_| ())
    }

    fn get(&self, space: &str) -> Result<Option<String>, SyncError> {
        self.with(|t| t.get(space).cloned())
    }

    fn put(&self, space: &str, token: &str) -> Result<(), SyncError> {
        self.with(|t| {
            t.insert(space.to_string(), token.to_string());
        })
    }

    fn delete(&self, space: &str) -> Result<(), SyncError> {
        self.with(|t| {
            t.remove(space);
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpaceInfo {
    pub server: String,
    pub space_id: String,
    pub device_id: String,
    pub device_name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatus {
    pub space: Option<SpaceInfo>,
    pub revoked: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairCode {
    pub code: String,
    pub expires_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Ticket {
    pub ticket: String,
    pub expires_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceEntry {
    pub id: String,
    pub name: String,
    pub created_at: i64,
    pub last_seen_at: i64,
    pub current: bool,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Stored {
    #[serde(flatten)]
    space: SpaceInfo,
    revoked: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Enrolled {
    space_id: String,
    device_id: String,
    token: String,
}

#[derive(Deserialize)]
struct Devices {
    devices: Vec<DeviceEntry>,
}

#[derive(Deserialize)]
struct ErrorBody {
    error: String,
    message: String,
}

#[derive(Clone, Copy)]
enum Caller<'a> {
    Setup,
    Claim,
    Member(&'a Member),
}

#[derive(Clone)]
struct Member {
    server: Url,
    space_id: String,
    token: String,
}

pub fn http_client() -> Result<reqwest::Client, SyncError> {
    client_builder().build().map_err(|e| {
        SyncError::new(
            "sync.http",
            format!("Could not start the HTTP client: {}.", innermost(&e)),
        )
    })
}

fn http(message: impl Into<String>) -> SyncError {
    SyncError::new("sync.http", message)
}

fn not_joined() -> SyncError {
    SyncError::new("sync.not_joined", NOT_JOINED)
}

fn save_failed(e: impl std::fmt::Display) -> SyncError {
    SyncError::new("sync.io", format!("Could not save the sync state: {e}"))
}

fn read_failed(detail: impl std::fmt::Display) -> SyncError {
    SyncError::new(
        "sync.io",
        format!("Could not read the sync state: {detail}"),
    )
}

fn aside_failed(detail: impl std::fmt::Display) -> SyncError {
    SyncError::new(
        "sync.io",
        format!("Could not set the sync state aside: {detail}"),
    )
}

fn test_server(url: &Url) -> bool {
    cfg!(test)
        && url.scheme() == "http"
        && url.host_str() == Some("127.0.0.1")
        && url.port().is_some()
}

fn server_url(server: &str) -> Result<Url, SyncError> {
    let url = Url::parse(server).map_err(|_| http(BAD_ADDRESS))?;
    let plain = url.username().is_empty()
        && url.password().is_none()
        && url.query().is_none()
        && url.fragment().is_none()
        && url.path() == "/";
    if !plain {
        return Err(http(BAD_ADDRESS));
    }
    if test_server(&url) {
        return Ok(url);
    }
    if url.scheme() != "https" {
        return Err(http(BAD_ADDRESS));
    }
    if url.host_str() != Some(HOST) || url.port().is_some() {
        return Err(SyncError::new("sync.host", OTHER_HOST));
    }
    Ok(url)
}

fn endpoint(server: &Url, segments: &[&str]) -> Result<Url, SyncError> {
    let mut url = server.clone();
    url.path_segments_mut()
        .map_err(|()| http(BAD_ADDRESS))?
        .clear()
        .extend(segments);
    Ok(url)
}

fn host_of(url: &Url) -> String {
    url.host_str()
        .map_or_else(|| url.to_string(), ToString::to_string)
}

fn timed_out(host: &str, timeout: Duration) -> SyncError {
    http(format!(
        "{host} did not answer within {} s.",
        timeout.as_secs_f64()
    ))
}

fn transport(url: &Url, timeout: Duration, e: &reqwest::Error) -> SyncError {
    let host = host_of(url);
    if e.is_timeout() {
        timed_out(&host, timeout)
    } else if e.is_connect() {
        http(format!("Could not reach {host}: {}.", innermost(e)))
    } else {
        http(format!(
            "The exchange with {host} failed: {}.",
            innermost(e)
        ))
    }
}

fn unexpected(status: StatusCode) -> SyncError {
    http(format!(
        "Server answered {} with an unexpected response.",
        status.as_u16()
    ))
}

const SHOWN_BODY_CHARS: usize = 300;

fn forbidden(message: impl Into<String>) -> SyncError {
    SyncError::new("sync.forbidden", message)
}

fn forbidden_text(bytes: &[u8]) -> SyncError {
    let text = String::from_utf8_lossy(bytes);
    let text = text.trim();
    if text.is_empty() {
        return forbidden("Server answered 403 with an unexpected response.");
    }
    let shown = match text.char_indices().nth(SHOWN_BODY_CHARS) {
        Some((cut, _)) => format!("{}…", &text[..cut]),
        None => text.to_string(),
    };
    forbidden(format!("Server answered 403: {shown}"))
}

fn retry_after(headers: &HeaderMap) -> Option<u64> {
    headers
        .get(RETRY_AFTER)?
        .to_str()
        .ok()?
        .trim()
        .parse::<u64>()
        .ok()
}

fn rate_limited(message: Option<String>, retry: Option<u64>) -> SyncError {
    let wait = match retry.map(|secs| secs.div_ceil(60).max(1)) {
        Some(1) => "Try again in 1 minute.".to_string(),
        Some(n) => format!("Try again in {n} minutes."),
        None => "Try again later.".to_string(),
    };
    SyncError::new(
        "sync.rate_limited",
        match message.filter(|m| !m.trim().is_empty()) {
            Some(m) => format!("{m} {wait}"),
            None => wait,
        },
    )
}

fn unix_secs() -> Result<u64, SyncError> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .map_err(|e| aside_failed(format!("the clock is before 1970: {e}")))
}

struct Local {
    dir: PathBuf,
    tokens: Arc<dyn TokenStore>,
    writing: Mutex<()>,
}

impl Local {
    fn guard(&self) -> Result<std::sync::MutexGuard<'_, ()>, SyncError> {
        self.writing.lock().map_err(|_| {
            SyncError::new(
                "sync.io",
                "The sync state is unusable after an earlier panic; restart WebBoard.",
            )
        })
    }

    fn read(&self) -> Result<Option<Stored>, SyncError> {
        let bytes = match fs::read(self.dir.join(FILE)) {
            Ok(bytes) => bytes,
            Err(e) if e.kind() == ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(read_failed(e)),
        };
        serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(read_failed)
    }

    fn write(&self, stored: &Stored) -> Result<(), SyncError> {
        let json = serde_json::to_vec(stored).map_err(save_failed)?;
        replace_file(&self.dir, FILE, &json).map_err(save_failed)
    }

    fn status(&self) -> Result<SyncStatus, SyncError> {
        Ok(match self.read()? {
            Some(stored) => SyncStatus {
                space: Some(stored.space),
                revoked: stored.revoked,
            },
            None => SyncStatus {
                space: None,
                revoked: false,
            },
        })
    }

    fn vacant(&self, secs: u64) -> Result<PathBuf, SyncError> {
        let names = std::iter::once(format!("sync.bad-{secs}.json"))
            .chain((1_u64..).map(|n| format!("sync.bad-{secs}-{n}.json")));
        names
            .map(|name| self.dir.join(name))
            .find_map(|path| match fs::symlink_metadata(&path) {
                Ok(_) => None,
                Err(e) if e.kind() == ErrorKind::NotFound => Some(Ok(path)),
                Err(e) => Some(Err(aside_failed(e))),
            })
            .unwrap_or_else(|| Err(aside_failed("no free name is left")))
    }

    fn reset(&self) -> Result<(), SyncError> {
        let _guard = self.guard()?;
        let current = self.dir.join(FILE);
        match fs::symlink_metadata(&current) {
            Ok(_) => {}
            Err(e) if e.kind() == ErrorKind::NotFound => return Ok(()),
            Err(e) => return Err(aside_failed(e)),
        }
        let aside = self.vacant(unix_secs()?)?;
        fs::rename(current, aside).map_err(aside_failed)
    }

    fn revoke(&self, only: Option<&Member>) -> Result<bool, SyncError> {
        let _guard = self.guard()?;
        let mut stored = match (self.read()?, only) {
            (Some(stored), Some(m)) if stored.space.space_id != m.space_id => return Ok(false),
            (Some(stored), Some(_)) if stored.revoked => return Ok(true),
            (None, Some(_)) => return Ok(false),
            (None, None) => return Err(not_joined()),
            (Some(stored), _) => stored,
        };
        if let Some(m) = only {
            if self.tokens.get(&m.space_id)?.as_deref() != Some(m.token.as_str()) {
                return Ok(false);
            }
        }
        stored.revoked = true;
        self.write(&stored)?;
        self.tokens.delete(&stored.space.space_id)?;
        Ok(true)
    }

    fn member(&self) -> Result<Member, SyncError> {
        let stored = self.read()?.ok_or_else(not_joined)?;
        if stored.revoked {
            return Err(SyncError::new("sync.revoked", REVOKED));
        }
        let server = server_url(&stored.space.server).map_err(|e| {
            read_failed(format!(
                "its server address {} is refused: {}",
                stored.space.server, e.message
            ))
        })?;
        let token = self
            .tokens
            .get(&stored.space.space_id)?
            .ok_or_else(|| SyncError::new("keychain.missing", MISSING))?;
        Ok(Member {
            server,
            space_id: stored.space.space_id,
            token,
        })
    }

    fn enrol(&self, space: SpaceInfo, token: &str) -> Result<SpaceInfo, SyncError> {
        let _guard = self.guard()?;
        let previous = self.read()?.map(|s| s.space.space_id);
        self.tokens.put(&space.space_id, token)?;
        let saved = self.write(&Stored {
            space: space.clone(),
            revoked: false,
        });
        if let Err(e) = saved {
            return Err(match self.tokens.delete(&space.space_id) {
                Ok(()) => e,
                Err(d) => SyncError::new(
                    e.code,
                    format!(
                        "{} The device token could not be removed: {}",
                        e.message, d.message
                    ),
                ),
            });
        }
        if let Some(old) = previous.filter(|old| *old != space.space_id) {
            self.tokens.delete(&old).map_err(|d| {
                SyncError::new(
                    "keychain.io",
                    format!(
                        "Joined space {}, but the device token of space {old} could not be removed: {}",
                        space.space_id, d.message
                    ),
                )
            })?;
        }
        Ok(space)
    }
}

pub struct SyncClient {
    local: Arc<Local>,
    http: reqwest::Client,
    timeout: Duration,
}

impl SyncClient {
    pub fn new(dir: PathBuf, tokens: Arc<dyn TokenStore>, http: reqwest::Client) -> Self {
        Self {
            local: Arc::new(Local {
                dir,
                tokens,
                writing: Mutex::new(()),
            }),
            http,
            timeout: TIMEOUT,
        }
    }

    #[cfg(test)]
    fn with_timeout(self, timeout: Duration) -> Self {
        Self { timeout, ..self }
    }

    async fn off<T: Send + 'static>(
        &self,
        work: impl FnOnce(&Local) -> Result<T, SyncError> + Send + 'static,
    ) -> Result<T, SyncError> {
        let local = Arc::clone(&self.local);
        tokio::task::spawn_blocking(move || work(&local))
            .await
            .map_err(|e| SyncError::new("sync.io", format!("The sync state task stopped: {e}")))?
    }

    pub async fn status(&self) -> Result<SyncStatus, SyncError> {
        self.off(Local::status).await
    }

    pub async fn reset(&self) -> Result<(), SyncError> {
        self.off(Local::reset).await
    }

    pub async fn mark_revoked(&self) -> Result<(), SyncError> {
        self.off(|l| l.revoke(None).map(|_| ())).await
    }

    async fn exchange<T: DeserializeOwned>(
        &self,
        url: &Url,
        request: RequestBuilder,
        caller: Caller<'_>,
    ) -> Result<T, SyncError> {
        let response = request
            .timeout(self.timeout)
            .send()
            .await
            .map_err(|e| transport(url, self.timeout, &e))?;
        let status = response.status();
        if status.is_success() {
            let bytes = response
                .bytes()
                .await
                .map_err(|e| transport(url, self.timeout, &e))?;
            return serde_json::from_slice(&bytes).map_err(|e| {
                http(format!(
                    "Server answered {} with an unexpected response: {e}",
                    status.as_u16()
                ))
            });
        }
        Err(self.refusal(url, response, caller).await)
    }

    async fn refusal(&self, url: &Url, response: Response, caller: Caller<'_>) -> SyncError {
        let status = response.status();
        let retry = retry_after(response.headers());
        let bytes = match response.bytes().await {
            Ok(bytes) => bytes,
            Err(e) => return transport(url, self.timeout, &e),
        };
        let body = serde_json::from_slice::<ErrorBody>(&bytes).ok();
        if status == StatusCode::TOO_MANY_REQUESTS {
            return rate_limited(body.map(|b| b.message), retry);
        }
        let Some(body) = body else {
            return match status {
                StatusCode::FORBIDDEN => forbidden_text(&bytes),
                _ => unexpected(status),
            };
        };
        let answered = |b: &ErrorBody| {
            http(format!(
                "Server answered {} {}: {}",
                status.as_u16(),
                b.error,
                b.message
            ))
        };
        match (status.as_u16(), caller) {
            (401, _) => SyncError::new("sync.unauthorized", body.message),
            (403, Caller::Member(member)) if body.error == "revoked" => {
                let member = member.clone();
                match self.off(move |l| l.revoke(Some(&member))).await {
                    Ok(true) => SyncError::new("sync.revoked", body.message),
                    Ok(false) => answered(&body),
                    Err(e) => e,
                }
            }
            (403, _) => forbidden(format!(
                "Server answered 403 {}: {}",
                body.error, body.message
            )),
            (404, Caller::Claim) => SyncError::new("sync.bad_code", body.message),
            (503, _) if body.error == "not_configured" => {
                SyncError::new("sync.not_configured", NOT_CONFIGURED)
            }
            _ => answered(&body),
        }
    }

    async fn enrol(
        &self,
        server: &Url,
        enrolled: Enrolled,
        device_id: &str,
        device_name: &str,
    ) -> Result<SpaceInfo, SyncError> {
        if enrolled.device_id != device_id {
            return Err(http(format!(
                "The server enrolled device {} instead of {device_id}.",
                enrolled.device_id
            )));
        }
        let space = SpaceInfo {
            server: server.origin().ascii_serialization(),
            space_id: enrolled.space_id,
            device_id: device_id.to_string(),
            device_name: device_name.to_string(),
        };
        let token = enrolled.token;
        self.off(move |l| l.enrol(space, &token)).await
    }

    async fn probe(&self) -> Result<(), SyncError> {
        self.off(|l| l.tokens.probe()).await
    }

    async fn readable(&self) -> Result<(), SyncError> {
        self.off(|l| l.read().map(|_| ())).await
    }

    pub async fn setup(
        &self,
        server: &str,
        secret: &str,
        device_id: &str,
        device_name: &str,
    ) -> Result<SpaceInfo, SyncError> {
        let server = server_url(server)?;
        self.readable().await?;
        self.probe().await?;
        let url = endpoint(&server, &["space"])?;
        let request = self
            .http
            .post(url.clone())
            .header(AUTHORIZATION, format!("Bearer {secret}"))
            .json(&serde_json::json!({ "deviceId": device_id, "deviceName": device_name }));
        let enrolled: Enrolled = self.exchange(&url, request, Caller::Setup).await?;
        self.enrol(&server, enrolled, device_id, device_name).await
    }

    pub async fn pair_join(
        &self,
        server: &str,
        code: &str,
        device_id: &str,
        device_name: &str,
    ) -> Result<SpaceInfo, SyncError> {
        let server = server_url(server)?;
        self.readable().await?;
        self.probe().await?;
        let url = endpoint(&server, &["pair", "claim"])?;
        let request = self.http.post(url.clone()).json(&serde_json::json!({
            "code": code,
            "deviceId": device_id,
            "deviceName": device_name
        }));
        let enrolled: Enrolled = self.exchange(&url, request, Caller::Claim).await?;
        self.enrol(&server, enrolled, device_id, device_name).await
    }

    async fn member(&self) -> Result<Member, SyncError> {
        self.off(Local::member).await
    }

    fn authorised(&self, member: &Member, method: reqwest::Method, url: &Url) -> RequestBuilder {
        self.http
            .request(method, url.clone())
            .header(AUTHORIZATION, format!("Bearer {}", member.token))
    }

    pub async fn pair_code(&self) -> Result<PairCode, SyncError> {
        let member = self.member().await?;
        let url = endpoint(&member.server, &["pair"])?;
        let request = self.authorised(&member, reqwest::Method::POST, &url);
        self.exchange(&url, request, Caller::Member(&member)).await
    }

    pub async fn ticket(&self, doc: &str) -> Result<Ticket, SyncError> {
        let member = self.member().await?;
        let url = endpoint(&member.server, &["ticket"])?;
        let request = self
            .authorised(&member, reqwest::Method::POST, &url)
            .json(&serde_json::json!({ "doc": doc }));
        self.exchange(&url, request, Caller::Member(&member)).await
    }

    pub async fn devices(&self) -> Result<Vec<DeviceEntry>, SyncError> {
        let member = self.member().await?;
        let url = endpoint(&member.server, &["devices"])?;
        let request = self.authorised(&member, reqwest::Method::GET, &url);
        let list: Devices = self
            .exchange(&url, request, Caller::Member(&member))
            .await?;
        Ok(list.devices)
    }

    pub async fn remove_device(&self, id: &str) -> Result<(), SyncError> {
        let member = self.member().await?;
        let url = endpoint(&member.server, &["devices", id])?;
        let request = self.authorised(&member, reqwest::Method::DELETE, &url);
        let _: IgnoredAny = self
            .exchange(&url, request, Caller::Member(&member))
            .await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use mockito::{Matcher, Mock, Server, ServerGuard};
    use serde_json::{json, Value};
    use std::fs;
    use std::path::Path;
    use std::sync::Arc;
    use tempfile::TempDir;

    const SPACE: &str = "sp000000000";
    const DEVICE: &str = "devA0000000";
    const TOKEN: &str = "tok_SECRET_123";
    const NOT_JOINED: &str = "This device is not in a space yet. Set up sync or join with a code.";
    const MISSING: &str = "This device has no sync key. Join the space again with a pairing code.";
    const NOT_CONFIGURED: &str =
        "Sync is not set up on the server: its owner runs wrangler secret put SETUP_SECRET.";
    const SERVER_NOT_CONFIGURED: &str =
        "The server has no setup secret. Run wrangler secret put SETUP_SECRET.";
    const REVOKED: &str = "This device was removed from the space.";
    const UNKNOWN: &str = "This device is not known to the space. Set up sync again.";

    struct Fixture {
        dir: TempDir,
        tokens: Arc<MemoryTokens>,
        server: ServerGuard,
    }

    impl Fixture {
        async fn new() -> Self {
            Self {
                dir: TempDir::new().expect("temp dir"),
                tokens: Arc::new(MemoryTokens::new()),
                server: Server::new_async().await,
            }
        }

        fn client(&self) -> SyncClient {
            SyncClient::new(
                self.dir.path().to_path_buf(),
                self.tokens.clone(),
                reqwest::Client::new(),
            )
        }

        fn url(&self) -> String {
            self.server.url()
        }

        fn space(&self) -> SpaceInfo {
            SpaceInfo {
                server: self.url(),
                space_id: SPACE.into(),
                device_id: DEVICE.into(),
                device_name: "Mac".into(),
            }
        }

        fn join(&self) {
            fs::write(
                self.dir.path().join("sync.json"),
                json!({
                    "server": self.url(),
                    "spaceId": SPACE,
                    "deviceId": DEVICE,
                    "deviceName": "Mac",
                    "revoked": false
                })
                .to_string(),
            )
            .expect("write sync.json");
        }

        fn join_with_token(&self) {
            self.join();
            self.tokens.put(SPACE, TOKEN).expect("store the token");
        }

        fn sync_json(&self) -> Option<Vec<u8>> {
            match fs::read(self.dir.path().join("sync.json")) {
                Ok(bytes) => Some(bytes),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
                Err(e) => panic!("read sync.json: {e}"),
            }
        }

        fn token(&self) -> Option<String> {
            self.tokens.get(SPACE).expect("read the memory token")
        }

        async fn nothing(&mut self) -> Vec<Mock> {
            let mut mocks = Vec::new();
            for method in ["GET", "POST", "DELETE"] {
                mocks.push(
                    self.server
                        .mock(method, Matcher::Any)
                        .expect(0)
                        .create_async()
                        .await,
                );
            }
            mocks
        }

        async fn answer(&mut self, method: &str, path: &str, status: usize, body: Value) -> Mock {
            self.server
                .mock(method, path)
                .with_status(status)
                .with_header("content-type", "application/json")
                .with_body(body.to_string())
                .create_async()
                .await
        }
    }

    async fn assert_all(mocks: Vec<Mock>) {
        for m in mocks {
            m.assert_async().await;
        }
    }

    fn err(code: &'static str, message: &str) -> SyncError {
        SyncError {
            code,
            message: message.to_string(),
        }
    }

    fn enrolled(token: &str) -> Value {
        json!({ "spaceId": SPACE, "deviceId": DEVICE, "token": token })
    }

    struct ReadOnly<'a>(&'a Path);

    impl<'a> ReadOnly<'a> {
        fn new(dir: &'a Path) -> Self {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(dir, fs::Permissions::from_mode(0o555)).expect("chmod 555");
            Self(dir)
        }
    }

    impl Drop for ReadOnly<'_> {
        fn drop(&mut self) {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(self.0, fs::Permissions::from_mode(0o755)).expect("chmod 755");
        }
    }

    struct BrokenKeychain;

    impl TokenStore for BrokenKeychain {
        fn probe(&self) -> Result<(), SyncError> {
            Err(err("keychain.unavailable", "no keychain here"))
        }
        fn get(&self, _space: &str) -> Result<Option<String>, SyncError> {
            Err(err("keychain.unavailable", "no keychain here"))
        }
        fn put(&self, _space: &str, _token: &str) -> Result<(), SyncError> {
            Err(err("keychain.unavailable", "no keychain here"))
        }
        fn delete(&self, _space: &str) -> Result<(), SyncError> {
            Err(err("keychain.unavailable", "no keychain here"))
        }
    }

    fn bad_files(dir: &Path) -> Vec<String> {
        fs::read_dir(dir)
            .expect("read the dir")
            .map(|e| {
                e.expect("dir entry")
                    .file_name()
                    .to_string_lossy()
                    .into_owned()
            })
            .filter(|name| {
                name.strip_prefix("sync.bad-")
                    .and_then(|rest| rest.strip_suffix(".json"))
                    .is_some_and(|rest| {
                        let digits =
                            |d: &str| !d.is_empty() && d.bytes().all(|b| b.is_ascii_digit());
                        match rest.split_once('-') {
                            Some((secs, n)) => digits(secs) && digits(n),
                            None => digits(rest),
                        }
                    })
            })
            .collect()
    }

    #[tokio::test]
    async fn the_secret_goes_only_as_bearer() {
        let mut f = Fixture::new().await;
        let m = f
            .server
            .mock("POST", "/space")
            .match_header("authorization", "Bearer s3cr3t")
            .match_body(Matcher::Json(
                json!({ "deviceId": DEVICE, "deviceName": "Mac" }),
            ))
            .with_status(200)
            .with_body(enrolled(TOKEN).to_string())
            .expect(1)
            .create_async()
            .await;
        let space = f
            .client()
            .setup(&f.url(), "s3cr3t", DEVICE, "Mac")
            .await
            .expect("setup");
        m.assert_async().await;
        assert_eq!(space, f.space());
        let stored = String::from_utf8(f.sync_json().expect("sync.json")).expect("utf-8");
        assert!(!stored.contains("s3cr3t"), "{stored}");
        assert_eq!(
            f.client().status().await.expect("status"),
            SyncStatus {
                space: Some(f.space()),
                revoked: false
            }
        );
    }

    #[tokio::test]
    async fn the_claim_carries_this_devices_id() {
        let mut f = Fixture::new().await;
        let m = f
            .server
            .mock("POST", "/pair/claim")
            .match_header("authorization", Matcher::Missing)
            .match_body(Matcher::Json(
                json!({ "code": "ABCD2345", "deviceId": DEVICE, "deviceName": "Mac" }),
            ))
            .with_status(200)
            .with_body(enrolled(TOKEN).to_string())
            .expect(1)
            .create_async()
            .await;
        let space = f
            .client()
            .pair_join(&f.url(), "ABCD2345", DEVICE, "Mac")
            .await
            .expect("pair_join");
        m.assert_async().await;
        assert_eq!(space, f.space());
        assert_eq!(f.token().as_deref(), Some(TOKEN));
    }

    #[tokio::test]
    async fn the_token_stays_in_the_keychain() {
        let mut f = Fixture::new().await;
        f.answer("POST", "/space", 200, enrolled(TOKEN)).await;
        let space = f
            .client()
            .setup(&f.url(), "s3cr3t", DEVICE, "Mac")
            .await
            .expect("setup");
        f.answer(
            "POST",
            "/pair",
            200,
            json!({ "code": "ABCD2345", "expiresAt": 1_700_000_600_000_i64 }),
        )
        .await;
        f.answer(
            "POST",
            "/ticket",
            200,
            json!({ "ticket": "tk_1", "expiresAt": 1_700_000_060_000_i64 }),
        )
        .await;
        f.answer(
            "GET",
            "/devices",
            200,
            json!({ "devices": [{ "id": DEVICE, "name": "Mac", "createdAt": 1, "lastSeenAt": 2, "current": true }] }),
        )
        .await;
        let client = f.client();
        let code = client.pair_code().await.expect("pair_code");
        let ticket = client.ticket("ix-sp000000000").await.expect("ticket");
        let devices = client.devices().await.expect("devices");
        let status = client.status().await.expect("status");
        assert_eq!(
            code,
            PairCode {
                code: "ABCD2345".into(),
                expires_at: 1_700_000_600_000
            }
        );
        assert_eq!(
            ticket,
            Ticket {
                ticket: "tk_1".into(),
                expires_at: 1_700_000_060_000
            }
        );
        assert_eq!(
            devices,
            vec![DeviceEntry {
                id: DEVICE.into(),
                name: "Mac".into(),
                created_at: 1,
                last_seen_at: 2,
                current: true
            }]
        );
        let jsons = [
            serde_json::to_string(&space).expect("json"),
            serde_json::to_string(&code).expect("json"),
            serde_json::to_string(&ticket).expect("json"),
            serde_json::to_string(&devices).expect("json"),
            serde_json::to_string(&status).expect("json"),
            String::from_utf8(f.sync_json().expect("sync.json")).expect("utf-8"),
        ];
        jsons
            .iter()
            .for_each(|j| assert!(!j.contains(TOKEN), "the token leaked into {j}"));
        assert_eq!(
            serde_json::to_value(&space).expect("json"),
            json!({ "server": f.url(), "spaceId": SPACE, "deviceId": DEVICE, "deviceName": "Mac" })
        );
        assert_eq!(
            serde_json::to_value(&status).expect("json"),
            json!({ "space": { "server": f.url(), "spaceId": SPACE, "deviceId": DEVICE, "deviceName": "Mac" }, "revoked": false })
        );
        assert_eq!(
            serde_json::to_value(&code).expect("json"),
            json!({ "code": "ABCD2345", "expiresAt": 1_700_000_600_000_i64 })
        );
        assert_eq!(
            serde_json::to_value(&devices).expect("json"),
            json!([{ "id": DEVICE, "name": "Mac", "createdAt": 1, "lastSeenAt": 2, "current": true }])
        );
        assert_eq!(f.token().as_deref(), Some(TOKEN));
    }

    #[tokio::test]
    async fn token_using_commands_send_the_token_as_bearer() {
        let mut f = Fixture::new().await;
        f.join_with_token();
        let bearer = format!("Bearer {TOKEN}");
        let ticket = f
            .server
            .mock("POST", "/ticket")
            .match_header("authorization", bearer.as_str())
            .match_body(Matcher::Json(json!({ "doc": "ix-sp000000000" })))
            .with_status(200)
            .with_body(json!({ "ticket": "tk_1", "expiresAt": 5 }).to_string())
            .expect(1)
            .create_async()
            .await;
        let remove = f
            .server
            .mock("DELETE", "/devices/dev00000000")
            .match_header("authorization", bearer.as_str())
            .with_status(200)
            .with_body(json!({ "closed": 1 }).to_string())
            .expect(1)
            .create_async()
            .await;
        let client = f.client();
        client.ticket("ix-sp000000000").await.expect("ticket");
        client
            .remove_device("dev00000000")
            .await
            .expect("remove_device");
        ticket.assert_async().await;
        remove.assert_async().await;
    }

    #[tokio::test]
    async fn the_probe_runs_before_any_request() {
        let mut f = Fixture::new().await;
        let mocks = f.nothing().await;
        let client = SyncClient::new(
            f.dir.path().to_path_buf(),
            Arc::new(BrokenKeychain),
            reqwest::Client::new(),
        );
        assert_eq!(
            client.setup(&f.url(), "s3cr3t", DEVICE, "Mac").await,
            Err(err("keychain.unavailable", "no keychain here"))
        );
        assert_eq!(
            client.pair_join(&f.url(), "ABCD2345", DEVICE, "Mac").await,
            Err(err("keychain.unavailable", "no keychain here"))
        );
        assert_all(mocks).await;
        assert_eq!(f.sync_json(), None);
    }

    #[tokio::test]
    async fn a_missing_token_is_keychain_missing() {
        let mut f = Fixture::new().await;
        f.join();
        let mocks = f.nothing().await;
        let client = f.client();
        let missing = Err(err("keychain.missing", MISSING));
        assert_eq!(
            client.ticket("ix-sp000000000").await.map(|_| ()),
            missing.clone()
        );
        assert_eq!(client.pair_code().await.map(|_| ()), missing.clone());
        assert_eq!(client.devices().await.map(|_| ()), missing.clone());
        assert_eq!(client.remove_device("dev00000000").await, missing);
        assert_all(mocks).await;
        assert_eq!(
            client.status().await,
            Ok(SyncStatus {
                space: Some(f.space()),
                revoked: false
            })
        );
    }

    #[tokio::test]
    async fn a_device_not_in_a_space_is_sync_not_joined() {
        let mut f = Fixture::new().await;
        let mocks = f.nothing().await;
        let client = f.client();
        let not_joined = Err(err("sync.not_joined", NOT_JOINED));
        assert_eq!(client.pair_code().await.map(|_| ()), not_joined.clone());
        assert_eq!(
            client.ticket("ix-sp000000000").await.map(|_| ()),
            not_joined.clone()
        );
        assert_eq!(client.devices().await.map(|_| ()), not_joined.clone());
        assert_eq!(
            client.remove_device("dev00000000").await,
            not_joined.clone()
        );
        assert_eq!(client.mark_revoked().await, not_joined);
        assert_all(mocks).await;
        assert_eq!(
            client.status().await,
            Ok(SyncStatus {
                space: None,
                revoked: false
            })
        );
    }

    #[tokio::test]
    async fn mark_revoked_persists_and_deletes_the_token() {
        let f = Fixture::new().await;
        f.join_with_token();
        let client = f.client();
        client.mark_revoked().await.expect("mark_revoked");
        let revoked = SyncStatus {
            space: Some(f.space()),
            revoked: true,
        };
        assert_eq!(client.status().await, Ok(revoked.clone()));
        assert_eq!(f.token(), None);
        assert_eq!(f.client().status().await, Ok(revoked));
    }

    #[tokio::test]
    async fn a_revoked_device_makes_no_request() {
        let mut f = Fixture::new().await;
        f.join_with_token();
        f.client().mark_revoked().await.expect("mark_revoked");
        let mocks = f.nothing().await;
        assert_eq!(
            f.client().ticket("ix-sp000000000").await.map(|_| ()),
            Err(err("sync.revoked", REVOKED))
        );
        assert_all(mocks).await;
    }

    #[tokio::test]
    async fn a_corrupt_sync_json_is_sync_io() {
        let mut f = Fixture::new().await;
        fs::write(f.dir.path().join("sync.json"), "{").expect("write");
        let mocks = f.nothing().await;
        let e = f.client().status().await.expect_err("a corrupt sync.json");
        assert_eq!(e.code, "sync.io");
        assert!(
            e.message.starts_with("Could not read the sync state: "),
            "{}",
            e.message
        );
        assert_all(mocks).await;
    }

    #[tokio::test]
    async fn reset_sets_the_sync_state_aside() {
        let mut f = Fixture::new().await;
        fs::write(f.dir.path().join("sync.json"), "{").expect("write");
        f.tokens.put(SPACE, TOKEN).expect("put");
        let mocks = f.nothing().await;
        let client = f.client();
        assert_eq!(client.reset().await, Ok(()));
        assert_eq!(f.sync_json(), None);
        let bad = bad_files(f.dir.path());
        assert_eq!(bad.len(), 1, "{bad:?}");
        assert_eq!(
            fs::read(f.dir.path().join(&bad[0])).expect("read"),
            b"{".to_vec()
        );
        assert_eq!(
            client.status().await,
            Ok(SyncStatus {
                space: None,
                revoked: false
            })
        );
        assert_eq!(f.token().as_deref(), Some(TOKEN));
        assert_eq!(client.reset().await, Ok(()));
        assert_eq!(bad_files(f.dir.path()).len(), 1);
        assert_all(mocks).await;
    }

    #[tokio::test]
    async fn a_failed_reset_is_sync_io() {
        let f = Fixture::new().await;
        fs::write(f.dir.path().join("sync.json"), "{").expect("write");
        let e = {
            let _ro = ReadOnly::new(f.dir.path());
            f.client().reset().await.expect_err("a read-only dir")
        };
        assert_eq!(e.code, "sync.io");
        assert!(
            e.message
                .starts_with("Could not set the sync state aside: "),
            "{}",
            e.message
        );
        assert_eq!(f.sync_json(), Some(b"{".to_vec()));
        assert!(bad_files(f.dir.path()).is_empty());
    }

    #[tokio::test]
    async fn a_403_marks_the_device_revoked() {
        let mut f = Fixture::new().await;
        f.join_with_token();
        f.answer(
            "POST",
            "/ticket",
            403,
            json!({ "error": "revoked", "message": REVOKED }),
        )
        .await;
        let client = f.client();
        assert_eq!(
            client.ticket("ix-sp000000000").await.map(|_| ()),
            Err(err("sync.revoked", REVOKED))
        );
        assert_eq!(
            client.status().await,
            Ok(SyncStatus {
                space: Some(f.space()),
                revoked: true
            })
        );
        assert_eq!(f.token(), None);
    }

    #[tokio::test]
    async fn only_a_revoked_403_unpairs_the_device() {
        let mut f = Fixture::new().await;
        f.join_with_token();
        f.answer(
            "POST",
            "/ticket",
            403,
            json!({ "error": "forbidden", "message": "Not for you." }),
        )
        .await;
        let client = f.client();
        assert_eq!(
            client.ticket("ix-sp000000000").await.map(|_| ()),
            Err(err(
                "sync.forbidden",
                "Server answered 403 forbidden: Not for you."
            ))
        );
        assert_eq!(
            client.status().await,
            Ok(SyncStatus {
                space: Some(f.space()),
                revoked: false
            })
        );
        assert_eq!(f.token().as_deref(), Some(TOKEN));
    }

    #[tokio::test]
    async fn a_403_that_is_not_json_is_an_error_with_its_body() {
        let mut f = Fixture::new().await;
        f.join_with_token();
        f.server
            .mock("POST", "/ticket")
            .with_status(403)
            .with_body("  <h1>Blocked by the proxy</h1>\n")
            .create_async()
            .await;
        let client = f.client();
        assert_eq!(
            client.ticket("ix-sp000000000").await.map(|_| ()),
            Err(err(
                "sync.forbidden",
                "Server answered 403: <h1>Blocked by the proxy</h1>"
            ))
        );
        assert_eq!(client.status().await.map(|s| s.revoked), Ok(false));
        assert_eq!(f.token().as_deref(), Some(TOKEN));
    }

    #[test]
    fn a_long_or_empty_403_body_is_cut_or_called_unexpected() {
        let long = "é".repeat(SHOWN_BODY_CHARS + 50);
        assert_eq!(
            forbidden_text(long.as_bytes()),
            err(
                "sync.forbidden",
                &format!("Server answered 403: {}…", "é".repeat(SHOWN_BODY_CHARS))
            )
        );
        assert_eq!(
            forbidden_text(b" \n"),
            err(
                "sync.forbidden",
                "Server answered 403 with an unexpected response."
            )
        );
    }

    #[tokio::test]
    async fn a_403_whose_revoked_save_fails_is_sync_io() {
        let mut f = Fixture::new().await;
        f.join_with_token();
        let before = f.sync_json();
        let m = f
            .server
            .mock("POST", "/ticket")
            .with_status(403)
            .with_body(json!({ "error": "revoked", "message": REVOKED }).to_string())
            .expect(1)
            .create_async()
            .await;
        let e = {
            let _ro = ReadOnly::new(f.dir.path());
            f.client()
                .ticket("ix-sp000000000")
                .await
                .expect_err("a read-only dir")
        };
        assert_eq!(e.code, "sync.io");
        assert!(
            e.message.starts_with("Could not save the sync state: "),
            "{}",
            e.message
        );
        assert_eq!(f.sync_json(), before);
        assert_eq!(
            f.client().status().await,
            Ok(SyncStatus {
                space: Some(f.space()),
                revoked: false
            })
        );
        assert_eq!(f.token().as_deref(), Some(TOKEN));
        m.assert_async().await;
    }

    #[tokio::test]
    async fn a_failed_sync_json_write_is_sync_io() {
        let mut f = Fixture::new().await;
        f.join_with_token();
        let e = {
            let _ro = ReadOnly::new(f.dir.path());
            f.client()
                .mark_revoked()
                .await
                .expect_err("a read-only dir")
        };
        assert_eq!(e.code, "sync.io");
        assert!(
            e.message.starts_with("Could not save the sync state: "),
            "{}",
            e.message
        );
        fs::remove_file(f.dir.path().join("sync.json")).expect("remove");
        f.answer("POST", "/space", 200, enrolled(TOKEN)).await;
        f.answer("POST", "/pair/claim", 200, enrolled(TOKEN)).await;
        let (setup, join) = {
            let _ro = ReadOnly::new(f.dir.path());
            let client = f.client();
            (
                client.setup(&f.url(), "s3cr3t", DEVICE, "Mac").await,
                client.pair_join(&f.url(), "ABCD2345", DEVICE, "Mac").await,
            )
        };
        [setup, join].into_iter().for_each(|r| {
            let e = r.expect_err("a read-only dir");
            assert_eq!(e.code, "sync.io");
            assert!(
                e.message.starts_with("Could not save the sync state: "),
                "{}",
                e.message
            );
        });
        assert_eq!(f.sync_json(), None);
    }

    #[tokio::test]
    async fn a_429_carries_the_servers_message_and_the_wait() {
        let mut f = Fixture::new().await;
        f.join_with_token();
        let client = f.client();
        let pair = f
            .server
            .mock("POST", "/pair")
            .with_status(429)
            .with_header("retry-after", "600")
            .with_body(
                json!({ "error": "rate_limited", "message": "Three pairing codes are already live. Use one or wait until one expires." })
                    .to_string(),
            )
            .create_async()
            .await;
        assert_eq!(
            client.pair_code().await.map(|_| ()),
            Err(err(
                "sync.rate_limited",
                "Three pairing codes are already live. Use one or wait until one expires. Try again in 10 minutes."
            ))
        );
        pair.remove_async().await;
        for (wait, message) in [
            ("61", "Try again in 2 minutes."),
            ("30", "Try again in 1 minute."),
        ] {
            let m = f
                .server
                .mock("POST", "/pair")
                .with_status(429)
                .with_header("retry-after", wait)
                .create_async()
                .await;
            assert_eq!(
                client.pair_code().await.map(|_| ()),
                Err(err("sync.rate_limited", message))
            );
            m.remove_async().await;
        }
        f.server
            .mock("GET", "/devices")
            .with_status(429)
            .with_header("retry-after", "600")
            .create_async()
            .await;
        f.server
            .mock("DELETE", "/devices/dev00000000")
            .with_status(429)
            .with_header("retry-after", "600")
            .create_async()
            .await;
        let ten = Err(err("sync.rate_limited", "Try again in 10 minutes."));
        assert_eq!(client.devices().await.map(|_| ()), ten.clone());
        assert_eq!(client.remove_device("dev00000000").await, ten);
    }

    #[tokio::test]
    async fn a_429_without_a_usable_retry_after_says_later() {
        let mut f = Fixture::new().await;
        f.join_with_token();
        let client = f.client();
        let daily =
            json!({ "error": "rate_limited", "message": "Daily limit reached." }).to_string();
        for wait in [None, Some("soon")] {
            let mut m = f
                .server
                .mock("POST", "/pair")
                .with_status(429)
                .with_body(&daily);
            if let Some(w) = wait {
                m = m.with_header("retry-after", w);
            }
            let m = m.create_async().await;
            assert_eq!(
                client.pair_code().await.map(|_| ()),
                Err(err(
                    "sync.rate_limited",
                    "Daily limit reached. Try again later."
                ))
            );
            m.remove_async().await;
        }
        let html = f
            .server
            .mock("POST", "/pair")
            .with_status(429)
            .with_header("content-type", "text/html")
            .with_body("<html>Error 1015</html>")
            .create_async()
            .await;
        assert_eq!(
            client.pair_code().await.map(|_| ()),
            Err(err("sync.rate_limited", "Try again later."))
        );
        html.remove_async().await;
        let empty = f
            .server
            .mock("POST", "/pair")
            .with_status(429)
            .expect(1)
            .create_async()
            .await;
        assert_eq!(
            client.pair_code().await.map(|_| ()),
            Err(err("sync.rate_limited", "Try again later."))
        );
        empty.assert_async().await;
    }

    #[tokio::test]
    async fn only_webboard_rokass_org_is_accepted() {
        let mut f = Fixture::new().await;
        let mocks = f.nothing().await;
        let client = f.client();
        let host = Err(err(
            "sync.host",
            "This build syncs only with webboard.rokass.org.",
        ));
        assert_eq!(
            client
                .setup("https://example.org", "s3cr3t", DEVICE, "Mac")
                .await,
            host.clone()
        );
        assert_eq!(
            client
                .pair_join("https://example.org", "ABCD2345", DEVICE, "Mac")
                .await,
            host
        );
        let address = Err(err(
            "sync.http",
            "The server address must start with https://",
        ));
        for bad in [
            "http://webboard.rokass.org",
            "https://webboard.rokass.org/space",
            "webboard.rokass.org",
            "https://webboard.rokass.org?x=1",
            "",
        ] {
            assert_eq!(
                client.setup(bad, "s3cr3t", DEVICE, "Mac").await,
                address.clone(),
                "{bad}"
            );
        }
        assert_eq!(
            client
                .pair_join(
                    "https://webboard.rokass.org:8443",
                    "ABCD2345",
                    DEVICE,
                    "Mac"
                )
                .await,
            Err(err(
                "sync.host",
                "This build syncs only with webboard.rokass.org."
            ))
        );
        assert_all(mocks).await;
        assert_eq!(f.sync_json(), None);
    }

    #[tokio::test]
    async fn a_503_not_configured_is_sync_not_configured() {
        let mut f = Fixture::new().await;
        f.join_with_token();
        let before = f.sync_json();
        let body = json!({ "error": "not_configured", "message": SERVER_NOT_CONFIGURED });
        for (method, path) in [
            ("POST", "/space"),
            ("POST", "/pair/claim"),
            ("POST", "/pair"),
            ("POST", "/ticket"),
            ("GET", "/devices"),
            ("DELETE", "/devices/dev00000000"),
        ] {
            f.answer(method, path, 503, body.clone()).await;
        }
        let client = f.client();
        let nc = Err(err("sync.not_configured", NOT_CONFIGURED));
        assert_eq!(
            client
                .setup(&f.url(), "s3cr3t", DEVICE, "Mac")
                .await
                .map(|_| ()),
            nc.clone()
        );
        assert_eq!(
            client
                .pair_join(&f.url(), "ABCD2345", DEVICE, "Mac")
                .await
                .map(|_| ()),
            nc.clone()
        );
        assert_eq!(client.pair_code().await.map(|_| ()), nc.clone());
        assert_eq!(
            client.ticket("ix-sp000000000").await.map(|_| ()),
            nc.clone()
        );
        assert_eq!(client.devices().await.map(|_| ()), nc.clone());
        assert_eq!(client.remove_device("dev00000000").await, nc);
        assert_eq!(f.sync_json(), before);
    }

    #[tokio::test]
    async fn other_statuses_are_sync_http() {
        let mut f = Fixture::new().await;
        f.join_with_token();
        let client = f.client();
        let html = f
            .server
            .mock("POST", "/ticket")
            .with_status(502)
            .with_header("content-type", "text/html")
            .with_body("<html>Bad gateway</html>")
            .create_async()
            .await;
        assert_eq!(
            client.ticket("ix-sp000000000").await.map(|_| ()),
            Err(err(
                "sync.http",
                "Server answered 502 with an unexpected response."
            ))
        );
        html.remove_async().await;
        f.answer(
            "POST",
            "/ticket",
            500,
            json!({ "error": "x", "message": "y" }),
        )
        .await;
        assert_eq!(
            client.ticket("ix-sp000000000").await.map(|_| ()),
            Err(err("sync.http", "Server answered 500 x: y"))
        );
        f.answer(
            "DELETE",
            "/devices/dev00000000",
            404,
            json!({ "error": "not_found", "message": "This device is not in the space." }),
        )
        .await;
        assert_eq!(
            client.remove_device("dev00000000").await,
            Err(err(
                "sync.http",
                "Server answered 404 not_found: This device is not in the space."
            ))
        );
    }

    #[tokio::test]
    async fn a_404_on_claim_is_sync_bad_code() {
        let mut f = Fixture::new().await;
        let wrong =
            "The pairing code is wrong, used or expired. Show a new code on a device in the space.";
        f.answer(
            "POST",
            "/pair/claim",
            404,
            json!({ "error": "bad_code", "message": wrong }),
        )
        .await;
        assert_eq!(
            f.client()
                .pair_join(&f.url(), "ABCD2345", DEVICE, "Mac")
                .await,
            Err(err("sync.bad_code", wrong))
        );
        assert_eq!(f.sync_json(), None);
        assert_eq!(f.token(), None);
    }

    #[tokio::test]
    async fn a_401_carries_the_servers_message() {
        let mut f = Fixture::new().await;
        f.answer(
            "POST",
            "/space",
            401,
            json!({ "error": "unauthorized", "message": "The setup secret is not correct." }),
        )
        .await;
        assert_eq!(
            f.client().setup(&f.url(), "s3cr3t", DEVICE, "Mac").await,
            Err(err("sync.unauthorized", "The setup secret is not correct."))
        );
        assert_eq!(f.sync_json(), None);
        assert_eq!(f.token(), None);
        f.join_with_token();
        f.answer(
            "GET",
            "/devices",
            401,
            json!({ "error": "unauthorized", "message": UNKNOWN }),
        )
        .await;
        assert_eq!(
            f.client().devices().await.map(|_| ()),
            Err(err("sync.unauthorized", UNKNOWN))
        );
    }

    #[tokio::test]
    async fn joining_again_readmits_a_removed_device() {
        let mut f = Fixture::new().await;
        f.join_with_token();
        f.client().mark_revoked().await.expect("mark_revoked");
        f.answer("POST", "/pair/claim", 200, enrolled("tok_NEW_456"))
            .await;
        let client = f.client();
        let space = client
            .pair_join(&f.url(), "ABCD2345", DEVICE, "Mac")
            .await
            .expect("pair_join");
        assert_eq!(space, f.space());
        assert_eq!(
            client.status().await,
            Ok(SyncStatus {
                space: Some(f.space()),
                revoked: false
            })
        );
        assert_eq!(f.token().as_deref(), Some("tok_NEW_456"));
    }

    #[tokio::test]
    async fn a_connect_error_is_sync_http_naming_the_cause() {
        let f = Fixture::new().await;
        let port = {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
            listener.local_addr().expect("addr").port()
        };
        let e = f
            .client()
            .setup(&format!("http://127.0.0.1:{port}"), "s3cr3t", DEVICE, "Mac")
            .await
            .expect_err("nothing listens");
        assert_eq!(e.code, "sync.http");
        assert!(
            e.message.starts_with("Could not reach 127.0.0.1: "),
            "{}",
            e.message
        );
    }

    #[tokio::test]
    async fn a_silent_server_times_out() {
        let f = Fixture::new().await;
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = listener.local_addr().expect("addr").port();
        let started = std::time::Instant::now();
        let e = f
            .client()
            .with_timeout(Duration::from_millis(200))
            .setup(&format!("http://127.0.0.1:{port}"), "s3cr3t", DEVICE, "Mac")
            .await
            .expect_err("the server never answers");
        let waited = started.elapsed();
        drop(listener);
        assert_eq!(
            e,
            err("sync.http", "127.0.0.1 did not answer within 0.2 s.")
        );
        assert!(waited >= Duration::from_millis(200), "{waited:?}");
        assert!(waited < Duration::from_secs(5), "{waited:?}");
    }

    #[tokio::test]
    async fn requests_time_out_after_10_s_by_default() {
        let f = Fixture::new().await;
        let timeout = f.client().timeout;
        assert_eq!(timeout, Duration::from_secs(10));
        assert_eq!(
            timed_out("webboard.rokass.org", timeout),
            err(
                "sync.http",
                "webboard.rokass.org did not answer within 10 s."
            )
        );
    }

    struct SlowTokens;

    impl TokenStore for SlowTokens {
        fn probe(&self) -> Result<(), SyncError> {
            Ok(())
        }
        fn get(&self, _space: &str) -> Result<Option<String>, SyncError> {
            std::thread::sleep(Duration::from_secs(2));
            Ok(None)
        }
        fn put(&self, _space: &str, _token: &str) -> Result<(), SyncError> {
            Ok(())
        }
        fn delete(&self, _space: &str) -> Result<(), SyncError> {
            Ok(())
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn a_slow_keychain_does_not_hold_up_other_commands() {
        let f = Fixture::new().await;
        f.join();
        let client = SyncClient::new(
            f.dir.path().to_path_buf(),
            Arc::new(SlowTokens),
            reqwest::Client::new(),
        );
        let started = std::time::Instant::now();
        let (ticket, (status, status_at)) = tokio::join!(client.ticket("ix-sp000000000"), async {
            let status = client.status().await;
            (status, started.elapsed())
        });
        assert_eq!(ticket.map(|_| ()), Err(err("keychain.missing", MISSING)));
        assert_eq!(
            status,
            Ok(SyncStatus {
                space: Some(f.space()),
                revoked: false
            })
        );
        assert!(status_at < Duration::from_millis(500), "{status_at:?}");
        assert!(started.elapsed() >= Duration::from_secs(2));
    }

    #[tokio::test]
    async fn sync_requests_carry_the_webboard_user_agent() {
        let mut f = Fixture::new().await;
        let m = f
            .server
            .mock("POST", "/space")
            .match_header(
                "user-agent",
                format!(
                    "WebBoard/{} (+https://webboard.rokass.org)",
                    env!("CARGO_PKG_VERSION")
                )
                .as_str(),
            )
            .with_status(200)
            .with_body(enrolled(TOKEN).to_string())
            .expect(1)
            .create_async()
            .await;
        let client = SyncClient::new(
            f.dir.path().to_path_buf(),
            f.tokens.clone(),
            http_client().expect("http client"),
        );
        client
            .setup(&f.url(), "s3cr3t", DEVICE, "Mac")
            .await
            .expect("setup");
        m.assert_async().await;
    }

    #[tokio::test]
    async fn a_garbled_success_is_sync_http() {
        let mut f = Fixture::new().await;
        f.server
            .mock("POST", "/space")
            .with_status(200)
            .with_body("not json")
            .create_async()
            .await;
        assert_eq!(
            f.client().setup(&f.url(), "s3cr3t", DEVICE, "Mac").await,
            Err(err(
                "sync.http",
                "Server answered 200 with an unexpected response: expected ident at line 1 column 2"
            ))
        );
        assert_eq!(f.sync_json(), None);
        assert_eq!(f.token(), None);
    }

    const OTHER: &str = "sp111111111";

    #[derive(Default)]
    struct Counting {
        inner: MemoryTokens,
        gets: std::sync::atomic::AtomicUsize,
        broken_delete: bool,
    }

    impl Counting {
        fn breaking_delete() -> Self {
            Self {
                broken_delete: true,
                ..Self::default()
            }
        }

        fn gets(&self) -> usize {
            self.gets.load(std::sync::atomic::Ordering::SeqCst)
        }
    }

    impl TokenStore for Counting {
        fn probe(&self) -> Result<(), SyncError> {
            self.inner.probe()
        }
        fn get(&self, space: &str) -> Result<Option<String>, SyncError> {
            self.gets.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            self.inner.get(space)
        }
        fn put(&self, space: &str, token: &str) -> Result<(), SyncError> {
            self.inner.put(space, token)
        }
        fn delete(&self, space: &str) -> Result<(), SyncError> {
            if self.broken_delete {
                return Err(err("keychain.io", "The keychain failed: delete refused"));
            }
            self.inner.delete(space)
        }
    }

    fn write_space(dir: &Path, server: &str, space: &str) {
        fs::write(
            dir.join("sync.json"),
            json!({ "server": server, "spaceId": space, "deviceId": DEVICE, "deviceName": "Mac", "revoked": false })
                .to_string(),
        )
        .expect("write sync.json");
    }

    #[tokio::test]
    async fn the_four_token_commands_report_an_unreadable_state() {
        let mut f = Fixture::new().await;
        f.tokens.put(SPACE, TOKEN).expect("put");
        let mocks = f.nothing().await;
        let client = f.client();
        for contents in [
            "{".to_string(),
            json!({ "server": "https://example.org", "spaceId": SPACE, "deviceId": DEVICE, "deviceName": "Mac", "revoked": false }).to_string(),
        ] {
            fs::write(f.dir.path().join("sync.json"), &contents).expect("write");
            let results = [
                client.pair_code().await.map(|_| ()),
                client.ticket("ix-sp000000000").await.map(|_| ()),
                client.devices().await.map(|_| ()),
                client.remove_device("dev00000000").await,
            ];
            results.into_iter().for_each(|r| {
                let e = r.expect_err("an unreadable sync state");
                assert_eq!(e.code, "sync.io", "{contents}: {}", e.message);
                assert!(
                    e.message.starts_with("Could not read the sync state: "),
                    "{}",
                    e.message
                );
            });
        }
        assert_all(mocks).await;
    }

    #[tokio::test]
    async fn an_unreadable_state_stops_setup_and_join_before_any_request() {
        let mut f = Fixture::new().await;
        let mocks = f.nothing().await;
        let client = f.client();
        fs::write(f.dir.path().join("sync.json"), "{").expect("write");
        let results = [
            client.setup(&f.url(), "s3cr3t", DEVICE, "Mac").await,
            client.pair_join(&f.url(), "ABCD-EFGH", DEVICE, "Mac").await,
        ];
        results.into_iter().for_each(|r| {
            let e = r.expect_err("an unreadable sync state");
            assert_eq!(e.code, "sync.io", "{}", e.message);
            assert!(
                e.message.starts_with("Could not read the sync state: "),
                "{}",
                e.message
            );
        });
        assert_eq!(f.sync_json(), Some(b"{".to_vec()));
        assert_eq!(f.token(), None);
        assert_all(mocks).await;
    }

    #[tokio::test]
    async fn a_failed_enrol_save_removes_the_new_token() {
        let mut f = Fixture::new().await;
        f.answer("POST", "/space", 200, enrolled(TOKEN)).await;
        let e = {
            let _ro = ReadOnly::new(f.dir.path());
            f.client()
                .setup(&f.url(), "s3cr3t", DEVICE, "Mac")
                .await
                .expect_err("a read-only dir")
        };
        assert_eq!(e.code, "sync.io");
        assert!(
            e.message.starts_with("Could not save the sync state: "),
            "{}",
            e.message
        );
        assert!(!e.message.contains("could not be removed"), "{}", e.message);
        assert_eq!(f.token(), None);
        let tokens = Arc::new(Counting::breaking_delete());
        let client = SyncClient::new(
            f.dir.path().to_path_buf(),
            tokens.clone(),
            reqwest::Client::new(),
        );
        let e = {
            let _ro = ReadOnly::new(f.dir.path());
            client
                .setup(&f.url(), "s3cr3t", DEVICE, "Mac")
                .await
                .expect_err("a read-only dir")
        };
        assert_eq!(e.code, "sync.io");
        assert!(
            e.message.starts_with("Could not save the sync state: "),
            "{}",
            e.message
        );
        assert!(
            e.message.ends_with(
                " The device token could not be removed: The keychain failed: delete refused"
            ),
            "{}",
            e.message
        );
        assert_eq!(f.sync_json(), None);
    }

    #[tokio::test]
    async fn enrolling_into_another_space_deletes_the_old_token() {
        let mut f = Fixture::new().await;
        f.join_with_token();
        f.answer(
            "POST",
            "/pair/claim",
            200,
            json!({ "spaceId": OTHER, "deviceId": DEVICE, "token": "tok_NEW_456" }),
        )
        .await;
        let client = f.client();
        let space = client
            .pair_join(&f.url(), "ABCD2345", DEVICE, "Mac")
            .await
            .expect("pair_join");
        assert_eq!(space.space_id, OTHER);
        assert_eq!(f.token(), None);
        assert_eq!(
            f.tokens.get(OTHER).expect("get").as_deref(),
            Some("tok_NEW_456")
        );
        let tokens = Arc::new(Counting::breaking_delete());
        tokens.put(OTHER, "tok_NEW_456").expect("put");
        let client = SyncClient::new(
            f.dir.path().to_path_buf(),
            tokens.clone(),
            reqwest::Client::new(),
        );
        f.answer("POST", "/space", 200, enrolled("tok_THIRD_789"))
            .await;
        assert_eq!(
            client.setup(&f.url(), "s3cr3t", DEVICE, "Mac").await,
            Err(err(
                "keychain.io",
                "Joined space sp000000000, but the device token of space sp111111111 could not be removed: The keychain failed: delete refused"
            ))
        );
        assert_eq!(
            client.status().await,
            Ok(SyncStatus {
                space: Some(f.space()),
                revoked: false
            })
        );
        assert_eq!(
            tokens.get(SPACE).expect("get").as_deref(),
            Some("tok_THIRD_789")
        );
    }

    #[tokio::test]
    async fn a_late_403_leaves_a_newly_joined_space_alone() {
        let mut f = Fixture::new().await;
        f.join_with_token();
        f.tokens.put(OTHER, "tok_OTHER").expect("put");
        let dir = f.dir.path().to_path_buf();
        let server = f.url();
        let m = f
            .server
            .mock("POST", "/ticket")
            .with_status(403)
            .with_body_from_request(move |_| {
                write_space(&dir, &server, OTHER);
                json!({ "error": "revoked", "message": REVOKED })
                    .to_string()
                    .into_bytes()
            })
            .expect(1)
            .create_async()
            .await;
        let client = f.client();
        assert_eq!(
            client.ticket("ix-sp000000000").await.map(|_| ()),
            Err(err(
                "sync.http",
                "Server answered 403 revoked: This device was removed from the space."
            ))
        );
        m.assert_async().await;
        let status = client.status().await.expect("status");
        assert!(!status.revoked);
        assert_eq!(status.space.map(|s| s.space_id).as_deref(), Some(OTHER));
        assert_eq!(f.token().as_deref(), Some(TOKEN));
        assert_eq!(
            f.tokens.get(OTHER).expect("get").as_deref(),
            Some("tok_OTHER")
        );
    }

    #[tokio::test]
    async fn a_second_403_after_the_first_revoked_the_space_is_still_revoked() {
        let mut f = Fixture::new().await;
        f.join_with_token();
        let path = f.dir.path().join("sync.json");
        let server = f.url();
        let tokens = f.tokens.clone();
        let m = f
            .server
            .mock("POST", "/ticket")
            .match_header("authorization", format!("Bearer {TOKEN}").as_str())
            .with_status(403)
            .with_body_from_request(move |_| {
                fs::write(
                    &path,
                    json!({ "server": server, "spaceId": SPACE, "deviceId": DEVICE, "deviceName": "Mac", "revoked": true })
                        .to_string(),
                )
                .expect("write the first 403's revoked state");
                tokens.delete(SPACE).expect("delete the token as the first 403 did");
                json!({ "error": "revoked", "message": REVOKED })
                    .to_string()
                    .into_bytes()
            })
            .expect(1)
            .create_async()
            .await;
        let client = f.client();
        assert_eq!(
            client.ticket("ix-sp000000000").await.map(|_| ()),
            Err(err("sync.revoked", REVOKED))
        );
        m.assert_async().await;
        assert_eq!(
            client.status().await,
            Ok(SyncStatus {
                space: Some(f.space()),
                revoked: true
            })
        );
        assert_eq!(f.token(), None);
    }

    #[tokio::test]
    async fn a_late_403_with_the_old_token_leaves_a_rejoin_of_the_same_space_alone() {
        let mut f = Fixture::new().await;
        f.join_with_token();
        let dir = f.dir.path().to_path_buf();
        let server = f.url();
        let tokens = f.tokens.clone();
        let m = f
            .server
            .mock("POST", "/ticket")
            .match_header("authorization", format!("Bearer {TOKEN}").as_str())
            .with_status(403)
            .with_body_from_request(move |_| {
                write_space(&dir, &server, SPACE);
                tokens.put(SPACE, "tok_NEW_456").expect("put the new token");
                json!({ "error": "revoked", "message": REVOKED })
                    .to_string()
                    .into_bytes()
            })
            .expect(1)
            .create_async()
            .await;
        let client = f.client();
        assert_eq!(
            client.ticket("ix-sp000000000").await.map(|_| ()),
            Err(err(
                "sync.http",
                "Server answered 403 revoked: This device was removed from the space."
            ))
        );
        m.assert_async().await;
        assert_eq!(
            client.status().await,
            Ok(SyncStatus {
                space: Some(f.space()),
                revoked: false
            })
        );
        assert_eq!(f.token().as_deref(), Some("tok_NEW_456"));
    }

    #[tokio::test]
    async fn a_reset_never_overwrites_an_earlier_one() {
        let f = Fixture::new().await;
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_secs();
        (now..now + 5).for_each(|t| {
            fs::write(
                f.dir.path().join(format!("sync.bad-{t}.json")),
                t.to_string(),
            )
            .expect("write");
        });
        let client = f.client();
        fs::write(f.dir.path().join("sync.json"), "{").expect("write");
        assert_eq!(client.reset().await, Ok(()));
        fs::write(f.dir.path().join("sync.json"), "[").expect("write");
        assert_eq!(client.reset().await, Ok(()));
        (now..now + 5).for_each(|t| {
            assert_eq!(
                fs::read_to_string(f.dir.path().join(format!("sync.bad-{t}.json"))).expect("read"),
                t.to_string()
            );
        });
        let mut set_aside = bad_files(f.dir.path())
            .into_iter()
            .filter(|n| n.contains('-') && n.matches('-').count() == 2)
            .map(|n| fs::read_to_string(f.dir.path().join(n)).expect("read"))
            .collect::<Vec<_>>();
        set_aside.sort();
        assert_eq!(set_aside, vec!["[".to_string(), "{".to_string()]);
        assert_eq!(f.sync_json(), None);
    }

    #[tokio::test]
    async fn a_zero_or_blank_rate_limit_still_reads_well() {
        let mut f = Fixture::new().await;
        f.join_with_token();
        let client = f.client();
        for (wait, body, message) in [
            ("0", None, "Try again in 1 minute."),
            (
                "0",
                Some(json!({ "error": "rate_limited", "message": "" })),
                "Try again in 1 minute.",
            ),
            (
                "120",
                Some(json!({ "error": "rate_limited", "message": "  \n" })),
                "Try again in 2 minutes.",
            ),
        ] {
            let mut m = f
                .server
                .mock("POST", "/pair")
                .with_status(429)
                .with_header("retry-after", wait);
            if let Some(b) = body {
                m = m.with_body(b.to_string());
            }
            let m = m.create_async().await;
            assert_eq!(
                client.pair_code().await.map(|_| ()),
                Err(err("sync.rate_limited", message)),
                "{wait}"
            );
            m.remove_async().await;
        }
        let blank = f
            .server
            .mock("POST", "/pair")
            .with_status(429)
            .with_body(json!({ "error": "rate_limited", "message": " " }).to_string())
            .create_async()
            .await;
        assert_eq!(
            client.pair_code().await.map(|_| ()),
            Err(err("sync.rate_limited", "Try again later."))
        );
        blank.assert_async().await;
    }

    #[tokio::test]
    async fn a_tampered_server_is_refused_before_the_keychain() {
        let mut f = Fixture::new().await;
        let tokens = Arc::new(Counting::default());
        tokens.put(SPACE, TOKEN).expect("put");
        write_space(f.dir.path(), "https://example.org", SPACE);
        let mocks = f.nothing().await;
        let client = SyncClient::new(
            f.dir.path().to_path_buf(),
            tokens.clone(),
            reqwest::Client::new(),
        );
        let e = client
            .ticket("ix-sp000000000")
            .await
            .expect_err("a tampered server");
        assert_eq!(e.code, "sync.io");
        assert_eq!(
            e.message,
            "Could not read the sync state: its server address https://example.org is refused: This build syncs only with webboard.rokass.org."
        );
        assert_eq!(tokens.gets(), 0);
        assert_all(mocks).await;
    }

    #[tokio::test]
    async fn a_server_enrolling_another_device_is_sync_http() {
        let mut f = Fixture::new().await;
        f.answer(
            "POST",
            "/space",
            200,
            json!({ "spaceId": SPACE, "deviceId": "devB0000000", "token": TOKEN }),
        )
        .await;
        assert_eq!(
            f.client().setup(&f.url(), "s3cr3t", DEVICE, "Mac").await,
            Err(err(
                "sync.http",
                "The server enrolled device devB0000000 instead of devA0000000."
            ))
        );
        assert_eq!(f.sync_json(), None);
        assert_eq!(f.token(), None);
    }

    #[tokio::test]
    #[should_panic(expected = "read sync.json")]
    async fn the_sync_json_helper_panics_on_a_real_read_error() {
        let f = Fixture::new().await;
        fs::create_dir(f.dir.path().join("sync.json")).expect("mkdir");
        f.sync_json();
    }

    #[test]
    fn a_sync_error_becomes_a_command_error() {
        assert_eq!(
            CommandError::from(err("sync.revoked", REVOKED)),
            CommandError::new("sync.revoked", REVOKED)
        );
    }
}
