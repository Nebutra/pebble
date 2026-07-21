//! Local dictation session plumbing: a per-session engine thread fed over a
//! channel, mirroring Electron's stt-worker message flow (init/feed/stop).
//! The engine trait keeps sherpa-onnx behind a seam so audio plumbing is
//! testable with a fake engine and buildable without the native dependency.

use std::sync::mpsc;
use std::sync::Arc;
use tokio::sync::oneshot;

/// Transcript movement produced by one feed step.
#[derive(Debug, Default, PartialEq)]
pub struct EngineFeedOutput {
    /// In-progress text for the current utterance (streaming models only).
    pub partial: Option<String>,
    /// Utterance finalized mid-session by endpoint detection.
    pub finalized: Option<String>,
}

/// A loaded local recognizer. Implementations are not required to be Send:
/// the engine is created and used entirely on the session thread because
/// sherpa-onnx handles are raw pointers.
pub trait LocalDictationEngine {
    fn feed(&mut self, samples: &[f32]) -> Result<EngineFeedOutput, String>;
    /// Flush remaining audio and return any final transcript.
    fn finalize(&mut self) -> Result<Option<String>, String>;
}

/// Factory runs on the session thread so non-Send engines never cross threads.
pub type LocalEngineFactory =
    Box<dyn FnOnce() -> Result<Box<dyn LocalDictationEngine>, String> + Send>;

pub enum LocalSessionCommand {
    Feed(Vec<f32>),
    Stop { ack: oneshot::Sender<()> },
}

/// Events the session thread reports back for `pebble:speech-*` emission.
#[derive(Debug, Clone, PartialEq)]
pub enum LocalSpeechEvent {
    Partial(String),
    Final(String),
    Error(String),
    Stopped,
}

pub type LocalSpeechEventSink = Arc<dyn Fn(LocalSpeechEvent) + Send + Sync>;

pub struct LocalDictationHandle {
    pub commands: mpsc::Sender<LocalSessionCommand>,
    /// Resolves once the engine loaded (or failed to load) on its thread.
    pub ready: oneshot::Receiver<Result<(), String>>,
}

/// Spawn the session thread: load the engine, then serve feed/stop commands
/// until stop or until every command sender is dropped (session abandoned).
pub fn spawn_local_dictation(
    factory: LocalEngineFactory,
    sink: LocalSpeechEventSink,
) -> LocalDictationHandle {
    let (command_tx, command_rx) = mpsc::channel::<LocalSessionCommand>();
    let (ready_tx, ready_rx) = oneshot::channel::<Result<(), String>>();

    std::thread::Builder::new()
        .name("pebble-speech-local".to_string())
        .spawn(move || {
            let mut engine = match factory() {
                Ok(engine) => {
                    let _ = ready_tx.send(Ok(()));
                    engine
                }
                Err(error) => {
                    let _ = ready_tx.send(Err(error));
                    return;
                }
            };
            run_session_loop(engine.as_mut(), &command_rx, &sink);
        })
        .expect("spawn local dictation thread");

    LocalDictationHandle {
        commands: command_tx,
        ready: ready_rx,
    }
}

