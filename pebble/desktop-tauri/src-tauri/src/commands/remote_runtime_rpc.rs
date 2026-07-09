use std::{sync::Arc, time::Duration};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use crypto_box::{
    aead::{Aead, AeadCore, OsRng},
    PublicKey, SalsaBox, SecretKey,
};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::{
    net::TcpStream,
    sync::{mpsc, oneshot},
    task::JoinHandle,
    time::timeout,
};
use tokio_tungstenite::{connect_async, tungstenite::Message, MaybeTlsStream, WebSocketStream};
use uuid::Uuid;

const NONCE_LENGTH: usize = 24;
const BOX_OVERHEAD_LENGTH: usize = 16;

pub struct RemoteRuntimePairing {
    pub endpoint: String,
    pub device_token: String,
    pub public_key_b64: String,
}

pub struct RemoteRuntimeSubscription {
    pub request_id: String,
    binary_tx: mpsc::UnboundedSender<Vec<u8>>,
    cancel_tx: Option<oneshot::Sender<()>>,
    task: Option<JoinHandle<()>>,
}

pub struct RemoteRuntimeSubscriptionCallbacks {
    pub on_response: Box<dyn Fn(Value) + Send + Sync + 'static>,
    pub on_binary: Box<dyn Fn(Vec<u8>) + Send + Sync + 'static>,
    pub on_error: Box<dyn Fn(String, String) + Send + Sync + 'static>,
    pub on_close: Box<dyn Fn() + Send + Sync + 'static>,
}

type RemoteRuntimeSocket = WebSocketStream<MaybeTlsStream<TcpStream>>;

pub async fn call_remote_runtime(
    pairing: RemoteRuntimePairing,
    method: String,
    params: Option<Value>,
    timeout_ms: u64,
) -> Result<Value, String> {
    let timeout_duration = Duration::from_millis(timeout_ms.clamp(500, 120_000));
    timeout(
        timeout_duration,
        call_remote_runtime_inner(pairing, method, params),
    )
    .await
    .map_err(|_| "Timed out waiting for the remote Pebble runtime to respond.".to_string())?
}

async fn call_remote_runtime_inner(
    pairing: RemoteRuntimePairing,
    method: String,
    params: Option<Value>,
) -> Result<Value, String> {
    let (mut ws, cipher) = connect_authenticated_socket(&pairing).await?;
    send_runtime_json(
        &mut ws,
        &cipher,
        &json!({
            "id": Uuid::new_v4().to_string(),
            "deviceToken": pairing.device_token,
            "method": method,
            "params": params.unwrap_or(Value::Null),
        }),
    )
    .await
    .map_err(|_| "Could not send the remote Pebble runtime request.".to_string())?;

    loop {
        let frame = match next_remote_runtime_frame(&mut ws, &cipher).await? {
            RemoteRuntimeFrame::Json(frame) => frame,
            RemoteRuntimeFrame::Binary(_) => {
                return Err("Remote Pebble runtime returned an unexpected binary frame.".to_string())
            }
        };
        if frame
            .get("_keepalive")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            continue;
        }
        validate_runtime_rpc_response(&frame)?;
        return Ok(frame);
    }
}

pub async fn subscribe_remote_runtime_request(
    pairing: RemoteRuntimePairing,
    method: String,
    params: Option<Value>,
    timeout_ms: u64,
    callbacks: RemoteRuntimeSubscriptionCallbacks,
) -> Result<RemoteRuntimeSubscription, String> {
    let timeout_duration = Duration::from_millis(timeout_ms.clamp(500, 120_000));
    timeout(
        timeout_duration,
        subscribe_remote_runtime_request_inner(pairing, method, params, callbacks),
    )
    .await
    .map_err(|_| "Timed out while subscribing to the remote Pebble runtime.".to_string())?
}

