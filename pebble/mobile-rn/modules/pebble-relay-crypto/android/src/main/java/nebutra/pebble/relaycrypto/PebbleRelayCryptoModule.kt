package nebutra.pebble.relaycrypto

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.math.BigInteger
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.PrivateKey
import java.security.PublicKey
import java.security.SecureRandom
import java.security.interfaces.XECPublicKey
import java.security.spec.NamedParameterSpec
import java.security.spec.XECPublicKeySpec
import java.util.Base64
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import javax.crypto.Cipher
import javax.crypto.KeyAgreement
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec
import org.json.JSONArray
import org.json.JSONObject

private const val RELAY_CRYPTO_ALGORITHM = "X25519-HKDF-SHA256-AES-256-GCM"
private const val RELAY_ASSOCIATED_DATA = "pebble.mobile-relay.v1"

class PebbleRelayCryptoModule : Module() {
  private val handshakes = ConcurrentHashMap<String, PrivateKey>()
  private val sessions = ConcurrentHashMap<String, ByteArray>()
  private val secureRandom = SecureRandom()

  override fun definition() = ModuleDefinition {
    Name("PebbleRelayCrypto")

    AsyncFunction("createHandshake") { input: Map<String, Any?> ->
      val keyPairGenerator = KeyPairGenerator.getInstance("X25519")
      keyPairGenerator.initialize(NamedParameterSpec("X25519"))
      val keyPair = keyPairGenerator.generateKeyPair()
      val handshakeId = UUID.randomUUID().toString()
      handshakes[handshakeId] = keyPair.private

      mapOf(
        "handshakeId" to handshakeId,
        "payload" to mapOf(
          "device" to (input["device"] ?: emptyMap<String, Any?>()),
          "clientPublicKey" to encodeRelayBase64(x25519RawPublicKey(keyPair.public)),
          "pairingSecretRef" to (input["pairingSecretRef"] as? String ?: ""),
          "subscriptions" to (input["subscriptions"] ?: emptyList<Any>())
        )
      )
    }

    AsyncFunction("completeHandshake") { input: Map<String, Any?> ->
      val handshakeId = input["handshakeId"] as? String
        ?: throw IllegalArgumentException("handshakeId is required")
      val ready = input["ready"] as? Map<*, *>
        ?: throw IllegalArgumentException("ready is required")
      if (ready["algorithm"] as? String != RELAY_CRYPTO_ALGORITHM) {
        throw IllegalArgumentException("unsupported relay crypto algorithm")
      }
      val privateKey = handshakes.remove(handshakeId)
        ?: throw IllegalArgumentException("unknown relay crypto handshake")
      val serverPublicKey = ready["serverPublicKey"] as? String
        ?: throw IllegalArgumentException("ready.serverPublicKey is required")
      val expectedKeyId = ready["keyId"] as? String
        ?: throw IllegalArgumentException("ready.keyId is required")
      val keyAgreement = KeyAgreement.getInstance("X25519")
      keyAgreement.init(privateKey)
      keyAgreement.doPhase(x25519PublicKeyFromRaw(decodeRelayBase64(serverPublicKey)), true)
      val keyBytes = deriveRelayKey(
        sharedSecret = keyAgreement.generateSecret(),
        relayId = input["relayId"] as? String ?: "",
        pairingSecretRef = input["pairingSecretRef"] as? String ?: ""
      )
      val keyId = relayKeyId(keyBytes)
      if (keyId != expectedKeyId) {
        throw IllegalArgumentException("relay crypto key id mismatch")
      }
      val sessionId = UUID.randomUUID().toString()
      sessions[sessionId] = keyBytes

      mapOf(
        "sessionId" to sessionId,
        "keyId" to keyId
      )
    }

    AsyncFunction("encryptMessage") { input: Map<String, Any?> ->
      val sessionId = input["sessionId"] as? String
        ?: throw IllegalArgumentException("sessionId is required")
      val keyBytes = sessions[sessionId]
        ?: throw IllegalArgumentException("unknown relay crypto session")
      val message = input["message"] as? Map<*, *>
        ?: throw IllegalArgumentException("message is required")
      val nonce = ByteArray(12)
      secureRandom.nextBytes(nonce)
      val cipher = Cipher.getInstance("AES/GCM/NoPadding")
      cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(keyBytes, "AES"), GCMParameterSpec(128, nonce))
      cipher.updateAAD(RELAY_ASSOCIATED_DATA.toByteArray(Charsets.UTF_8))
      val ciphertext = cipher.doFinal(JSONObject(message).toString().toByteArray(Charsets.UTF_8))

      mapOf(
        "keyId" to relayKeyId(keyBytes),
        "nonce" to encodeRelayBase64(nonce),
        "ciphertext" to encodeRelayBase64(ciphertext),
        "associatedData" to RELAY_ASSOCIATED_DATA
      )
    }

