//! WebSocket side: authenticated upgrades and one task per page connection.

use std::{net::SocketAddr, sync::Arc, time::Duration};

use futures_util::{SinkExt, StreamExt};
use tokio::{
    net::{TcpListener, TcpStream},
    sync::{Semaphore, mpsc},
    time::timeout,
};
use tokio_tungstenite::{
    WebSocketStream, accept_hdr_async_with_config,
    tungstenite::{
        Message,
        handshake::server::{ErrorResponse, Request, Response},
        http::StatusCode,
        protocol::WebSocketConfig,
    },
};

use crate::{
    config::normalize_origin,
    log,
    protocol::{AgentMsg, PageMsg, decode_page},
};

pub const PATH: &str = "/hub-pointer";
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_PENDING_HANDSHAKES: usize = 8;
/// A page that cannot take a frame within this time is treated as gone.
const SEND_TIMEOUT: Duration = Duration::from_secs(2);
/// Outgoing frames buffered per page before it counts as stuck.
pub const OUT_QUEUE: usize = 256;

pub struct Auth {
    pub token: String,
    pub allowed_origins: Vec<String>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Reject {
    NotFound,
    BadToken,
    BadOrigin,
}

impl Reject {
    fn status(&self) -> StatusCode {
        match self {
            Self::NotFound => StatusCode::NOT_FOUND,
            Self::BadToken => StatusCode::UNAUTHORIZED,
            Self::BadOrigin => StatusCode::FORBIDDEN,
        }
    }
}

impl Auth {
    pub fn check(
        &self,
        path: &str,
        query: Option<&str>,
        origin: Option<&str>,
    ) -> Result<(), Reject> {
        if path != PATH {
            return Err(Reject::NotFound);
        }
        if !self.allowed_origins.is_empty() {
            let ok = origin
                .map(normalize_origin)
                .is_some_and(|o| self.allowed_origins.contains(&o));
            if !ok {
                return Err(Reject::BadOrigin);
            }
        }
        let token = query
            .and_then(|q| query_param(q, "token"))
            .unwrap_or_default();
        if !constant_time_eq(token.as_bytes(), self.token.as_bytes()) {
            return Err(Reject::BadToken);
        }
        Ok(())
    }
}

/// Compares without an early exit, so timing does not reveal how much of a
/// guessed token was right. Only the length can leak.
pub fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let diff = a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y));
    std::hint::black_box(diff) == 0
}

/// First value of `key` in a query string, decoded like `URLSearchParams`.
pub fn query_param(query: &str, key: &str) -> Option<String> {
    query.split('&').find_map(|pair| {
        let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
        (percent_decode(k)? == key)
            .then(|| percent_decode(v))
            .flatten()
    })
}

fn percent_decode(s: &str) -> Option<String> {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'+' => out.push(b' '),
            b'%' => {
                let hex = s.get(i + 1..i + 3)?;
                out.push(u8::from_str_radix(hex, 16).ok()?);
                i += 2;
            }
            b => out.push(b),
        }
        i += 1;
    }
    String::from_utf8(out).ok()
}

pub struct NewPage {
    pub ws: WebSocketStream<TcpStream>,
    pub peer: SocketAddr,
}

