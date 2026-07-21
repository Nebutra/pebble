use std::{env, fs, process};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use minisign_verify::{PublicKey, Signature};

fn decode_base64_text(value: &str, label: &str) -> Result<String, String> {
    let bytes = STANDARD
        .decode(value.trim())
        .map_err(|error| format!("invalid base64 {label}: {error}"))?;
    String::from_utf8(bytes).map_err(|error| format!("invalid UTF-8 {label}: {error}"))
}

fn verify(public_key: &str, payload: &[u8], encoded_signature: &str) -> Result<(), String> {
    // Why: mirror tauri-plugin-updater's decoding and legacy-mode policy so CI
    // proves the exact signature contract the installed client will enforce.
    let public_key = PublicKey::decode(&decode_base64_text(public_key, "public key")?)
        .map_err(|error| format!("invalid updater public key: {error}"))?;
    let signature = Signature::decode(&decode_base64_text(encoded_signature, "signature")?)
        .map_err(|error| format!("invalid updater signature: {error}"))?;
    public_key
        .verify(payload, &signature, true)
        .map_err(|error| format!("updater signature verification failed: {error}"))
}

fn run() -> Result<(), String> {
    let mut arguments = env::args().skip(1);
    let public_key = arguments.next().ok_or_else(|| {
        "usage: pebble-updater-signature-verifier <public-key> <payload> <signature>".to_string()
    })?;
    let payload_path = arguments
        .next()
        .ok_or_else(|| "missing payload path".to_string())?;
    let signature_path = arguments
        .next()
        .ok_or_else(|| "missing signature path".to_string())?;
    if arguments.next().is_some() {
        return Err("unexpected extra arguments".to_string());
    }

    let payload = fs::read(&payload_path)
        .map_err(|error| format!("could not read updater payload {payload_path}: {error}"))?;
    let signature = fs::read_to_string(&signature_path)
        .map_err(|error| format!("could not read updater signature {signature_path}: {error}"))?;
    verify(&public_key, &payload, &signature)
}

fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use base64::{engine::general_purpose::STANDARD, Engine as _};

    use super::verify;

    const PUBLIC_KEY: &str = "untrusted comment: minisign public key BF5CA91842B4E81F\nRWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3";
    const SIGNATURE: &str = "untrusted comment: signature from minisign secret key\nRUQf6LRCGA9i559r3g7V1qNyJDApGip8MfqcadIgT9CuhV3EMhHoN1mGTkUidF/z7SrlQgXdy8ofjb7bNJJylDOocrCo8KLzZwo=\ntrusted comment: timestamp:1633700835\tfile:test\tprehashed\nwLMDjy9FLAuxZ3q4NlEvkgtyhrr0gtTu6KC4KBJdITbbOeAi1zBIYo0v4iTgt8jJpIidRJnp94ABQkJAgAooBQ==";

    fn encoded(value: &str) -> String {
        STANDARD.encode(value)
    }

    #[test]
    fn accepts_the_same_encoded_signature_contract_as_the_updater() {
        verify(&encoded(PUBLIC_KEY), b"test", &encoded(SIGNATURE))
            .expect("known signature should verify");
    }

    #[test]
    fn rejects_tampered_payloads() {
        let error = verify(&encoded(PUBLIC_KEY), b"tampered", &encoded(SIGNATURE))
            .expect_err("tampering must fail");
        assert!(error.contains("verification failed"));
    }
}
