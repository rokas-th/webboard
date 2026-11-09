use std::collections::HashMap;
use std::fs;
use std::io::{ErrorKind, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use reqwest::header::{HeaderMap, AUTHORIZATION, RETRY_AFTER};
use reqwest::{RequestBuilder, Response, StatusCode, Url};
use serde::de::{DeserializeOwned, IgnoredAny};
use serde::{Deserialize, Serialize};

use crate::error::CommandError;

const HOST: &str = "webboard.rokass.org";
const FILE: &str = "sync.json";
const TEMP: &str = "sync.json.tmp";
const TIMEOUT_SECS: u64 = 10;
const USER_AGENT: &str = concat!(
    "WebBoard/",
    env!("CARGO_PKG_VERSION"),
    " (+https://webboard.rokass.org)"
);

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

#[derive(Clone, Copy, PartialEq, Eq)]
enum Caller {
    Setup,
    Claim,
    Member,
}

struct Member {
    server: Url,
    token: String,
}

pub fn http_client() -> Result<reqwest::Client, SyncError> {
    reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .build()
        .map_err(|e| {
            SyncError::new(
                "sync.http",
                format!("Could not start the HTTP client: {}.", innermost(&e)),
            )
        })
}

fn innermost(e: &(dyn std::error::Error + 'static)) -> String {
    std::iter::successors(Some(e), |cur| cur.source())
        .last()
        .map_or_else(|| e.to_string(), ToString::to_string)
}

fn http(message: impl Into<String>) -> SyncError {
    SyncError::new("sync.http", message)
}

fn save_failed(e: &std::io::Error) -> SyncError {
    SyncError::new("sync.io", format!("Could not save the sync state: {e}"))
}

fn read_failed(detail: impl std::fmt::Display) -> SyncError {
    SyncError::new(
        "sync.io",
        format!("Could not read the sync state: {detail}"),
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

fn transport(url: &Url, e: &reqwest::Error) -> SyncError {
    let host = host_of(url);
    if e.is_timeout() {
        http(format!("{host} did not answer within {TIMEOUT_SECS} s."))
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
    let wait = match retry.map(|secs| secs.div_ceil(60)) {
        Some(1) => "Try again in 1 minute.".to_string(),
        Some(n) => format!("Try again in {n} minutes."),
        None => "Try again later.".to_string(),
    };
    SyncError::new(
        "sync.rate_limited",
        match message {
            Some(m) => format!("{m} {wait}"),
            None => wait,
        },
    )
}

fn unix_secs() -> Result<u64, SyncError> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .map_err(|e| {
            SyncError::new(
                "sync.io",
                format!("Could not set the sync state aside: the clock is before 1970: {e}"),
            )
        })
}

pub struct SyncClient {
    dir: PathBuf,
    tokens: Arc<dyn TokenStore>,
    http: reqwest::Client,
    writing: Mutex<()>,
}

impl SyncClient {
    pub fn new(dir: PathBuf, tokens: Arc<dyn TokenStore>, http: reqwest::Client) -> Self {
        Self {
            dir,
            tokens,
            http,
            writing: Mutex::new(()),
        }
    }

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
        let json = serde_json::to_vec(stored).map_err(|e| {
            SyncError::new("sync.io", format!("Could not save the sync state: {e}"))
        })?;
        let replace = || -> std::io::Result<()> {
            fs::create_dir_all(&self.dir)?;
            let tmp = self.dir.join(TEMP);
            let mut file = fs::File::create(&tmp)?;
            file.write_all(&json)?;
            file.sync_all()?;
            drop(file);
            fs::rename(&tmp, self.dir.join(FILE))?;
            fs::File::open(&self.dir)?.sync_all()
        };
        replace().map_err(|e| save_failed(&e))
    }

    pub fn status(&self) -> Result<SyncStatus, SyncError> {
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

    pub fn reset(&self) -> Result<(), SyncError> {
        let _guard = self.guard()?;
        let aside = self.dir.join(format!("sync.bad-{}.json", unix_secs()?));
        match fs::rename(self.dir.join(FILE), aside) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == ErrorKind::NotFound => Ok(()),
            Err(e) => Err(SyncError::new(
                "sync.io",
                format!("Could not set the sync state aside: {e}"),
            )),
        }
    }

    pub fn mark_revoked(&self) -> Result<(), SyncError> {
        let space_id = {
            let _guard = self.guard()?;
            let mut stored = self
                .read()?
                .ok_or_else(|| SyncError::new("sync.not_joined", NOT_JOINED))?;
            stored.revoked = true;
            self.write(&stored)?;
            stored.space.space_id
        };
        self.tokens.delete(&space_id)
    }

    fn member(&self) -> Result<Member, SyncError> {
        let stored = self
            .read()?
            .ok_or_else(|| SyncError::new("sync.not_joined", NOT_JOINED))?;
        if stored.revoked {
            return Err(SyncError::new("sync.revoked", REVOKED));
        }
        let token = self
            .tokens
            .get(&stored.space.space_id)?
            .ok_or_else(|| SyncError::new("keychain.missing", MISSING))?;
        let server = server_url(&stored.space.server).map_err(|e| {
            read_failed(format!(
                "its server address {} is refused: {}",
                stored.space.server, e.message
            ))
        })?;
        Ok(Member { server, token })
    }

    async fn exchange<T: DeserializeOwned>(
        &self,
        url: &Url,
        request: RequestBuilder,
        caller: Caller,
    ) -> Result<T, SyncError> {
        let response = request
            .timeout(Duration::from_secs(TIMEOUT_SECS))
            .send()
            .await
            .map_err(|e| transport(url, &e))?;
        let status = response.status();
        if status.is_success() {
            let bytes = response.bytes().await.map_err(|e| transport(url, &e))?;
            return serde_json::from_slice(&bytes).map_err(|_| unexpected(status));
        }
        Err(self.refusal(url, response, caller).await)
    }

    async fn refusal(&self, url: &Url, response: Response, caller: Caller) -> SyncError {
        let status = response.status();
        let retry = retry_after(response.headers());
        let bytes = match response.bytes().await {
            Ok(bytes) => bytes,
            Err(e) => return transport(url, &e),
        };
        let body = serde_json::from_slice::<ErrorBody>(&bytes).ok();
        if status == StatusCode::TOO_MANY_REQUESTS {
            return rate_limited(body.map(|b| b.message), retry);
        }
        let Some(body) = body else {
            return unexpected(status);
        };
        match status.as_u16() {
            401 => SyncError::new("sync.unauthorized", body.message),
            403 if caller == Caller::Member => match self.mark_revoked() {
                Ok(()) => SyncError::new("sync.revoked", body.message),
                Err(e) => e,
            },
            404 if caller == Caller::Claim => SyncError::new("sync.bad_code", body.message),
            503 if body.error == "not_configured" => {
                SyncError::new("sync.not_configured", NOT_CONFIGURED)
            }
            code => http(format!(
                "Server answered {code} {}: {}",
                body.error, body.message
            )),
        }
    }

    fn enrol(
        &self,
        server: &Url,
        enrolled: Enrolled,
        device_id: &str,
        device_name: &str,
    ) -> Result<SpaceInfo, SyncError> {
        if enrolled.device_id != device_id {
            return Err(unexpected(StatusCode::OK));
        }
        self.tokens.put(&enrolled.space_id, &enrolled.token)?;
        let space = SpaceInfo {
            server: server.origin().ascii_serialization(),
            space_id: enrolled.space_id,
            device_id: device_id.to_string(),
            device_name: device_name.to_string(),
        };
        let _guard = self.guard()?;
        self.write(&Stored {
            space: space.clone(),
            revoked: false,
        })?;
        Ok(space)
    }

    pub async fn setup(
        &self,
        server: &str,
        secret: &str,
        device_id: &str,
        device_name: &str,
    ) -> Result<SpaceInfo, SyncError> {
        let server = server_url(server)?;
        self.tokens.probe()?;
        let url = endpoint(&server, &["space"])?;
        let request = self
            .http
            .post(url.clone())
            .header(AUTHORIZATION, format!("Bearer {secret}"))
            .json(&serde_json::json!({ "deviceId": device_id, "deviceName": device_name }));
        let enrolled: Enrolled = self.exchange(&url, request, Caller::Setup).await?;
        self.enrol(&server, enrolled, device_id, device_name)
    }

    pub async fn pair_join(
        &self,
        server: &str,
        code: &str,
        device_id: &str,
        device_name: &str,
    ) -> Result<SpaceInfo, SyncError> {
        let server = server_url(server)?;
        self.tokens.probe()?;
        let url = endpoint(&server, &["pair", "claim"])?;
        let request = self.http.post(url.clone()).json(&serde_json::json!({
            "code": code,
            "deviceId": device_id,
            "deviceName": device_name
        }));
        let enrolled: Enrolled = self.exchange(&url, request, Caller::Claim).await?;
        self.enrol(&server, enrolled, device_id, device_name)
    }

    fn authorised(&self, member: &Member, method: reqwest::Method, url: &Url) -> RequestBuilder {
        self.http
            .request(method, url.clone())
            .header(AUTHORIZATION, format!("Bearer {}", member.token))
    }

    pub async fn pair_code(&self) -> Result<PairCode, SyncError> {
        let member = self.member()?;
        let url = endpoint(&member.server, &["pair"])?;
        let request = self.authorised(&member, reqwest::Method::POST, &url);
        self.exchange(&url, request, Caller::Member).await
    }

    pub async fn ticket(&self, doc: &str) -> Result<Ticket, SyncError> {
        let member = self.member()?;
        let url = endpoint(&member.server, &["ticket"])?;
        let request = self
            .authorised(&member, reqwest::Method::POST, &url)
            .json(&serde_json::json!({ "doc": doc }));
        self.exchange(&url, request, Caller::Member).await
    }

    pub async fn devices(&self) -> Result<Vec<DeviceEntry>, SyncError> {
        let member = self.member()?;
        let url = endpoint(&member.server, &["devices"])?;
        let request = self.authorised(&member, reqwest::Method::GET, &url);
        let list: Devices = self.exchange(&url, request, Caller::Member).await?;
        Ok(list.devices)
    }

    pub async fn remove_device(&self, id: &str) -> Result<(), SyncError> {
        let member = self.member()?;
        let url = endpoint(&member.server, &["devices", id])?;
        let request = self.authorised(&member, reqwest::Method::DELETE, &url);
        let _: IgnoredAny = self.exchange(&url, request, Caller::Member).await?;
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
            fs::read(self.dir.path().join("sync.json")).ok()
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
                    .is_some_and(|digits| {
                        !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit())
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
            f.client().status().expect("status"),
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
        let status = client.status().expect("status");
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
            client.status(),
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
        assert_eq!(client.remove_device("dev00000000").await, not_joined);
        assert_all(mocks).await;
        assert_eq!(
            client.status(),
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
        client.mark_revoked().expect("mark_revoked");
        let revoked = SyncStatus {
            space: Some(f.space()),
            revoked: true,
        };
        assert_eq!(client.status(), Ok(revoked.clone()));
        assert_eq!(f.token(), None);
        assert_eq!(f.client().status(), Ok(revoked));
    }

    #[tokio::test]
    async fn a_revoked_device_makes_no_request() {
        let mut f = Fixture::new().await;
        f.join_with_token();
        f.client().mark_revoked().expect("mark_revoked");
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
        let e = f.client().status().expect_err("a corrupt sync.json");
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
        assert_eq!(client.reset(), Ok(()));
        assert_eq!(f.sync_json(), None);
        let bad = bad_files(f.dir.path());
        assert_eq!(bad.len(), 1, "{bad:?}");
        assert_eq!(
            fs::read(f.dir.path().join(&bad[0])).expect("read"),
            b"{".to_vec()
        );
        assert_eq!(
            client.status(),
            Ok(SyncStatus {
                space: None,
                revoked: false
            })
        );
        assert_eq!(f.token().as_deref(), Some(TOKEN));
        assert_eq!(client.reset(), Ok(()));
        assert_eq!(bad_files(f.dir.path()).len(), 1);
        assert_all(mocks).await;
    }

    #[tokio::test]
    async fn a_failed_reset_is_sync_io() {
        let f = Fixture::new().await;
        fs::write(f.dir.path().join("sync.json"), "{").expect("write");
        let e = {
            let _ro = ReadOnly::new(f.dir.path());
            f.client().reset().expect_err("a read-only dir")
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
            client.status(),
            Ok(SyncStatus {
                space: Some(f.space()),
                revoked: true
            })
        );
        assert_eq!(f.token(), None);
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
            f.client().status(),
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
            f.client().mark_revoked().expect_err("a read-only dir")
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
        f.server
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
        f.client().mark_revoked().expect("mark_revoked");
        f.answer("POST", "/pair/claim", 200, enrolled("tok_NEW_456"))
            .await;
        let client = f.client();
        let space = client
            .pair_join(&f.url(), "ABCD2345", DEVICE, "Mac")
            .await
            .expect("pair_join");
        assert_eq!(space, f.space());
        assert_eq!(
            client.status(),
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
    async fn a_silent_server_times_out_after_10_s() {
        let f = Fixture::new().await;
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = listener.local_addr().expect("addr").port();
        let started = std::time::Instant::now();
        let e = f
            .client()
            .setup(&format!("http://127.0.0.1:{port}"), "s3cr3t", DEVICE, "Mac")
            .await
            .expect_err("the server never answers");
        drop(listener);
        assert_eq!(e, err("sync.http", "127.0.0.1 did not answer within 10 s."));
        assert!(started.elapsed() >= std::time::Duration::from_secs(10));
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
                "Server answered 200 with an unexpected response."
            ))
        );
        assert_eq!(f.sync_json(), None);
        assert_eq!(f.token(), None);
    }

    #[test]
    fn a_sync_error_becomes_a_command_error() {
        assert_eq!(
            CommandError::from(err("sync.revoked", REVOKED)),
            CommandError::new("sync.revoked", REVOKED)
        );
    }
}