    AsyncFunction("decryptMessage") { input: Map<String, Any?> ->
      val sessionId = input["sessionId"] as? String
        ?: throw IllegalArgumentException("sessionId is required")
      val keyBytes = sessions[sessionId]
        ?: throw IllegalArgumentException("unknown relay crypto session")
      val envelope = input["envelope"] as? Map<*, *>
        ?: throw IllegalArgumentException("envelope is required")
      if (envelope["keyId"] as? String != relayKeyId(keyBytes)) {
        throw IllegalArgumentException("relay crypto key id mismatch")
      }
      val associatedData = envelope["associatedData"] as? String
      if (associatedData != null && associatedData != RELAY_ASSOCIATED_DATA) {
        throw IllegalArgumentException("relay crypto associated data mismatch")
      }
      val nonce = decodeRelayBase64(
        envelope["nonce"] as? String ?: throw IllegalArgumentException("envelope.nonce is required")
      )
      val ciphertext = decodeRelayBase64(
        envelope["ciphertext"] as? String ?: throw IllegalArgumentException("envelope.ciphertext is required")
      )
      val cipher = Cipher.getInstance("AES/GCM/NoPadding")
      cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(keyBytes, "AES"), GCMParameterSpec(128, nonce))
      cipher.updateAAD(RELAY_ASSOCIATED_DATA.toByteArray(Charsets.UTF_8))
      val plaintext = String(cipher.doFinal(ciphertext), Charsets.UTF_8)

