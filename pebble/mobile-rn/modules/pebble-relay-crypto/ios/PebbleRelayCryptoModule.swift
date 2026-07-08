import CryptoKit
import ExpoModulesCore
import Foundation
import Security

private let relayCryptoAlgorithm = "X25519-HKDF-SHA256-AES-256-GCM"
private let relayAssociatedData = "pebble.mobile-relay.v1"

public class PebbleRelayCryptoModule: Module {
  private var handshakes: [String: Curve25519.KeyAgreement.PrivateKey] = [:]
  private var sessions: [String: SymmetricKey] = [:]
  private let lock = NSLock()

  public func definition() -> ModuleDefinition {
    Name("PebbleRelayCrypto")

    AsyncFunction("createHandshake") { (input: [String: Any]) -> [String: Any] in
      let privateKey = Curve25519.KeyAgreement.PrivateKey()
      let handshakeId = UUID().uuidString
      let pairingSecretRef = input["pairingSecretRef"] as? String ?? ""
      let subscriptions = input["subscriptions"] as? [Any] ?? []
      let device = input["device"] as? [String: Any] ?? [:]

      lock.lock()
      handshakes[handshakeId] = privateKey
      lock.unlock()

      return [
        "handshakeId": handshakeId,
        "payload": [
          "device": device,
          "clientPublicKey": encodeRelayBase64(privateKey.publicKey.rawRepresentation),
          "pairingSecretRef": pairingSecretRef,
          "subscriptions": subscriptions
        ]
      ]
    }

    AsyncFunction("completeHandshake") { (input: [String: Any]) -> [String: Any] in
      guard let handshakeId = input["handshakeId"] as? String else {
        throw PebbleRelayCryptoError.invalidInput("handshakeId is required")
      }
      guard let ready = input["ready"] as? [String: Any] else {
        throw PebbleRelayCryptoError.invalidInput("ready is required")
      }
      guard ready["algorithm"] as? String == relayCryptoAlgorithm else {
        throw PebbleRelayCryptoError.invalidInput("unsupported relay crypto algorithm")
      }
      guard let expectedKeyId = ready["keyId"] as? String else {
        throw PebbleRelayCryptoError.invalidInput("ready.keyId is required")
      }
      guard let serverPublicKey = ready["serverPublicKey"] as? String else {
        throw PebbleRelayCryptoError.invalidInput("ready.serverPublicKey is required")
      }

      lock.lock()
      let privateKey = handshakes.removeValue(forKey: handshakeId)
      lock.unlock()

      guard let privateKey else {
        throw PebbleRelayCryptoError.invalidInput("unknown relay crypto handshake")
      }

      let publicKey = try Curve25519.KeyAgreement.PublicKey(
        rawRepresentation: try decodeRelayBase64(serverPublicKey)
      )
      let sharedSecret = try privateKey.sharedSecretFromKeyAgreement(with: publicKey)
      let key = deriveRelayKey(
        sharedSecret: sharedSecret,
        relayId: input["relayId"] as? String ?? "",
        pairingSecretRef: input["pairingSecretRef"] as? String ?? ""
      )
      let keyData = key.withUnsafeBytes { Data($0) }
      let keyId = relayKeyId(keyData)

      guard keyId == expectedKeyId else {
        throw PebbleRelayCryptoError.invalidInput("relay crypto key id mismatch")
      }

      let sessionId = UUID().uuidString
      lock.lock()
      sessions[sessionId] = key
      lock.unlock()

      return [
        "sessionId": sessionId,
        "keyId": keyId
      ]
    }

    AsyncFunction("encryptMessage") { (input: [String: Any]) -> [String: Any] in
      let key = try sessionKey(input["sessionId"] as? String)
      guard let message = input["message"] as? [String: Any] else {
        throw PebbleRelayCryptoError.invalidInput("message is required")
      }
      let plaintext = try JSONSerialization.data(withJSONObject: message, options: [])
      let nonceData = try randomBytes(count: 12)
      let nonce = try AES.GCM.Nonce(data: nonceData)
      let sealed = try AES.GCM.seal(
        plaintext,
        using: key,
        nonce: nonce,
        authenticating: Data(relayAssociatedData.utf8)
      )
      var ciphertext = Data(sealed.ciphertext)
      ciphertext.append(sealed.tag)

      return [
        "keyId": relayKeyId(key.withUnsafeBytes { Data($0) }),
        "nonce": encodeRelayBase64(nonceData),
        "ciphertext": encodeRelayBase64(ciphertext),
        "associatedData": relayAssociatedData
      ]
    }

    AsyncFunction("decryptMessage") { (input: [String: Any]) -> [String: Any] in
      let key = try sessionKey(input["sessionId"] as? String)
      guard let envelope = input["envelope"] as? [String: Any] else {
        throw PebbleRelayCryptoError.invalidInput("envelope is required")
      }
      guard envelope["keyId"] as? String == relayKeyId(key.withUnsafeBytes { Data($0) }) else {
        throw PebbleRelayCryptoError.invalidInput("relay crypto key id mismatch")
      }
      if let associatedData = envelope["associatedData"] as? String,
         associatedData != relayAssociatedData {
        throw PebbleRelayCryptoError.invalidInput("relay crypto associated data mismatch")
      }
      guard let nonceValue = envelope["nonce"] as? String else {
        throw PebbleRelayCryptoError.invalidInput("envelope.nonce is required")
      }
      guard let ciphertextValue = envelope["ciphertext"] as? String else {
        throw PebbleRelayCryptoError.invalidInput("envelope.ciphertext is required")
      }
      let combined = try decodeRelayBase64(ciphertextValue)
      guard combined.count >= 16 else {
        throw PebbleRelayCryptoError.invalidInput("encrypted relay payload is too short")
      }
      let ciphertext = combined.prefix(combined.count - 16)
      let tag = combined.suffix(16)
      let sealed = try AES.GCM.SealedBox(
        nonce: try AES.GCM.Nonce(data: try decodeRelayBase64(nonceValue)),
        ciphertext: ciphertext,
        tag: tag
      )
      let plaintext = try AES.GCM.open(
        sealed,
        using: key,
        authenticating: Data(relayAssociatedData.utf8)
      )
      guard let message = try JSONSerialization.jsonObject(with: plaintext, options: []) as? [String: Any] else {
        throw PebbleRelayCryptoError.invalidInput("encrypted relay payload was not an object")
      }

      return message
    }

    AsyncFunction("selfTest") { () -> [String: Any] in
      let relayId = "pebble-self-test-relay"
      let pairingSecretRef = "pebble-self-test-secret"
      let clientPrivateKey = Curve25519.KeyAgreement.PrivateKey()
      let serverPrivateKey = Curve25519.KeyAgreement.PrivateKey()
      let clientSharedSecret = try clientPrivateKey.sharedSecretFromKeyAgreement(
        with: serverPrivateKey.publicKey
      )
      let serverSharedSecret = try serverPrivateKey.sharedSecretFromKeyAgreement(
        with: clientPrivateKey.publicKey
      )
      let clientKey = deriveRelayKey(
        sharedSecret: clientSharedSecret,
        relayId: relayId,
        pairingSecretRef: pairingSecretRef
      )
      let serverKey = deriveRelayKey(
        sharedSecret: serverSharedSecret,
        relayId: relayId,
        pairingSecretRef: pairingSecretRef
      )
      let clientKeyId = relayKeyId(clientKey.withUnsafeBytes { Data($0) })
      let serverKeyId = relayKeyId(serverKey.withUnsafeBytes { Data($0) })

      guard clientKeyId == serverKeyId else {
        throw PebbleRelayCryptoError.invalidInput("relay crypto self-test key id mismatch")
      }

      let message: [String: Any] = [
        "version": relayAssociatedData,
        "id": "pebble-self-test-server",
        "type": "server.hello",
        "payload": [
          "relayId": relayId,
          "acceptedSubscriptions": [String]()
        ]
      ]
      let plaintext = try JSONSerialization.data(withJSONObject: message, options: [])
      let nonceData = try randomBytes(count: 12)
      let sealed = try AES.GCM.seal(
        plaintext,
        using: serverKey,
        nonce: try AES.GCM.Nonce(data: nonceData),
        authenticating: Data(relayAssociatedData.utf8)
      )
      var ciphertext = Data(sealed.ciphertext)
      ciphertext.append(sealed.tag)
      let opened = try AES.GCM.open(
        try AES.GCM.SealedBox(
          nonce: try AES.GCM.Nonce(data: nonceData),
          ciphertext: ciphertext.prefix(ciphertext.count - 16),
          tag: ciphertext.suffix(16)
        ),
        using: clientKey,
        authenticating: Data(relayAssociatedData.utf8)
      )
      guard let decoded = try JSONSerialization.jsonObject(with: opened, options: []) as? [String: Any],
            decoded["id"] as? String == "pebble-self-test-server" else {
        throw PebbleRelayCryptoError.invalidInput("relay crypto self-test decrypt mismatch")
      }

      return [
        "ok": true,
        "provider": "native",
        "algorithm": relayCryptoAlgorithm,
        "keyId": clientKeyId,
        "encryptedBytes": ciphertext.count
      ]
    }
  }

