//! Passive keyboard watcher: typing on the desktop ends a Hub capture.
//!
//! Reads `/dev/input/event*` keyboards read-only, one blocking thread each.
//! It never grabs a device (no `EVIOCGRAB`) and never writes to one, so every
//! other reader, the compositor included, sees the same keys as before. Only
//! "a key that ends the capture went down" leaves the reader thread; no key
//! codes are kept or logged.

use std::{
    collections::{HashMap, HashSet},
    fs::File,
    io::{self, Read},
    path::Path,
    thread::{self, JoinHandle},
    time::Duration,
};

use tokio::sync::mpsc;

use crate::log;

const SYS_INPUT: &str = "/sys/class/input";
const DEV_INPUT: &str = "/dev/input";
const RESCAN: Duration = Duration::from_secs(3);

const EV_KEY: u16 = 1;
const KEY_A: u16 = 30;
const KEY_SPACE: u16 = 57;
/// Codes from here on are buttons (BTN_*) and other non-keyboard keys.
const FIRST_BUTTON: u16 = 0x100;
/// Keys that do not end a capture: volume, media and brightness keys are
/// commonly used while looking at the Hub.
const IGNORED: [u16; 10] = [
    113, // KEY_MUTE
    114, // KEY_VOLUMEDOWN
    115, // KEY_VOLUMEUP
    163, // KEY_NEXTSONG
    164, // KEY_PLAYPAUSE
    165, // KEY_PREVIOUSSONG
    166, // KEY_STOPCD
    224, // KEY_BRIGHTNESSDOWN
    225, // KEY_BRIGHTNESSUP
    248, // KEY_MICMUTE
];

/// `struct input_event`: a `struct timeval` (two longs), then type, code and
/// value. 24 bytes on 64-bit Linux.
const TIME_BYTES: usize = 2 * size_of::<usize>();
const EVENT_SIZE: usize = TIME_BYTES + 8;
/// Capability bitmaps are printed as `unsigned long` words.
const WORD_BITS: usize = usize::BITS as usize;

/// A key that ends the capture went down on some keyboard.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct KeyDown;

/// Whether a press of `code` ends a capture: keyboard keys, apart from
/// volume, media and brightness keys. Buttons (`BTN_*`) never do.
pub fn ends_capture(code: u16) -> bool {
    code < FIRST_BUTTON && !IGNORED.contains(&code)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct InputEvent {
    kind: u16,
    code: u16,
    value: i32,
}

impl InputEvent {
    /// Parses one `struct input_event` in the kernel's (native) byte order.
    fn parse(b: &[u8; EVENT_SIZE]) -> Self {
        let u16_at = |i: usize| u16::from_ne_bytes([b[i], b[i + 1]]);
        Self {
            kind: u16_at(TIME_BYTES),
            code: u16_at(TIME_BYTES + 2),
            value: i32::from_ne_bytes([
                b[TIME_BYTES + 4],
                b[TIME_BYTES + 5],
                b[TIME_BYTES + 6],
                b[TIME_BYTES + 7],
            ]),
        }
    }

    /// The whole events in one read; evdev never splits one, so a trailing
    /// fragment cannot occur and would be ignored.
    fn all_in(buf: &[u8]) -> impl Iterator<Item = Self> + '_ {
        buf.as_chunks::<EVENT_SIZE>().0.iter().map(Self::parse)
    }

    /// A first press (not a repeat, 2, or a release, 0) of a key that ends
    /// the capture.
    fn ends_capture(&self) -> bool {
        self.kind == EV_KEY && self.value == 1 && ends_capture(self.code)
    }
}

/// Whether bit `code` is set in a sysfs capability bitmap: hex words, most
/// significant first, separated by spaces.
fn has_bit(bitmap: &str, code: u16) -> bool {
    let words: Vec<&str> = bitmap.split_whitespace().collect();
    let (index, bit) = (usize::from(code) / WORD_BITS, usize::from(code) % WORD_BITS);
    let Some(word) = index
        .checked_add(1)
        .and_then(|i| words.len().checked_sub(i))
        .map(|i| words[i])
    else {
        return false;
    };
    usize::from_str_radix(word, 16).is_ok_and(|w| w >> bit & 1 == 1)
}