      JSONObject(plaintext).toMap()
    }

    AsyncFunction("selfTest") {
      selfTestRelayCrypto()
    }
  }

  private fun selfTestRelayCrypto(): Map<String, Any> {
    val relayId = "pebble-self-test-relay"
    val pairingSecretRef = "pebble-self-test-secret"
    val keyPairGenerator = KeyPairGenerator.getInstance("X25519")
    keyPairGenerator.initialize(NamedParameterSpec("X25519"))
    val clientKeyPair = keyPairGenerator.generateKeyPair()
    val serverKeyPair = keyPairGenerator.generateKeyPair()
    val clientKeyBytes = deriveRelayKey(
      sharedSecret = sharedSecret(clientKeyPair.private, serverKeyPair.public),
      relayId = relayId,
      pairingSecretRef = pairingSecretRef
    )
    val serverKeyBytes = deriveRelayKey(
      sharedSecret = sharedSecret(serverKeyPair.private, clientKeyPair.public),
      relayId = relayId,
      pairingSecretRef = pairingSecretRef
    )
    val keyId = relayKeyId(clientKeyBytes)

    if (keyId != relayKeyId(serverKeyBytes)) {
      throw IllegalArgumentException("relay crypto self-test key id mismatch")
    }

    val message = mapOf(
      "version" to RELAY_ASSOCIATED_DATA,
      "id" to "pebble-self-test-server",
      "type" to "server.hello",
      "payload" to mapOf(
        "relayId" to relayId,
        "acceptedSubscriptions" to emptyList<String>()
      )
    )
    val nonce = ByteArray(12)
    secureRandom.nextBytes(nonce)
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(serverKeyBytes, "AES"), GCMParameterSpec(128, nonce))
    cipher.updateAAD(RELAY_ASSOCIATED_DATA.toByteArray(Charsets.UTF_8))
    val ciphertext = cipher.doFinal(JSONObject(message).toString().toByteArray(Charsets.UTF_8))
    val decryptCipher = Cipher.getInstance("AES/GCM/NoPadding")
    decryptCipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(clientKeyBytes, "AES"), GCMParameterSpec(128, nonce))
    decryptCipher.updateAAD(RELAY_ASSOCIATED_DATA.toByteArray(Charsets.UTF_8))
    val plaintext = String(decryptCipher.doFinal(ciphertext), Charsets.UTF_8)
    val decoded = JSONObject(plaintext)

    if (decoded.getString("id") != "pebble-self-test-server") {
      throw IllegalArgumentException("relay crypto self-test decrypt mismatch")
    }

    return mapOf(
      "ok" to true,
      "provider" to "native",
      "algorithm" to RELAY_CRYPTO_ALGORITHM,
      "keyId" to keyId,
      "encryptedBytes" to ciphertext.size
    )
  }

  private fun deriveRelayKey(
    sharedSecret: ByteArray,
    relayId: String,
    pairingSecretRef: String
  ): ByteArray {
    val saltInput = "pebble-mobile-relay:$relayId:$pairingSecretRef".toByteArray(Charsets.UTF_8)
    val salt = java.security.MessageDigest.getInstance("SHA-256").digest(saltInput)
    val prk = hmacSha256(salt, sharedSecret)
    val info = RELAY_CRYPTO_ALGORITHM.toByteArray(Charsets.UTF_8)

    return hmacSha256(prk, info + byteArrayOf(1)).copyOfRange(0, 32)
  }

  private fun hmacSha256(key: ByteArray, input: ByteArray): ByteArray {
    val mac = Mac.getInstance("HmacSHA256")
    mac.init(SecretKeySpec(key, "HmacSHA256"))

    return mac.doFinal(input)
  }

  private fun relayKeyId(keyBytes: ByteArray): String {
    val digest = java.security.MessageDigest.getInstance("SHA-256").digest(keyBytes)

    return encodeRelayBase64(digest.copyOfRange(0, 16))
  }

  private fun sharedSecret(privateKey: PrivateKey, publicKey: PublicKey): ByteArray {
    val keyAgreement = KeyAgreement.getInstance("X25519")
    keyAgreement.init(privateKey)
    keyAgreement.doPhase(publicKey, true)

    return keyAgreement.generateSecret()
  }
}

private fun x25519RawPublicKey(publicKey: PublicKey): ByteArray {
  val u = (publicKey as XECPublicKey).u
  val bigEndian = u.toByteArray()
  val raw = ByteArray(32)

  for (index in bigEndian.indices) {
    val target = index
    val source = bigEndian.size - 1 - index
    if (target < raw.size) {
      raw[target] = bigEndian[source]
    }
  }

  return raw
}

private fun x25519PublicKeyFromRaw(raw: ByteArray): PublicKey {
  val u = BigInteger(1, raw.reversedArray())
  val spec = XECPublicKeySpec(NamedParameterSpec("X25519"), u)

  return KeyFactory.getInstance("X25519").generatePublic(spec)
}

private fun encodeRelayBase64(value: ByteArray): String =
  Base64.getUrlEncoder().withoutPadding().encodeToString(value)

private fun decodeRelayBase64(value: String): ByteArray =
  Base64.getUrlDecoder().decode(value)

private fun JSONObject.toMap(): Map<String, Any?> {
  val output = mutableMapOf<String, Any?>()
  val keys = keys()

  while (keys.hasNext()) {
    val key = keys.next()
    output[key] = unwrapJsonValue(get(key))
  }

  return output
}

private fun JSONArray.toListValue(): List<Any?> {
  val output = mutableListOf<Any?>()

  for (index in 0 until length()) {
    output.add(unwrapJsonValue(get(index)))
  }

  return output
}

private fun unwrapJsonValue(value: Any?): Any? =
  when (value) {
    JSONObject.NULL -> null
    is JSONObject -> value.toMap()
    is JSONArray -> value.toListValue()
    else -> value
  }