  private func sessionKey(_ sessionId: String?) throws -> SymmetricKey {
    guard let sessionId else {
      throw PebbleRelayCryptoError.invalidInput("sessionId is required")
    }
    lock.lock()
    let key = sessions[sessionId]
    lock.unlock()
    guard let key else {
      throw PebbleRelayCryptoError.invalidInput("unknown relay crypto session")
    }

    return key
  }
}

private enum PebbleRelayCryptoError: Error, LocalizedError {
  case invalidInput(String)

  var errorDescription: String? {
    switch self {
    case .invalidInput(let message):
      return message
    }
  }
}

private func deriveRelayKey(
  sharedSecret: SharedSecret,
  relayId: String,
  pairingSecretRef: String
) -> SymmetricKey {
  let salt = SHA256.hash(data: Data("pebble-mobile-relay:\(relayId):\(pairingSecretRef)".utf8))

  return sharedSecret.hkdfDerivedSymmetricKey(
    using: SHA256.self,
    salt: Data(salt),
    sharedInfo: Data(relayCryptoAlgorithm.utf8),
    outputByteCount: 32
  )
}

private func relayKeyId(_ keyData: Data) -> String {
  let digest = SHA256.hash(data: keyData)

  return encodeRelayBase64(Data(digest.prefix(16)))
}

private func randomBytes(count: Int) throws -> Data {
  var bytes = [UInt8](repeating: 0, count: count)
  let status = SecRandomCopyBytes(kSecRandomDefault, count, &bytes)
  guard status == errSecSuccess else {
    throw PebbleRelayCryptoError.invalidInput("secure random bytes unavailable")
  }

  return Data(bytes)
}

private func encodeRelayBase64(_ data: Data) -> String {
  data.base64EncodedString()
    .replacingOccurrences(of: "+", with: "-")
    .replacingOccurrences(of: "/", with: "_")
    .replacingOccurrences(of: "=", with: "")
}

private func decodeRelayBase64(_ value: String) throws -> Data {
  var normalized = value
    .replacingOccurrences(of: "-", with: "+")
    .replacingOccurrences(of: "_", with: "/")
  let padding = (4 - normalized.count % 4) % 4
  normalized.append(String(repeating: "=", count: padding))

  guard let data = Data(base64Encoded: normalized) else {
    throw PebbleRelayCryptoError.invalidInput("relay base64 value is invalid")
  }

  return data
}