pub async fn accept_loop(listener: TcpListener, auth: Arc<Auth>, pages: mpsc::Sender<NewPage>) {
    let pending = Arc::new(Semaphore::new(MAX_PENDING_HANDSHAKES));
    loop {
        let (stream, peer) = match listener.accept().await {
            Ok(conn) => conn,
            Err(e) => {
                log!("accept failed: {e}");
                tokio::time::sleep(Duration::from_millis(100)).await;
                continue;
            }
        };
        let Ok(permit) = pending.clone().try_acquire_owned() else {
            log!("{peer}: too many pending handshakes, dropping");
            continue;
        };
        // Small frames at mouse rate: never wait for Nagle.
        let _ = stream.set_nodelay(true);
        let auth = auth.clone();
        let pages = pages.clone();
        tokio::spawn(async move {
            let _permit = permit;
            let config = WebSocketConfig::default()
                .max_message_size(Some(64 << 10))
                .max_frame_size(Some(64 << 10));
            // tungstenite's Callback trait fixes this error type.
            #[allow(clippy::result_large_err)]
            let callback = |req: &Request, resp: Response| {
                let origin = req.headers().get("origin").and_then(|v| v.to_str().ok());
                match auth.check(req.uri().path(), req.uri().query(), origin) {
                    Ok(()) => Ok(resp),
                    Err(reject) => {
                        log!("{peer}: rejected upgrade ({reject:?}, origin {origin:?})");
                        let mut err = ErrorResponse::new(None);
                        *err.status_mut() = reject.status();
                        Err(err)
                    }
                }
            };
            match timeout(
                HANDSHAKE_TIMEOUT,
                accept_hdr_async_with_config(stream, callback, Some(config)),
            )
            .await
            {
                Ok(Ok(ws)) => {
                    let _ = pages.send(NewPage { ws, peer }).await;
                }
                Ok(Err(e)) => log!("{peer}: handshake failed: {e}"),
                Err(_) => log!("{peer}: handshake timed out"),
            }
        });
    }
}

