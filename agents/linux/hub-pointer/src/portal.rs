//! xdg-desktop-portal InputCapture calls, each bounded by a timeout so a
//! stuck portal can never stall the event loop indefinitely.

use std::{future::Future, os::fd::OwnedFd, time::Duration};

use anyhow::{Context, Result, anyhow, bail};
use ashpd::desktop::{
    ResponseError, Session,
    input_capture::{
        Barrier, BarrierID, Capabilities, ConnectToEISOptions, CreateSessionOptions,
        DisableOptions, EnableOptions, GetZonesOptions, InputCapture, ReleaseOptions,
        SetPointerBarriersOptions,
    },
};

use crate::{
    capture::{Zone, barrier_lines},
    log,
};

const SETUP_TIMEOUT: Duration = Duration::from_secs(30);
const ARM_TIMEOUT: Duration = Duration::from_secs(10);
/// Release/Disable guard the user's pointer: if they do not answer quickly the
/// caller exits, which closes the session and frees the pointer.
const RELEASE_TIMEOUT: Duration = Duration::from_secs(2);

pub const BARRIER_ID: u32 = 1;

async fn bounded<T>(
    what: &str,
    limit: Duration,
    fut: impl Future<Output = ashpd::Result<T>>,
) -> Result<T> {
    tokio::time::timeout(limit, fut)
        .await
        .map_err(|_| anyhow!("{what}: no answer within {limit:?}"))?
        .with_context(|| what.to_string())
}

/// For calls that hand the pointer back. An error reply means the portal is
/// alive and the capture is already gone (e.g. the compositor ended it), so
/// it is only logged; silence is fatal. Returns whether the call succeeded.
async fn guarded(what: &str, fut: impl Future<Output = ashpd::Result<()>>) -> Result<bool> {
    match tokio::time::timeout(RELEASE_TIMEOUT, fut).await {
        Ok(Ok(())) => Ok(true),
        Ok(Err(e)) => {
            log!("portal: {what} failed: {e}");
            Ok(false)
        }
        Err(_) => bail!("{what}: no answer within {RELEASE_TIMEOUT:?}"),
    }
}

/// The user declined pointer capture. Restarting would only show the dialog
/// again, so the process exits with a status systemd will not restart on.
#[derive(Debug)]
pub struct Denied;

pub const DENIED_EXIT_STATUS: u8 = 3;

impl std::fmt::Display for Denied {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("pointer capture was not allowed in the portal dialog")
    }
}

impl std::error::Error for Denied {}

#[derive(Debug, Clone, PartialEq)]
pub struct ZoneSet {
    pub id: u32,
    pub zones: Vec<Zone>,
}

pub struct Portal {
    pub ic: InputCapture,
    pub session: Session<InputCapture>,
    /// Object path of `session`, to pick our signals out of the portal's.
    pub session_path: String,
}

impl Portal {
    /// Creates a pointer-only session and returns it with its EIS socket.
    pub async fn open() -> Result<(Self, OwnedFd)> {
        let ic = bounded(
            "connecting to InputCapture portal",
            SETUP_TIMEOUT,
            InputCapture::new(),
        )
        .await?;
        log!("portal: InputCapture interface version {}", ic.version());
        log!("portal: creating session (POINTER only); approve the dialog if one appears");
        // Version 1 portals only have CreateSession, which also starts the
        // session. No timeout: it waits for the user to answer KDE's "Input
        // Capture Requested" dialog, and nothing is captured meanwhile.
        let options = CreateSessionOptions::default().set_capabilities(Capabilities::POINTER);
        let (session, caps) = match ic.create_session(None, options).await {
            Ok(created) => created,
            Err(ashpd::Error::Response(ResponseError::Cancelled)) => return Err(Denied.into()),
            Err(e) => return Err(e).context("CreateSession"),
        };
        // ashpd keeps the path crate-private but serializes a session as it.
        let session_path = match serde_json::to_value(&session) {
            Ok(serde_json::Value::String(path)) => path,
            other => bail!("cannot read the session path: {other:?}"),
        };
        log!("portal: session {session_path} capabilities {caps:?}");
        if !caps.contains(Capabilities::POINTER) {
            return Err(Denied.into());
        }
        let fd = bounded(
            "ConnectToEIS",
            SETUP_TIMEOUT,
            ic.connect_to_eis(&session, ConnectToEISOptions::default()),
        )
        .await?;
        log!("portal: ConnectToEIS ok");
        Ok((
            Self {
                ic,
                session,
                session_path,
            },
            fd,
        ))
    }

    pub async fn zones(&self) -> Result<ZoneSet> {
        let request = bounded(
            "GetZones",
            ARM_TIMEOUT,
            self.ic.zones(&self.session, GetZonesOptions::default()),
        )
        .await?;
        let zones = request.response().context("GetZones response")?;
        Ok(ZoneSet {
            id: zones.zone_set(),
            zones: zones
                .regions()
                .iter()
                .map(|r| Zone {
                    x: r.x_offset(),
                    y: r.y_offset(),
                    width: r.width(),
                    height: r.height(),
                })
                .collect(),
        })
    }

    /// Places the barrier and enables capture. Fails if the compositor
    /// rejects the barrier, since then nothing could ever activate.
    pub async fn arm(&self, zone_set: u32, zone: Zone) -> Result<()> {
        let id = BarrierID::new(BARRIER_ID).expect("non-zero");
        let mut accepted = None;
        for line in barrier_lines(zone) {
            let barriers = [Barrier::new(id, line)];
            let request = bounded(
                "SetPointerBarriers",
                ARM_TIMEOUT,
                self.ic.set_pointer_barriers(
                    &self.session,
                    &barriers,
                    zone_set,
                    SetPointerBarriersOptions::default(),
                ),
            )
            .await?;
            let failed = request
                .response()
                .context("SetPointerBarriers response")?
                .failed_barriers()
                .to_vec();
            log!(
                "portal: SetPointerBarriers {line:?} zone_set {zone_set} failed_barriers {failed:?}"
            );
            if failed.is_empty() {
                accepted = Some(line);
                break;
            }
        }
        if accepted.is_none() {
            bail!("compositor rejected every left-edge barrier for {zone:?}");
        }
        bounded(
            "Enable",
            ARM_TIMEOUT,
            self.ic.enable(&self.session, EnableOptions::default()),
        )
        .await?;
        log!("portal: Enable ok, barrier armed");
        Ok(())
    }

    pub async fn disarm(&self) -> Result<()> {
        let call = self.ic.disable(&self.session, DisableOptions::default());
        if guarded("Disable", call).await? {
            log!("portal: Disable ok, barrier disarmed");
        }
        Ok(())
    }

    pub async fn release(
        &self,
        activation_id: Option<u32>,
        cursor: Option<(f64, f64)>,
    ) -> Result<()> {
        let options = ReleaseOptions::default()
            .set_activation_id(activation_id)
            .set_cursor_position(cursor);
        if guarded("Release", self.ic.release(&self.session, options)).await? {
            log!("portal: Release ok (activation {activation_id:?}, cursor {cursor:?})");
        }
        Ok(())
    }

    pub async fn close(&self) {
        match bounded("closing session", RELEASE_TIMEOUT, self.session.close()).await {
            Ok(()) => log!("portal: session closed"),
            Err(e) => log!("portal: {e:#}"),
        }
    }
}
