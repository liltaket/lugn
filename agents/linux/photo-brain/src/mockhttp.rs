//! A tiny HTTP/1.1 server for tests (Lugn's endpoints and Apple's picture
//! host). One request per connection, `Connection: close`. Shared by the unit
//! tests and `tests/e2e.rs` (included there with `#[path]`).

#![allow(dead_code)]

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread::JoinHandle;

#[derive(Debug, Clone)]
pub struct Request {
    pub method: String,
    pub path: String,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl Request {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }
}

#[derive(Debug, Clone)]
pub struct Response {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl Response {
    pub fn status(status: u16) -> Self {
        Self {
            status,
            headers: Vec::new(),
            body: Vec::new(),
        }
    }
    pub fn json(body: &str) -> Self {
        Self {
            status: 200,
            headers: vec![("Content-Type".into(), "application/json".into())],
            body: body.as_bytes().to_vec(),
        }
    }
    pub fn bytes(body: Vec<u8>) -> Self {
        Self {
            status: 200,
            headers: vec![("Content-Type".into(), "image/jpeg".into())],
            body,
        }
    }
    pub fn redirect(to: &str) -> Self {
        Self {
            status: 302,
            headers: vec![("Location".into(), to.into())],
            body: Vec::new(),
        }
    }
}

type Handler = dyn Fn(&Request) -> Response + Send + Sync;

pub struct MockServer {
    port: u16,
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl MockServer {
    pub fn start(handler: impl Fn(&Request) -> Response + Send + Sync + 'static) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = listener.local_addr().unwrap().port();
        let stop = Arc::new(AtomicBool::new(false));
        let flag = stop.clone();
        let handler: Arc<Handler> = Arc::new(handler);
        let thread = std::thread::spawn(move || {
            for stream in listener.incoming() {
                if flag.load(Ordering::Relaxed) {
                    break;
                }
                let Ok(stream) = stream else { continue };
                let handler = handler.clone();
                std::thread::spawn(move || {
                    let _ = serve(stream, &*handler);
                });
            }
        });
        Self {
            port,
            stop,
            thread: Some(thread),
        }
    }

    pub fn url(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }
}

impl Drop for MockServer {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        let _ = TcpStream::connect(("127.0.0.1", self.port));
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

fn serve(stream: TcpStream, handler: &Handler) -> std::io::Result<()> {
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut line = String::new();
    reader.read_line(&mut line)?;
    let mut parts = line.split_whitespace();
    let method = parts.next().unwrap_or_default().to_string();
    let path = parts.next().unwrap_or_default().to_string();
    let mut headers = Vec::new();
    loop {
        line.clear();
        reader.read_line(&mut line)?;
        let trimmed = line.trim_end();
        if trimmed.is_empty() {
            break;
        }
        if let Some((k, v)) = trimmed.split_once(':') {
            headers.push((k.trim().to_string(), v.trim().to_string()));
        }
    }
    let length = headers
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case("content-length"))
        .and_then(|(_, v)| v.parse::<usize>().ok())
        .unwrap_or(0);
    let mut body = vec![0u8; length];
    reader.read_exact(&mut body)?;
    let response = handler(&Request {
        method,
        path,
        headers,
        body,
    });
    let mut out = stream;
    write!(
        out,
        "HTTP/1.1 {} X\r\nContent-Length: {}\r\nConnection: close\r\n",
        response.status,
        response.body.len()
    )?;
    for (k, v) in &response.headers {
        write!(out, "{k}: {v}\r\n")?;
    }
    out.write_all(b"\r\n")?;
    out.write_all(&response.body)?;
    out.flush()
}