async fn subscribe_remote_runtime_request_inner(
    pairing: RemoteRuntimePairing,
    method: String,
    params: Option<Value>,
    callbacks: RemoteRuntimeSubscriptionCallbacks,
) -> Result<RemoteRuntimeSubscription, String> {
    let (mut ws, cipher) = connect_authenticated_socket(&pairing).await?;
    let request_id = Uuid::new_v4().to_string();
    send_runtime_json(
        &mut ws,
        &cipher,
        &json!({
            "id": request_id,
            "deviceToken": pairing.device_token,
            "method": method,
            "params": params.unwrap_or(Value::Null),
        }),
    )
    .await
    .map_err(|_| "Could not send the remote Pebble runtime subscription.".to_string())?;

    let (binary_tx, mut binary_rx) = mpsc::unbounded_channel::<Vec<u8>>();
    let (cancel_tx, mut cancel_rx) = oneshot::channel::<()>();
    let request_id_for_task = request_id.clone();
    let task = tokio::spawn(async move {
        let cipher = Arc::new(cipher);
        loop {
            tokio::select! {
                _ = &mut cancel_rx => {
                    break;
                }
                maybe_bytes = binary_rx.recv() => {
                    let Some(bytes) = maybe_bytes else {
                        break;
                    };
                    let encrypted = encrypt_bytes(&cipher, &bytes);
                    if ws.send(Message::Binary(encrypted.into())).await.is_err() {
                        (callbacks.on_error)(
                            "remote_runtime_unavailable".to_string(),
                            "Could not send binary data to the remote Pebble runtime.".to_string(),
                        );
                        break;
                    }
                }
                frame = next_remote_runtime_frame(&mut ws, &cipher) => {
                    match frame {
                        Ok(RemoteRuntimeFrame::Json(value)) => {
                            if value.get("_keepalive").and_then(Value::as_bool).unwrap_or(false) {
                                continue;
                            }
                            if let Err(message) = validate_runtime_subscription_response(&value, &request_id_for_task) {
                                (callbacks.on_error)("invalid_runtime_response".to_string(), message);
                                break;
                            }
                            let should_close = is_subscription_end_response(&value);
                            (callbacks.on_response)(value);
                            if should_close {
                                break;
                            }
                        }
                        Ok(RemoteRuntimeFrame::Binary(bytes)) => {
                            (callbacks.on_binary)(bytes);
                        }
                        Err(message) => {
                            (callbacks.on_error)("remote_runtime_unavailable".to_string(), message);
                            break;
                        }
                    }
                }
            }
        }
        let _ = ws.close(None).await;
        (callbacks.on_close)();
    });

    Ok(RemoteRuntimeSubscription {
        request_id,
        binary_tx,
        cancel_tx: Some(cancel_tx),
        task: Some(task),
    })
}

impl RemoteRuntimeSubscription {
    pub fn send_binary(&self, bytes: Vec<u8>) -> bool {
        self.binary_tx.send(bytes).is_ok()
    }

    pub fn close(&mut self) {
        if let Some(cancel_tx) = self.cancel_tx.take() {
            let _ = cancel_tx.send(());
        }
        if let Some(task) = self.task.take() {
            task.abort();
        }
    }

    pub fn detach_finished(&mut self) {
        self.cancel_tx.take();
        self.task.take();
    }
}

impl Drop for RemoteRuntimeSubscription {
    fn drop(&mut self) {
        self.close();
    }
}

async fn connect_authenticated_socket(
    pairing: &RemoteRuntimePairing,
) -> Result<(RemoteRuntimeSocket, SalsaBox), String> {
    let server_public_key = decode_public_key(&pairing.public_key_b64)?;
    let secret_key = SecretKey::generate(&mut OsRng);
    let public_key = secret_key.public_key();
    let cipher = SalsaBox::new(&server_public_key, &secret_key);
    let (mut ws, _) = connect_async(&pairing.endpoint)
        .await
        .map_err(|_| "Could not connect to the remote Pebble runtime.".to_string())?;

    ws.send(Message::Text(
        json!({
            "type": "e2ee_hello",
            "publicKeyB64": STANDARD.encode(public_key.as_bytes()),
        })
        .to_string()
        .into(),
    ))
    .await
    .map_err(|_| "Could not connect to the remote Pebble runtime.".to_string())?;

    assert_ready_frame(next_text_frame(&mut ws).await?)?;
    send_runtime_json(
        &mut ws,
        &cipher,
        &json!({
            "type": "e2ee_auth",
            "deviceToken": pairing.device_token,
        }),
    )
    .await
    .map_err(|_| "Could not authenticate with the remote Pebble runtime.".to_string())?;

    assert_authenticated_frame(&decrypt_json(&cipher, &next_text_frame(&mut ws).await?)?)?;
    Ok((ws, cipher))
}

