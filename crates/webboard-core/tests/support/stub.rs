use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

pub const FIXTURES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/holidays/");

pub fn fixture(name: &str) -> Vec<u8> {
    std::fs::read(format!("{FIXTURES}{name}"))
        .unwrap_or_else(|e| panic!("fixture {name} is missing: {e}"))
}

#[derive(Clone, Debug)]
pub struct Reply {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl Reply {
    pub fn body(content_type: &str, body: Vec<u8>) -> Self {
        Self {
            status: 200,
            headers: vec![("Content-Type".into(), content_type.into())],
            body,
        }
    }

    pub fn json(body: Vec<u8>) -> Self {
        Self::body("application/json", body)
    }

    pub fn file(name: &str) -> Self {
        let kind = if name.ends_with(".ics") {
            "text/calendar"
        } else {
            "application/json"
        };
        Self::body(kind, fixture(name))
    }

    pub fn status(status: u16) -> Self {
        Self {
            status,
            headers: vec![("Content-Type".into(), "text/plain".into())],
            body: format!("status {status}").into_bytes(),
        }
    }

    pub fn header(mut self, name: &str, value: &str) -> Self {
        self.headers.push((name.into(), value.into()));
        self
    }
}

#[derive(Clone, Debug)]
pub struct Seen {
    pub path: String,
    pub query: String,
    pub ua: String,
}

pub const OPM_PATH: &str = "/opm/holidays.ics";

pub fn recorded_routes() -> HashMap<String, Reply> {
    [
        ("/Countries", Reply::file("oh-countries.json")),
        ("/Subdivisions", Reply::file("oh-subdivisions-CH.json")),
        (
            "/Statistics/PublicHolidays",
            Reply::file("oh-stats-CH.json"),
        ),
        ("/PublicHolidays", Reply::file("oh-CH-ZH-2026.json")),
        (
            "/bank-holidays.json",
            Reply::file("govuk-bank-holidays.json"),
        ),
        (OPM_PATH, Reply::file("opm-holidays.ics")),
        ("/ics/mixed.ics", Reply::file("ics-mixed.ics")),
    ]
    .into_iter()
    .map(|(p, r)| (p.to_string(), r))
    .collect()
}

pub struct Stub {
    addr: SocketAddr,
    routes: Arc<Mutex<HashMap<String, Reply>>>,
    seen: Arc<Mutex<Vec<Seen>>>,
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

fn reason(status: u16) -> &'static str {
    match status {
        200 => "OK",
        400 => "Bad Request",
        403 => "Forbidden",
        404 => "Not Found",
        429 => "Too Many Requests",
        503 => "Service Unavailable",
        _ => "Status",
    }
}

fn read_request(stream: &TcpStream) -> std::io::Result<(String, String, String)> {
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut line = String::new();
    reader.read_line(&mut line)?;
    let target = line.split_whitespace().nth(1).unwrap_or("").to_string();
    let mut ua = String::new();
    loop {
        let mut header = String::new();
        if reader.read_line(&mut header)? == 0 || header == "\r\n" || header == "\n" {
            break;
        }
        if let Some((name, value)) = header.split_once(':') {
            if name.trim().eq_ignore_ascii_case("user-agent") {
                ua = value.trim().to_string();
            }
        }
    }
    let (path, query) = target
        .split_once('?')
        .map_or((target.clone(), String::new()), |(p, q)| {
            (p.to_string(), q.to_string())
        });
    Ok((path, query, ua))
}

fn has_param(query: &str, name: &str) -> bool {
    query
        .split('&')
        .any(|pair| pair.split('=').next() == Some(name))
}

fn answer(routes: &HashMap<String, Reply>, path: &str, query: &str, ua: &str) -> Reply {
    if path == "/PublicHolidays" && !(has_param(query, "validFrom") && has_param(query, "validTo"))
    {
        return Reply::body(
            "application/problem+json",
            br#"{"title":"One or more validation errors occurred.","status":400}"#.to_vec(),
        )
        .with_status(400);
    }
    if path == OPM_PATH && !ua.starts_with("Mozilla/5.0") {
        return Reply::status(403);
    }
    routes
        .get(path)
        .cloned()
        .unwrap_or_else(|| Reply::status(404))
}

impl Reply {
    fn with_status(mut self, status: u16) -> Self {
        self.status = status;
        self
    }
}

fn respond(mut stream: TcpStream, reply: &Reply) -> std::io::Result<()> {
    let mut head = format!(
        "HTTP/1.1 {} {}\r\nContent-Length: {}\r\nConnection: close\r\n",
        reply.status,
        reason(reply.status),
        reply.body.len()
    );
    reply
        .headers
        .iter()
        .for_each(|(n, v)| head.push_str(&format!("{n}: {v}\r\n")));
    head.push_str("\r\n");
    stream.write_all(head.as_bytes())?;
    stream.write_all(&reply.body)?;
    stream.flush()?;
    stream.shutdown(std::net::Shutdown::Both)
}

impl Stub {
    pub fn start(routes: HashMap<String, Reply>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind the stub on 127.0.0.1:0");
        let addr = listener.local_addr().expect("the stub has an address");
        let routes = Arc::new(Mutex::new(routes));
        let seen = Arc::new(Mutex::new(Vec::new()));
        let stop = Arc::new(AtomicBool::new(false));
        let thread = {
            let (routes, seen, stop) = (routes.clone(), seen.clone(), stop.clone());
            std::thread::spawn(move || {
                for stream in listener.incoming() {
                    if stop.load(Ordering::SeqCst) {
                        break;
                    }
                    let stream = stream.expect("the stub accepts a connection");
                    stream
                        .set_read_timeout(Some(Duration::from_secs(10)))
                        .expect("set the stub's read timeout");
                    let (path, query, ua) =
                        read_request(&stream).expect("the stub reads a request");
                    let reply = answer(&routes.lock().expect("routes"), &path, &query, &ua);
                    seen.lock().expect("seen").push(Seen { path, query, ua });
                    respond(stream, &reply).expect("the stub answers");
                }
            })
        };
        Self {
            addr,
            routes,
            seen,
            stop,
            thread: Some(thread),
        }
    }

    pub fn recorded() -> Self {
        Self::start(recorded_routes())
    }

    pub fn base(&self) -> String {
        format!("http://{}", self.addr)
    }

    pub fn set(&self, path: &str, reply: Reply) {
        self.routes
            .lock()
            .expect("routes")
            .insert(path.to_string(), reply);
    }

    pub fn seen(&self) -> Vec<Seen> {
        self.seen.lock().expect("seen").clone()
    }

    pub fn requests_to(&self, path: &str) -> usize {
        self.seen().iter().filter(|s| s.path == path).count()
    }

    pub fn stop(mut self) -> SocketAddr {
        self.stop.store(true, Ordering::SeqCst);
        TcpStream::connect(self.addr).expect("wake the stub's accept loop");
        self.thread
            .take()
            .expect("the stub runs")
            .join()
            .expect("the stub thread ends cleanly");
        let deadline = Instant::now() + Duration::from_secs(1);
        while TcpStream::connect(self.addr).is_ok() {
            assert!(
                Instant::now() < deadline,
                "{} still accepts connections 1 s after the stub stopped",
                self.addr
            );
            std::thread::sleep(Duration::from_millis(5));
        }
        self.addr
    }
}