#[derive(Debug)]
pub enum PageEvent {
    Msg(u64, PageMsg),
    Closed(u64, String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum OutFrame {
    Move(String),
    Other(String),
}

impl OutFrame {
    fn from_msg(msg: &AgentMsg) -> Self {
        let text = msg.encode();
        match msg {
            AgentMsg::Move { .. } => Self::Move(text),
            _ => Self::Other(text),
        }
    }

    fn into_message(self) -> Message {
        match self {
            Self::Move(text) | Self::Other(text) => Message::text(text),
        }
    }
}

/// Collapses consecutive queued `move` frames down to the newest position
/// while stopping before any non-move frame (`button`, `wheel`, `leave`,
/// `enter`, `warm`, `ping`) so event ordering is preserved across Wi-Fi stalls.
fn coalesce_queued(
    first: OutFrame,
    rx: &mut mpsc::Receiver<OutFrame>,
    deferred: &mut Option<OutFrame>,
) -> OutFrame {
    let OutFrame::Move(mut latest) = first else {
        return first;
    };
    while let Ok(next) = rx.try_recv() {
        match next {
            OutFrame::Move(newer) => latest = newer,
            other @ OutFrame::Other(_) => {
                *deferred = Some(other);
                break;
            }
        }
    }
    OutFrame::Move(latest)
}

/// Handle to a running page connection. Dropping it lets the task flush
/// what is queued (bounded by `SEND_TIMEOUT`) and close the socket.
pub struct PageConn {
    pub id: u64,
    pub peer: SocketAddr,
    tx: mpsc::Sender<OutFrame>,
}

impl PageConn {
    pub fn spawn(id: u64, page: NewPage, events: mpsc::Sender<PageEvent>) -> Self {
        let (tx, rx) = mpsc::channel(OUT_QUEUE);
        tokio::spawn(run_page(id, page.ws, rx, events));
        Self {
            id,
            peer: page.peer,
            tx,
        }
    }

    /// Never waits: a full queue means the page stopped reading, and the
    /// caller must drop it rather than stall the input path.
    pub fn send(&self, msg: &AgentMsg) -> bool {
        self.tx.try_send(OutFrame::from_msg(msg)).is_ok()
    }
}

async fn run_page(
    id: u64,
    ws: WebSocketStream<TcpStream>,
    mut rx: mpsc::Receiver<OutFrame>,
    events: mpsc::Sender<PageEvent>,
) {
    let (mut sink, mut stream) = ws.split();
    let mut deferred: Option<OutFrame> = None;
    let reason = loop {
        let next = if let Some(frame) = deferred.take() {
            Some(frame)
        } else {
            tokio::select! {
                out = rx.recv() => out,
                frame = stream.next() => {
                    match frame {
                        Some(Ok(Message::Text(text))) => match decode_page(&text) {
                            Ok(Some(msg)) => {
                                if events.send(PageEvent::Msg(id, msg)).await.is_err() {
                                    return;
                                }
                            }
                            Ok(None) => {}
                            Err(e) => log!("page {id}: {e}"),
                        },
                        Some(Ok(Message::Close(_))) | None => break "closed by page".to_string(),
                        Some(Ok(_)) => {}
                        Some(Err(e)) => break format!("read failed: {e}"),
                    }
                    continue;
                }
            }
        };
        let Some(first) = next else {
            let _ = timeout(SEND_TIMEOUT, sink.send(Message::Close(None))).await;
            return;
        };
        let frame = coalesce_queued(first, &mut rx, &mut deferred);
        match timeout(SEND_TIMEOUT, sink.send(frame.into_message())).await {
            Ok(Ok(())) => {}
            Ok(Err(e)) => break format!("send failed: {e}"),
            Err(_) => break "send timed out".to_string(),
        }
    };
    let _ = events.send(PageEvent::Closed(id, reason)).await;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn auth(origins: &[&str]) -> Auth {
        Auth {
            token: "s3cr+t/x".into(),
            allowed_origins: origins.iter().map(|o| normalize_origin(o)).collect(),
        }
    }

    #[test]
    fn checks_path_token_and_origin() {
        let any = auth(&[]);
        let q = Some("token=s3cr%2Bt%2Fx");
        assert_eq!(any.check("/hub-pointer", q, None), Ok(()));
        assert_eq!(any.check("/hub-pointer", q, Some("http://x")), Ok(()));
        assert_eq!(any.check("/other", q, None), Err(Reject::NotFound));
        assert_eq!(
            any.check("/hub-pointer", Some("token=s3cr"), None),
            Err(Reject::BadToken)
        );
        assert_eq!(any.check("/hub-pointer", None, None), Err(Reject::BadToken));
        // Unencoded '+' decodes to a space, as URLSearchParams does.
        assert_eq!(
            any.check("/hub-pointer", Some("token=s3cr+t/x"), None),
            Err(Reject::BadToken)
        );

        let hub = auth(&["http://192.168.10.132:8788"]);
        assert_eq!(
            hub.check("/hub-pointer", q, Some("http://192.168.10.132:8788")),
            Ok(())
        );
        assert_eq!(
            hub.check("/hub-pointer", q, Some("http://evil.example")),
            Err(Reject::BadOrigin)
        );
        assert_eq!(hub.check("/hub-pointer", q, None), Err(Reject::BadOrigin));
    }

    #[test]
    fn parses_query_params() {
        assert_eq!(
            query_param("a=1&token=abc", "token").as_deref(),
            Some("abc")
        );
        assert_eq!(
            query_param("token=a%20b+c", "token").as_deref(),
            Some("a b c")
        );
        assert_eq!(
            query_param("token=1&token=2", "token").as_deref(),
            Some("1")
        );
        assert_eq!(query_param("token", "token").as_deref(), Some(""));
        assert_eq!(query_param("tok=1", "token"), None);
        assert_eq!(query_param("token=%zz", "token"), None);
        assert_eq!(query_param("token=%e", "token"), None);
    }

    #[test]
    fn constant_time_eq_matches_eq() {
        assert!(constant_time_eq(b"abc", b"abc"));
        assert!(!constant_time_eq(b"abc", b"abd"));
        assert!(!constant_time_eq(b"abc", b"abcd"));
        assert!(constant_time_eq(b"", b""));
    }

    #[test]
    fn coalesces_queued_moves_and_preserves_order_around_non_moves() {
        use crate::protocol::ButtonName;

        let (tx, mut rx) = mpsc::channel(OUT_QUEUE);
        for i in 1..=20 {
            tx.try_send(OutFrame::from_msg(&AgentMsg::Move {
                x: i as f64,
                y: 10.0,
            }))
            .unwrap();
        }
        let press = AgentMsg::Button {
            button: ButtonName::Left,
            down: true,
            x: 20.0,
            y: 10.0,
        };
        tx.try_send(OutFrame::from_msg(&press)).unwrap();
        for i in 21..=30 {
            tx.try_send(OutFrame::from_msg(&AgentMsg::Move {
                x: i as f64,
                y: 10.0,
            }))
            .unwrap();
        }
        tx.try_send(OutFrame::from_msg(&AgentMsg::Leave)).unwrap();
        drop(tx);

        let mut deferred = None;
        let mut drained = Vec::new();
        loop {
            let next = deferred.take().or_else(|| rx.try_recv().ok());
            let Some(first) = next else { break };
            let frame = coalesce_queued(first, &mut rx, &mut deferred);
            drained.push(frame);
        }

        // 20 moves -> 1 latest move before button; button; 10 moves -> 1 latest move; leave.
        assert_eq!(
            drained,
            vec![
                OutFrame::from_msg(&AgentMsg::Move { x: 20.0, y: 10.0 }),
                OutFrame::from_msg(&press),
                OutFrame::from_msg(&AgentMsg::Move { x: 30.0, y: 10.0 }),
                OutFrame::from_msg(&AgentMsg::Leave),
            ]
        );
    }

    #[test]
    fn non_move_frames_pass_through_unchanged() {
        let (tx, mut rx) = mpsc::channel(OUT_QUEUE);
        let enter = OutFrame::from_msg(&AgentMsg::Enter { x: 1.0, y: 2.0 });
        let ping = OutFrame::from_msg(&AgentMsg::Ping { id: 7 });
        tx.try_send(enter.clone()).unwrap();
        tx.try_send(ping.clone()).unwrap();
        drop(tx);

        let mut deferred = None;
        let first = rx.try_recv().unwrap();
        assert_eq!(coalesce_queued(first, &mut rx, &mut deferred), enter);
        assert_eq!(deferred, None);
        let second = rx.try_recv().unwrap();
        assert_eq!(coalesce_queued(second, &mut rx, &mut deferred), ping);
        assert_eq!(deferred, None);
    }

    #[tokio::test]
    async fn page_conn_coalesces_backlogged_moves_over_websocket() {
        use crate::protocol::ButtonName;
        use tokio_tungstenite::client_async;

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let auth = Arc::new(Auth {
            token: "tok".into(),
            allowed_origins: vec![],
        });
        let (pages_tx, mut pages_rx) = mpsc::channel(4);
        let accept = tokio::spawn(accept_loop(listener, auth, pages_tx));

        let tcp = TcpStream::connect(addr).await.unwrap();
        let (mut client, _) = client_async(format!("ws://{addr}/hub-pointer?token=tok"), tcp)
            .await
            .unwrap();
        let new_page = pages_rx.recv().await.unwrap();
        let (events_tx, _events_rx) = mpsc::channel(8);
        let conn = PageConn::spawn(1, new_page, events_tx);

        // Queue a burst synchronously before yielding to the page task.
        for i in 1..=20 {
            assert!(conn.send(&AgentMsg::Move {
                x: i as f64,
                y: 5.0,
            }));
        }
        let press = AgentMsg::Button {
            button: ButtonName::Left,
            down: true,
            x: 20.0,
            y: 5.0,
        };
        assert!(conn.send(&press));
        for i in 21..=30 {
            assert!(conn.send(&AgentMsg::Move {
                x: i as f64,
                y: 5.0,
            }));
        }
        assert!(conn.send(&AgentMsg::Leave));
        drop(conn);

        let mut received = Vec::new();
        while let Some(Ok(msg)) = client.next().await {
            match msg {
                Message::Text(text) => received.push(text.to_string()),
                Message::Close(_) => break,
                _ => {}
            }
        }
        accept.abort();

        // At most one move before press (latest x=20), press, at most one move
        // after press (latest x=30), and leave — never all 30 raw moves.
        assert!(
            received.len() <= 4,
            "received too many frames: {received:?}"
        );
        assert_eq!(
            received,
            vec![
                AgentMsg::Move { x: 20.0, y: 5.0 }.encode(),
                press.encode(),
                AgentMsg::Move { x: 30.0, y: 5.0 }.encode(),
                AgentMsg::Leave.encode(),
            ]
        );
    }
}