fn run_session_loop(
    engine: &mut dyn LocalDictationEngine,
    commands: &mpsc::Receiver<LocalSessionCommand>,
    sink: &LocalSpeechEventSink,
) {
    while let Ok(command) = commands.recv() {
        match command {
            LocalSessionCommand::Feed(samples) => match engine.feed(&samples) {
                Ok(output) => {
                    if let Some(text) = output.partial.filter(|t| !t.is_empty()) {
                        sink(LocalSpeechEvent::Partial(text));
                    }
                    if let Some(text) = output.finalized.filter(|t| !t.is_empty()) {
                        sink(LocalSpeechEvent::Final(text));
                    }
                }
                Err(error) => sink(LocalSpeechEvent::Error(error)),
            },
            LocalSessionCommand::Stop { ack } => {
                match engine.finalize() {
                    Ok(Some(text)) if !text.is_empty() => sink(LocalSpeechEvent::Final(text)),
                    Ok(_) => {}
                    Err(error) => sink(LocalSpeechEvent::Error(error)),
                }
                sink(LocalSpeechEvent::Stopped);
                let _ = ack.send(());
                return;
            }
        }
    }
    // Why: all senders dropped means the session was replaced or torn down;
    // still emit Stopped so the renderer state machine settles.
    sink(LocalSpeechEvent::Stopped);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    struct FakeEngine {
        fed: Arc<Mutex<Vec<Vec<f32>>>>,
        partial_every_feed: bool,
        endpoint_on_feed: Option<usize>,
        final_text: Option<String>,
        fail_feed: bool,
    }

    impl LocalDictationEngine for FakeEngine {
        fn feed(&mut self, samples: &[f32]) -> Result<EngineFeedOutput, String> {
            if self.fail_feed {
                return Err("feed exploded".to_string());
            }
            let mut fed = self.fed.lock().expect("fed lock");
            fed.push(samples.to_vec());
            let feed_count = fed.len();
            Ok(EngineFeedOutput {
                partial: self
                    .partial_every_feed
                    .then(|| format!("partial-{feed_count}")),
                finalized: (self.endpoint_on_feed == Some(feed_count))
                    .then(|| "endpoint utterance".to_string()),
            })
        }

        fn finalize(&mut self) -> Result<Option<String>, String> {
            Ok(self.final_text.clone())
        }
    }

    fn collecting_sink() -> (LocalSpeechEventSink, Arc<Mutex<Vec<LocalSpeechEvent>>>) {
        let events = Arc::new(Mutex::new(Vec::new()));
        let sink_events = events.clone();
        let sink: LocalSpeechEventSink =
            Arc::new(move |event| sink_events.lock().expect("events lock").push(event));
        (sink, events)
    }

    fn stop_and_wait(commands: &mpsc::Sender<LocalSessionCommand>) {
        let (ack_tx, ack_rx) = oneshot::channel();
        commands
            .send(LocalSessionCommand::Stop { ack: ack_tx })
            .expect("send stop");
        ack_rx.blocking_recv().expect("stop ack");
    }

    #[test]
    fn feeds_audio_and_emits_partials_then_final_on_stop() {
        let fed = Arc::new(Mutex::new(Vec::new()));
        let engine_fed = fed.clone();
        let factory: LocalEngineFactory = Box::new(move || {
            Ok(Box::new(FakeEngine {
                fed: engine_fed,
                partial_every_feed: true,
                endpoint_on_feed: None,
                final_text: Some("final text".to_string()),
                fail_feed: false,
            }) as Box<dyn LocalDictationEngine>)
        });
        let (sink, events) = collecting_sink();
        let LocalDictationHandle { commands, ready } = spawn_local_dictation(factory, sink);
        ready
            .blocking_recv()
            .expect("ready channel")
            .expect("ready");

        commands
            .send(LocalSessionCommand::Feed(vec![0.1, 0.2]))
            .expect("feed");
        commands
            .send(LocalSessionCommand::Feed(vec![0.3]))
            .expect("feed");
        stop_and_wait(&commands);

        assert_eq!(*fed.lock().expect("fed"), vec![vec![0.1, 0.2], vec![0.3]]);
        assert_eq!(
            *events.lock().expect("events"),
            vec![
                LocalSpeechEvent::Partial("partial-1".to_string()),
                LocalSpeechEvent::Partial("partial-2".to_string()),
                LocalSpeechEvent::Final("final text".to_string()),
                LocalSpeechEvent::Stopped,
            ]
        );
    }

    #[test]
    fn endpoint_detection_emits_mid_session_final() {
        let factory: LocalEngineFactory = Box::new(move || {
            Ok(Box::new(FakeEngine {
                fed: Arc::new(Mutex::new(Vec::new())),
                partial_every_feed: false,
                endpoint_on_feed: Some(1),
                final_text: None,
                fail_feed: false,
            }) as Box<dyn LocalDictationEngine>)
        });
        let (sink, events) = collecting_sink();
        let LocalDictationHandle { commands, ready } = spawn_local_dictation(factory, sink);
        ready
            .blocking_recv()
            .expect("ready channel")
            .expect("ready");

        commands
            .send(LocalSessionCommand::Feed(vec![0.5]))
            .expect("feed");
        stop_and_wait(&commands);

        assert_eq!(
            *events.lock().expect("events"),
            vec![
                LocalSpeechEvent::Final("endpoint utterance".to_string()),
                LocalSpeechEvent::Stopped,
            ]
        );
    }

    #[test]
    fn engine_load_failure_reports_through_ready_channel() {
        let factory: LocalEngineFactory = Box::new(|| Err("model load failed".to_string()));
        let (sink, events) = collecting_sink();
        let LocalDictationHandle {
            commands: _commands,
            ready,
        } = spawn_local_dictation(factory, sink);
        let ready = ready.blocking_recv().expect("ready channel");
        assert_eq!(ready, Err("model load failed".to_string()));
        assert!(events.lock().expect("events").is_empty());
    }

    #[test]
    fn feed_errors_surface_and_dropped_senders_emit_stopped() {
        let factory: LocalEngineFactory = Box::new(move || {
            Ok(Box::new(FakeEngine {
                fed: Arc::new(Mutex::new(Vec::new())),
                partial_every_feed: false,
                endpoint_on_feed: None,
                final_text: None,
                fail_feed: true,
            }) as Box<dyn LocalDictationEngine>)
        });
        let (sink, events) = collecting_sink();
        let LocalDictationHandle { commands, ready } = spawn_local_dictation(factory, sink);
        ready
            .blocking_recv()
            .expect("ready channel")
            .expect("ready");

        commands
            .send(LocalSessionCommand::Feed(vec![0.1]))
            .expect("feed");
        drop(commands);

        // Why: thread exit is asynchronous after the sender drops; poll briefly
        // instead of sleeping a fixed interval.
        for _ in 0..200 {
            if events
                .lock()
                .expect("events")
                .contains(&LocalSpeechEvent::Stopped)
            {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        let events = events.lock().expect("events");
        assert_eq!(
            *events,
            vec![
                LocalSpeechEvent::Error("feed exploded".to_string()),
                LocalSpeechEvent::Stopped,
            ]
        );
    }
}