/// A keyboard has letters and a space bar; mice, power buttons and media
/// remotes do not.
fn is_keyboard(key_bitmap: &str) -> bool {
    has_bit(key_bitmap, KEY_A) && has_bit(key_bitmap, KEY_SPACE)
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Keyboard {
    /// `eventN`, the node name under `/dev/input`.
    node: String,
    name: String,
}

/// Keyboards listed under `sys` (`/sys/class/input`), in node order.
fn keyboards(sys: &Path) -> Vec<Keyboard> {
    let Ok(entries) = std::fs::read_dir(sys) else {
        return Vec::new();
    };
    let mut found: Vec<Keyboard> = entries
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let node = e.file_name().into_string().ok()?;
            node.starts_with("event").then_some(())?;
            let device = e.path().join("device");
            let caps = std::fs::read_to_string(device.join("capabilities/key")).ok()?;
            is_keyboard(&caps).then_some(())?;
            let name = std::fs::read_to_string(device.join("name")).unwrap_or_default();
            Some(Keyboard {
                node,
                name: name.trim().to_string(),
            })
        })
        .collect();
    found.sort_by_key(|k| (k.node.len(), k.node.clone()));
    found
}

/// Starts the watcher. It rescans for keyboards every 3 s, runs on its own
/// threads and never blocks the caller.
pub fn spawn(tx: mpsc::Sender<KeyDown>) {
    if let Err(e) = thread::Builder::new()
        .name("keys-scan".into())
        .spawn(move || scan_loop(tx))
    {
        log!("keys: cannot start the keyboard watcher: {e}; typing does not end a capture");
    }
}

fn scan_loop(tx: mpsc::Sender<KeyDown>) {
    let mut watching: HashMap<String, JoinHandle<()>> = HashMap::new();
    // Nodes whose open failure was already logged; they are retried anyway,
    // since udev sets the ACL a moment after a device appears.
    let mut warned: HashSet<String> = HashSet::new();
    let mut none_logged = false;
    while !tx.is_closed() {
        // A reader ends (and logs) when its device goes away.
        watching.retain(|_, reader| !reader.is_finished());
        let found = keyboards(Path::new(SYS_INPUT));
        warned.retain(|node| found.iter().any(|k| &k.node == node));
        for kb in found {
            if watching.contains_key(&kb.node) {
                continue;
            }
            let path = Path::new(DEV_INPUT).join(&kb.node);
            // Read-only, never grabbed: other readers are unaffected.
            let file = match File::open(&path) {
                Ok(file) => file,
                Err(e) => {
                    if warned.insert(kb.node.clone()) {
                        log!("keys: cannot read {} ({:?}): {e}", kb.node, kb.name);
                    }
                    continue;
                }
            };
            warned.remove(&kb.node);
            let reader_tx = tx.clone();
            let label = format!("{} ({:?})", kb.node, kb.name);
            match thread::Builder::new()
                .name(format!("keys-{}", kb.node))
                .spawn(move || read_loop(file, &label, &reader_tx))
            {
                Ok(handle) => {
                    log!("keys: watching {} ({:?})", kb.node, kb.name);
                    watching.insert(kb.node, handle);
                }
                Err(e) => log!("keys: cannot start a reader for {}: {e}", kb.node),
            }
        }
        if watching.is_empty() {
            if !none_logged {
                log!(
                    "keys: no readable keyboard (needs read access to /dev/input/event*); \
                     typing does not end a capture"
                );
                none_logged = true;
            }
        } else {
            none_logged = false;
        }
        thread::sleep(RESCAN);
    }
}