async fn send_runtime_json(
    ws: &mut RemoteRuntimeSocket,
    cipher: &SalsaBox,
    value: &Value,
) -> Result<(), String> {
    ws.send(Message::Text(encrypt_json(cipher, value)?.into()))
        .await
        .map_err(|_| "Could not send the remote Pebble runtime request.".to_string())
}

async fn next_text_frame<S>(ws: &mut S) -> Result<String, String>
where
    S: StreamExt<Item = Result<Message, tokio_tungstenite::tungstenite::Error>> + Unpin,
{
    while let Some(message) = ws.next().await {
        match message.map_err(|_| "Remote Pebble runtime closed the connection.".to_string())? {
            Message::Text(text) => return Ok(text.to_string()),
            Message::Binary(_) => {
                return Err("Remote Pebble runtime returned an unexpected binary frame.".to_string())
            }
            Message::Close(_) => {
                return Err("Remote Pebble runtime closed the connection.".to_string())
            }
            _ => continue,
        }
    }
    Err("Remote Pebble runtime closed the connection.".to_string())
}

enum RemoteRuntimeFrame {
    Json(Value),
    Binary(Vec<u8>),
}

async fn next_remote_runtime_frame(
    ws: &mut RemoteRuntimeSocket,
    cipher: &SalsaBox,
) -> Result<RemoteRuntimeFrame, String> {
    while let Some(message) = ws.next().await {
        match message.map_err(|_| "Remote Pebble runtime closed the connection.".to_string())? {
            Message::Text(text) => {
                return Ok(RemoteRuntimeFrame::Json(decrypt_json(cipher, &text)?))
            }
            Message::Binary(bytes) => {
                return Ok(RemoteRuntimeFrame::Binary(decrypt_bytes(
                    cipher,
                    bytes.as_ref(),
                )?))
            }
            Message::Close(_) => {
                return Err("Remote Pebble runtime closed the connection.".to_string())
            }
            _ => continue,
        }
    }
    Err("Remote Pebble runtime closed the connection.".to_string())
}

fn decode_public_key(value: &str) -> Result<PublicKey, String> {
    let bytes = STANDARD
        .decode(value)
        .map_err(|_| "Invalid remote pairing key.".to_string())?;
    let key: [u8; 32] = bytes
        .try_into()
        .map_err(|_| "Invalid remote pairing key.".to_string())?;
    Ok(PublicKey::from(key))
}

fn encrypt_json(cipher: &SalsaBox, value: &Value) -> Result<String, String> {
    let nonce = SalsaBox::generate_nonce(&mut OsRng);
    let plaintext = serde_json::to_vec(value)
        .map_err(|_| "Could not encode the remote Pebble runtime request.".to_string())?;
    let ciphertext = cipher
        .encrypt(&nonce, plaintext.as_slice())
        .map_err(|_| "Could not encrypt the remote Pebble runtime request.".to_string())?;
    let mut bundle = Vec::with_capacity(NONCE_LENGTH + ciphertext.len());
    bundle.extend_from_slice(&nonce);
    bundle.extend_from_slice(&ciphertext);
    Ok(STANDARD.encode(bundle))
}

fn encrypt_bytes(cipher: &SalsaBox, value: &[u8]) -> Vec<u8> {
    let nonce = SalsaBox::generate_nonce(&mut OsRng);
    let ciphertext = cipher
        .encrypt(&nonce, value)
        .expect("SalsaBox encryption should not fail for in-memory bytes");
    let mut bundle = Vec::with_capacity(NONCE_LENGTH + ciphertext.len());
    bundle.extend_from_slice(&nonce);
    bundle.extend_from_slice(&ciphertext);
    bundle
}

