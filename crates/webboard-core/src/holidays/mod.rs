mod cache;
mod govuk;
mod ics;
mod openholidays;
mod opm;

use std::path::PathBuf;
use std::time::Duration;

use chrono::{Datelike, NaiveDate};
use reqwest::header::{HeaderMap, CONTENT_TYPE, RETRY_AFTER, USER_AGENT};
use reqwest::{StatusCode, Url};
use serde::{Deserialize, Serialize};

use crate::error::{CommandError, Result};
use cache::Cache;

pub use ics::{consumer_calendar_host, ics_days};

const WEBBOARD_UA: &str = concat!(
    "WebBoard/",
    env!("CARGO_PKG_VERSION"),
    " (+https://webboard.rokass.org)"
);
const BROWSER_UA: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15";
const TIMEOUT_SECS: u64 = 20;
const YEARS: (i32, i32) = (1900, 2200);

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "src", rename_all = "lowercase")]
pub enum RegionRef {
    Openholidays {
        country: String,
        subdivision: Option<String>,
    },
    Govuk {
        division: String,
    },
    Opm,
    Ics {
        url: String,
        name: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum HolidayKind {
    Public,
    Optional,
    Half,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HolidayDay {
    pub date: String,
    pub name: String,
    pub kind: HolidayKind,
    pub source_id: String,
    pub scope: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Sources {
    pub openholidays: String,
    pub govuk: String,
    pub opm: String,
}

impl Sources {
    pub fn official() -> Self {
        Self {
            openholidays: "https://openholidaysapi.org".into(),
            govuk: "https://www.gov.uk/bank-holidays.json".into(),
            opm:
                "https://www.opm.gov/policy-data-oversight/pay-leave/federal-holidays/holidays.ics"
                    .into(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Country {
    pub code: String,
    pub name: String,
    pub src: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Subdivision {
    pub code: String,
    pub name: String,
    pub children: Vec<Subdivision>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct YearOut {
    pub days: Vec<HolidayDay>,
    pub fetched_at: String,
    pub from_cache: bool,
    pub coverage: Option<(i32, i32)>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewDay {
    pub date: String,
    pub name: String,
}

pub struct Holidays {
    cache: Cache,
    sources: Sources,
    client: reqwest::Client,
}

struct Req<'a> {
    src: &'a str,
    key: &'a str,
    url: &'a str,
    query: &'a [(&'a str, &'a str)],
}

struct Meta {
    fetched_at: String,
    from_cache: bool,
}

fn host_of(url: &str) -> String {
    match Url::parse(url) {
        Ok(u) => u.host_str().map_or_else(|| url.to_string(), str::to_string),
        Err(_) => url.to_string(),
    }
}

fn innermost(e: &(dyn std::error::Error + 'static)) -> String {
    let mut cur = e;
    while let Some(next) = cur.source() {
        cur = next;
    }
    cur.to_string()
}

fn chain<'a>(
    e: &'a (dyn std::error::Error + 'static),
) -> Vec<&'a (dyn std::error::Error + 'static)> {
    std::iter::successors(Some(e), |cur| cur.source())
        .flat_map(|cur| {
            let wrapped = cur
                .downcast_ref::<std::io::Error>()
                .and_then(|io| io.get_ref())
                .map(|inner| inner as &(dyn std::error::Error + 'static));
            std::iter::once(cur).chain(wrapped)
        })
        .collect()
}

#[cfg(target_vendor = "apple")]
fn is_tls_error(e: &(dyn std::error::Error + 'static)) -> bool {
    e.is::<native_tls::Error>()
}

#[cfg(not(target_vendor = "apple"))]
fn is_tls_error(e: &(dyn std::error::Error + 'static)) -> bool {
    e.is::<rustls::Error>()
}

fn transport_error(url: &str, e: &reqwest::Error) -> CommandError {
    let host = host_of(url);
    if e.is_timeout() {
        CommandError::new(
            "holidays.offline",
            format!("{host} did not answer within {TIMEOUT_SECS} s."),
        )
    } else if chain(e).into_iter().any(is_tls_error) {
        CommandError::new(
            "holidays.http",
            format!(
                "Could not make a secure connection to {host}: {}.",
                innermost(e)
            ),
        )
    } else if e.is_connect() {
        CommandError::new(
            "holidays.offline",
            format!("Could not reach {host}: {}.", innermost(e)),
        )
    } else if e.is_request() || e.is_body() {
        CommandError::new(
            "holidays.http",
            format!("The exchange with {host} failed: {}.", innermost(e)),
        )
    } else if e.is_decode() {
        CommandError::new(
            "holidays.parse",
            format!(
                "{host} sent an answer WebBoard could not decode: {}.",
                innermost(e)
            ),
        )
    } else {
        CommandError::new(
            "holidays.http",
            format!("Could not fetch from {host}: {}.", innermost(e)),
        )
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<Vec<_>>()
        .join(" ")
}

fn wait_of(headers: &HeaderMap) -> String {
    let Some(value) = headers.get(RETRY_AFTER) else {
        return "wait".to_string();
    };
    match value.to_str().map(str::trim) {
        Ok(text) => match text.parse::<u64>() {
            Ok(secs) => format!("wait {secs} s"),
            Err(_) => format!("wait until {text}"),
        },
        Err(_) => format!(
            "wait (its Retry-After header is not text: {})",
            hex(value.as_bytes())
        ),
    }
}

fn charset_of(headers: &HeaderMap) -> std::result::Result<Option<String>, String> {
    let Some(value) = headers.get(CONTENT_TYPE) else {
        return Ok(None);
    };
    let text = value.to_str().map_err(|_| {
        format!(
            "a Content-Type header that is not text: {}",
            hex(value.as_bytes())
        )
    })?;
    Ok(text.split(';').skip(1).find_map(|param| {
        let (name, value) = param.split_once('=')?;
        name.trim()
            .eq_ignore_ascii_case("charset")
            .then(|| value.trim().trim_matches('"').to_ascii_lowercase())
    }))
}

fn decode_text(url: &str, headers: &HeaderMap, bytes: Vec<u8>) -> Result<String> {
    let host = host_of(url);
    let parse = |what: String| CommandError::new("holidays.parse", format!("{host} sent {what}."));
    let charset = charset_of(headers).map_err(parse)?;
    match charset.as_deref() {
        None | Some("utf-8" | "utf8") => {}
        Some("us-ascii") if bytes.is_ascii() => {}
        Some("us-ascii") => {
            return Err(parse(
                "text it calls us-ascii that holds bytes outside ASCII".to_string(),
            ))
        }
        Some(other) => {
            return Err(parse(format!(
                "text in the charset {other}; WebBoard reads only UTF-8"
            )))
        }
    }
    String::from_utf8(bytes).map_err(|e| {
        let at = e.utf8_error().valid_up_to();
        let len = e
            .utf8_error()
            .error_len()
            .unwrap_or(e.as_bytes().len() - at);
        let bad = hex(&e.as_bytes()[at..at + len]);
        parse(format!(
            "text that is not UTF-8: the bytes {bad} at offset {at}"
        ))
    })
}

fn status_error(url: &str, status: StatusCode, headers: &HeaderMap) -> CommandError {
    let host = host_of(url);
    if status == StatusCode::TOO_MANY_REQUESTS {
        let wait = wait_of(headers);
        CommandError::new(
            "holidays.rate_limited",
            format!("{host} asked WebBoard to {wait} before asking again (HTTP 429)."),
        )
    } else {
        CommandError::new(
            "holidays.http",
            format!("{host} answered HTTP {}.", status.as_u16()),
        )
    }
}

fn out_of_range(what: &str, (from, to): (i32, i32), year: i32) -> CommandError {
    CommandError::new(
        "holidays.out_of_range",
        format!("{what} for {from}–{to}, not {year}."),
    )
}

fn unsupported(message: String) -> CommandError {
    CommandError::new("holidays.unsupported", message)
}

fn iso(d: NaiveDate) -> String {
    d.format("%Y-%m-%d").to_string()
}

fn covers(coverage: Option<(i32, i32)>, year: i32) -> bool {
    coverage.is_none_or(|(from, to)| (from..=to).contains(&year))
}

const GOVUK_DIVISIONS: [(&str, &str); 3] = [
    ("england-and-wales", "England and Wales"),
    ("scotland", "Scotland"),
    ("northern-ireland", "Northern Ireland"),
];

impl Holidays {
    pub fn new(cache_dir: PathBuf, s: Sources) -> Result<Self> {
        let cache = Cache::new(cache_dir)?;
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(TIMEOUT_SECS))
            .user_agent(WEBBOARD_UA)
            .build()
            .map_err(|e| {
                CommandError::new(
                    "holidays.io",
                    format!("Could not start the HTTP client: {}.", innermost(&e)),
                )
            })?;
        Ok(Self {
            cache,
            sources: s,
            client,
        })
    }

    async fn get(&self, url: &str, query: &[(&str, &str)]) -> Result<String> {
        let parsed = Url::parse(url).map_err(|e| {
            CommandError::new("holidays.http", format!("{url} is not a web address: {e}."))
        })?;
        let mut request = self.client.get(parsed).query(query);
        if url == self.sources.opm {
            request = request.header(USER_AGENT, BROWSER_UA);
        }
        let response = request.send().await.map_err(|e| transport_error(url, &e))?;
        let status = response.status();
        if !status.is_success() {
            return Err(status_error(url, status, response.headers()));
        }
        let headers = response.headers().clone();
        let bytes = response
            .bytes()
            .await
            .map_err(|e| transport_error(url, &e))?;
        decode_text(url, &headers, bytes.to_vec())
    }

    async fn load<T>(
        &self,
        req: &Req<'_>,
        fresh: bool,
        parse: impl Fn(&str) -> Result<T>,
    ) -> Result<(T, Meta)> {
        if !fresh {
            if let Some(entry) = self.cache.read(req.src, req.key)? {
                let value = parse(&entry.body)?;
                return Ok((
                    value,
                    Meta {
                        fetched_at: entry.fetched_at,
                        from_cache: true,
                    },
                ));
            }
        }
        let body = self.get(req.url, req.query).await?;
        let value = parse(&body)?;
        let entry = self.cache.write(req.src, req.key, body)?;
        Ok((
            value,
            Meta {
                fetched_at: entry.fetched_at,
                from_cache: false,
            },
        ))
    }

    pub async fn countries(&self) -> Result<Vec<Country>> {
        let listed = self.oh_country_list().await?;
        Ok(listed
            .into_iter()
            .filter(|(code, _)| code != "GB" && code != "US")
            .map(|(code, name)| Country {
                code,
                name,
                src: "openholidays".into(),
            })
            .chain([
                Country {
                    code: "GB".into(),
                    name: "United Kingdom".into(),
                    src: "govuk".into(),
                },
                Country {
                    code: "US".into(),
                    name: "United States (federal)".into(),
                    src: "opm".into(),
                },
            ])
            .collect())
    }

    pub async fn subdivisions(&self, country: &str) -> Result<Vec<Subdivision>> {
        match country {
            "GB" => Ok(GOVUK_DIVISIONS
                .iter()
                .map(|(code, name)| Subdivision {
                    code: (*code).into(),
                    name: (*name).into(),
                    children: vec![],
                })
                .collect()),
            "US" => Ok(vec![]),
            _ => self.oh_subdivisions(country).await,
        }
    }

    pub async fn year(&self, region: &RegionRef, year: i32, fresh: bool) -> Result<YearOut> {
        if !covers(Some(YEARS), year) {
            return Err(out_of_range("WebBoard shows holidays", YEARS, year));
        }
        match region {
            RegionRef::Openholidays {
                country,
                subdivision,
            } => {
                self.oh_year(country, subdivision.as_deref(), year, fresh)
                    .await
            }
            RegionRef::Govuk { division } => self.govuk_year(division, year, fresh).await,
            RegionRef::Opm => self.opm_year(year, fresh).await,
            RegionRef::Ics { url, name } => self.ics_year(url, name, year, fresh).await,
        }
    }

    pub async fn ics_preview(&self, url: &str, today: NaiveDate) -> Result<Vec<PreviewDay>> {
        let who = format!("The calendar at {}", host_of(url));
        let key = cache::url_key(url);
        let at = ics::FeedAt {
            src: "ics",
            key: &key,
            url,
            who: &who,
        };
        let feed = self.ics_feed(&at, true).await?.0;
        let consumer = consumer_calendar_host(url)?;
        let first = today.year();
        let mut days = [first, first + 1]
            .into_iter()
            .map(|y| feed.days(y, consumer))
            .collect::<Result<Vec<_>>>()?
            .into_iter()
            .flatten()
            .map(|d| PreviewDay {
                date: d.date,
                name: d.name,
            })
            .collect::<Vec<_>>();
        days.sort_by(|a, b| (&a.date, &a.name).cmp(&(&b.date, &b.name)));
        Ok(days)
    }
}