/// Blocks on one device until it goes away (or the agent stops listening),
/// passing on only that a capture-ending key went down.
fn read_loop(mut file: File, label: &str, tx: &mpsc::Sender<KeyDown>) {
    // evdev hands out whole events only.
    let mut buf = [0u8; EVENT_SIZE * 64];
    let why = loop {
        let n = match file.read(&mut buf) {
            Ok(0) => break io::Error::from(io::ErrorKind::UnexpectedEof),
            Ok(n) => n,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
            Err(e) => break e,
        };
        let pressed = InputEvent::all_in(&buf[..n]).any(|ev| ev.ends_capture());
        // A full queue already holds a press; one is enough.
        if pressed && let Err(mpsc::error::TrySendError::Closed(_)) = tx.try_send(KeyDown) {
            return;
        }
    };
    log!("keys: lost {label}: {why}");
}

#[cfg(test)]
mod tests {
    use super::*;

    /// event4 for example, a USB keyboard.
    const KEYBOARD: &str = "3f0073bfff 0 0 483ffff17aff32d bfd4444600000000 1 \
                            130ff38b17d007 ffff7bfad941dfff ffbeffdfffefffff fffffffffffffffe";
    /// The same keyboard's mouse node: buttons only.
    const MOUSE: &str = "1f0000 0 0 0 0";

    fn raw(kind: u16, code: u16, value: i32) -> [u8; EVENT_SIZE] {
        let mut b = [0u8; EVENT_SIZE];
        b[..8].copy_from_slice(&1_700_000_000i64.to_ne_bytes()[..8]);
        b[TIME_BYTES..TIME_BYTES + 2].copy_from_slice(&kind.to_ne_bytes());
        b[TIME_BYTES + 2..TIME_BYTES + 4].copy_from_slice(&code.to_ne_bytes());
        b[TIME_BYTES + 4..].copy_from_slice(&value.to_ne_bytes());
        b
    }

    #[test]
    fn capability_bits_read_least_significant_word_last() {
        assert!(is_keyboard(KEYBOARD));
        assert!(has_bit(KEYBOARD, 1)); // KEY_ESC
        assert!(!has_bit(KEYBOARD, 0)); // KEY_RESERVED
        assert!(has_bit(KEYBOARD, 113)); // KEY_MUTE, in the second word
        assert!(!has_bit(KEYBOARD, 2000)); // past the bitmap
        assert!(!is_keyboard(MOUSE));
        // The mouse's buttons sit in the fifth word from the end.
        assert!(has_bit(MOUSE, 0x110)); // BTN_LEFT
        assert!(!has_bit(MOUSE, KEY_A));
        assert!(!is_keyboard("4000 0 0")); // a sleep button
        assert!(!is_keyboard("0"));
        assert!(!is_keyboard(""));
        assert!(!is_keyboard("zz"));
        // A bitmap with just letters but no space bar is not a keyboard.
        assert!(!is_keyboard(&format!("{:x}", 1u64 << KEY_A)));
        assert!(is_keyboard(&format!(
            "{:x}",
            (1u64 << KEY_A) | (1u64 << KEY_SPACE)
        )));
    }

    #[cfg(target_pointer_width = "64")]
    #[test]
    fn input_event_layout_is_24_bytes() {
        assert_eq!(EVENT_SIZE, 24);
    }

    #[test]
    fn input_events_parse_from_bytes() {
        assert_eq!(
            InputEvent::parse(&raw(EV_KEY, 30, 1)),
            InputEvent {
                kind: 1,
                code: 30,
                value: 1
            }
        );
        assert_eq!(
            InputEvent::parse(&raw(4, 4, 0x70004)), // EV_MSC MSC_SCAN
            InputEvent {
                kind: 4,
                code: 4,
                value: 0x70004
            }
        );
        let ev = InputEvent::parse(&raw(EV_KEY, 0x110, -1));
        assert_eq!((ev.code, ev.value), (0x110, -1));
        // A read holds several events back to back.
        let mut buf = Vec::new();
        for ev in [raw(4, 4, 7), raw(EV_KEY, 28, 1), raw(0, 0, 0)] {
            buf.extend_from_slice(&ev);
        }
        let codes: Vec<u16> = InputEvent::all_in(&buf).map(|e| e.code).collect();
        assert_eq!(codes, [4, 28, 0]);
        buf.push(0);
        assert_eq!(InputEvent::all_in(&buf).count(), 3);
        assert_eq!(InputEvent::all_in(&buf[..EVENT_SIZE - 1]).count(), 0);
    }