fn decrypt_json(cipher: &SalsaBox, frame: &str) -> Result<Value, String> {
    let bundle = STANDARD
        .decode(frame)
        .map_err(|_| "Remote Pebble runtime returned an undecryptable frame.".to_string())?;
    if bundle.len() < NONCE_LENGTH + BOX_OVERHEAD_LENGTH {
        return Err("Remote Pebble runtime returned an undecryptable frame.".to_string());
    }
    let (nonce, ciphertext) = bundle.split_at(NONCE_LENGTH);
    let plaintext = cipher
        .decrypt(nonce.into(), ciphertext)
        .map_err(|_| "Remote Pebble runtime returned an undecryptable frame.".to_string())?;
    serde_json::from_slice(&plaintext)
        .map_err(|_| "Remote Pebble runtime returned an invalid response frame.".to_string())
}

fn decrypt_bytes(cipher: &SalsaBox, bundle: &[u8]) -> Result<Vec<u8>, String> {
    if bundle.len() < NONCE_LENGTH + BOX_OVERHEAD_LENGTH {
        return Err("Remote Pebble runtime returned an undecryptable binary frame.".to_string());
    }
    let (nonce, ciphertext) = bundle.split_at(NONCE_LENGTH);
    cipher
        .decrypt(nonce.into(), ciphertext)
        .map_err(|_| "Remote Pebble runtime returned an undecryptable binary frame.".to_string())
}

fn assert_ready_frame(frame: String) -> Result<(), String> {
    let parsed: Value = serde_json::from_str(&frame).map_err(|_| {
        "Remote Pebble runtime returned an invalid E2EE handshake frame.".to_string()
    })?;
    if parsed.get("type").and_then(Value::as_str) == Some("e2ee_ready") {
        Ok(())
    } else {
        Err("Remote Pebble runtime returned an unexpected E2EE handshake frame.".to_string())
    }
}

fn assert_authenticated_frame(frame: &Value) -> Result<(), String> {
    if frame.get("type").and_then(Value::as_str) == Some("e2ee_authenticated") {
        return Ok(());
    }
    if frame
        .get("error")
        .and_then(|error| error.get("code"))
        .and_then(Value::as_str)
        == Some("unauthorized")
    {
        return Err("Remote Pebble runtime rejected the pairing token.".to_string());
    }
    Err("Remote Pebble runtime returned an invalid E2EE auth frame.".to_string())
}

fn validate_runtime_rpc_response(frame: &Value) -> Result<(), String> {
    if frame.get("id").and_then(Value::as_str).is_none() {
        return Err("Remote Pebble runtime returned an invalid response frame.".to_string());
    }
    match frame.get("ok").and_then(Value::as_bool) {
        Some(true) if frame.get("result").is_some() && frame.get("_meta").is_some() => Ok(()),
        Some(false) if frame.get("error").is_some() => Ok(()),
        _ => Err("Remote Pebble runtime returned an invalid response frame.".to_string()),
    }
}

fn validate_runtime_subscription_response(frame: &Value, request_id: &str) -> Result<(), String> {
    validate_runtime_rpc_response(frame)?;
    if frame.get("id").and_then(Value::as_str) != Some(request_id) {
        return Err(
            "Remote Pebble runtime returned a frame for an unknown subscription.".to_string(),
        );
    }
    Ok(())
}

fn is_subscription_end_response(frame: &Value) -> bool {
    frame
        .get("result")
        .and_then(|result| result.get("type"))
        .and_then(Value::as_str)
        == Some("end")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_runtime_rpc_success_and_failure_frames() {
        assert!(validate_runtime_rpc_response(&json!({
            "id": "req-1",
            "ok": true,
            "result": {},
            "_meta": { "runtimeId": "runtime-1" }
        }))
        .is_ok());
        assert!(validate_runtime_rpc_response(&json!({
            "id": "req-1",
            "ok": false,
            "error": { "code": "x", "message": "y" },
            "_meta": { "runtimeId": null }
        }))
        .is_ok());
        assert!(validate_runtime_rpc_response(&json!({ "ok": true })).is_err());
    }

    #[test]
    fn recognizes_subscription_end_responses() {
        assert!(is_subscription_end_response(&json!({
            "id": "sub-1",
            "ok": true,
            "result": { "type": "end" },
            "_meta": { "runtimeId": "runtime-1" }
        })));
        assert!(!is_subscription_end_response(&json!({
            "id": "sub-1",
            "ok": true,
            "result": { "type": "ready" },
            "_meta": { "runtimeId": "runtime-1" }
        })));
    }
}
