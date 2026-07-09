use std::time::Duration;

use base64::{engine::general_purpose::STANDARD, Engine as _};
use crypto_box::{
    aead::{Aead, AeadCore, OsRng},
    PublicKey, SalsaBox, SecretKey,
};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::time::timeout;
use tokio_tungstenite::{connect_async, tungstenite::Message};
use uuid::Uuid;

const NONCE_LENGTH: usize = 24;
const BOX_OVERHEAD_LENGTH: usize = 16;

pub struct RemoteRuntimePairing {
    pub endpoint: String,
    pub device_token: String,
    pub public_key_b64: String,
}

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
    ws.send(Message::Text(
        encrypt_json(
            &cipher,
            &json!({
                "type": "e2ee_auth",
                "deviceToken": pairing.device_token,
            }),
        )?
        .into(),
    ))
    .await
    .map_err(|_| "Could not authenticate with the remote Pebble runtime.".to_string())?;

    assert_authenticated_frame(&decrypt_json(&cipher, &next_text_frame(&mut ws).await?)?)?;
    ws.send(Message::Text(
        encrypt_json(
            &cipher,
            &json!({
                "id": Uuid::new_v4().to_string(),
                "deviceToken": pairing.device_token,
                "method": method,
                "params": params.unwrap_or(Value::Null),
            }),
        )?
        .into(),
    ))
    .await
    .map_err(|_| "Could not send the remote Pebble runtime request.".to_string())?;

    loop {
        let frame = decrypt_json(&cipher, &next_text_frame(&mut ws).await?)?;
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
}