    #[test]
    fn typing_keys_end_the_capture() {
        for code in [
            30,  // KEY_A
            44,  // KEY_Z
            2,   // KEY_1
            28,  // KEY_ENTER
            57,  // KEY_SPACE
            1,   // KEY_ESC
            29,  // KEY_LEFTCTRL
            97,  // KEY_RIGHTCTRL
            125, // KEY_LEFTMETA (Super)
            42,  // KEY_LEFTSHIFT
            103, // KEY_UP
        ] {
            assert!(ends_capture(code), "{code}");
            assert!(InputEvent::parse(&raw(EV_KEY, code, 1)).ends_capture());
        }
    }

    #[test]
    fn media_keys_and_buttons_do_not() {
        for code in [113, 114, 115, 163, 164, 165, 166, 224, 225, 248] {
            assert!(!ends_capture(code), "{code}");
        }
        for code in [0x100, 0x110, 0x111, 0x14a, 0x2ff, u16::MAX] {
            assert!(!ends_capture(code), "{code:#x}");
        }
    }

    #[test]
    fn only_first_presses_count() {
        let ev = |kind, value| InputEvent::parse(&raw(kind, 30, value));
        assert!(ev(EV_KEY, 1).ends_capture());
        assert!(!ev(EV_KEY, 2).ends_capture()); // autorepeat
        assert!(!ev(EV_KEY, 0).ends_capture()); // release
        assert!(!ev(4, 1).ends_capture()); // EV_MSC
        assert!(!ev(0, 1).ends_capture()); // EV_SYN
        assert!(!InputEvent::parse(&raw(EV_KEY, 0x110, 1)).ends_capture());
        assert!(!InputEvent::parse(&raw(EV_KEY, 115, 1)).ends_capture());
    }

    #[test]
    fn scan_finds_keyboards_in_sysfs() {
        let root = std::env::temp_dir().join(format!("lugn-keys-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let node = |n: &str, name: &str, caps: Option<&str>| {
            let dev = root.join(n).join("device");
            std::fs::create_dir_all(dev.join("capabilities")).unwrap();
            std::fs::write(dev.join("name"), format!("{name}\n")).unwrap();
            if let Some(caps) = caps {
                std::fs::write(dev.join("capabilities/key"), format!("{caps}\n")).unwrap();
            }
        };
        node("event10", "  Wireless Keyboard", Some(KEYBOARD));
        node("event4", "USB Keyboard", Some(KEYBOARD));
        node("event5", "USB Mouse", Some(MOUSE));
        node("event12", "HDMI audio", Some("0"));
        node("event13", "no caps", None);
        node("mouse0", "not an event node", Some(KEYBOARD));
        let found = keyboards(&root);
        std::fs::remove_dir_all(&root).unwrap();
        assert_eq!(
            found,
            [
                Keyboard {
                    node: "event4".into(),
                    name: "USB Keyboard".into()
                },
                Keyboard {
                    node: "event10".into(),
                    name: "Wireless Keyboard".into()
                },
            ]
        );
        assert!(keyboards(Path::new("/nonexistent/lugn")).is_empty());
    }

    /// Opens this machine's real keyboards read-only for 2 s and prints
    /// what was found (names only). Run by hand:
    /// `cargo test real_keyboards -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn real_keyboards_are_readable() {
        let found = keyboards(Path::new(SYS_INPUT));
        println!("keyboards in {SYS_INPUT}: {}", found.len());
        for kb in &found {
            let open = File::open(Path::new(DEV_INPUT).join(&kb.node));
            println!(
                "  {} {:?}: {}",
                kb.node,
                kb.name,
                open.map_or_else(|e| format!("not readable ({e})"), |_| "readable".into())
            );
        }
        let (tx, mut rx) = mpsc::channel(16);
        spawn(tx);
        thread::sleep(Duration::from_secs(2));
        let mut presses = 0;
        while rx.try_recv().is_ok() {
            presses += 1;
        }
        println!("capture-ending presses in 2 s: {presses}");
    }
}
