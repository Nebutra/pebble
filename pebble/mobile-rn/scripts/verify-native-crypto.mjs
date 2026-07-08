import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const moduleRoot = join(root, 'modules', 'pebble-relay-crypto')

const checks = []

function readText(relativePath) {
  return readFileSync(join(root, relativePath), 'utf8')
}

function readJSON(relativePath) {
  return JSON.parse(readText(relativePath))
}

function expectEqual(label, actual, expected) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${expected}, got ${String(actual)}`)
  }
  checks.push(label)
}

function expectIncludes(label, text, needle) {
  if (!text.includes(needle)) {
    throw new Error(`${label}: missing ${needle}`)
  }
  checks.push(label)
}

const app = readJSON('app.json').expo
expectEqual('ios bundle identifier', app.ios.bundleIdentifier, 'nebutra.pebble.mobile')
expectEqual('android package', app.android.package, 'nebutra.pebble.mobile')

const modulePackage = JSON.parse(
  readFileSync(join(moduleRoot, 'package.json'), 'utf8'),
)
expectEqual('native package name', modulePackage.name, '@pebble/relay-crypto-native')

const expoConfig = JSON.parse(
  readFileSync(join(moduleRoot, 'expo-module.config.json'), 'utf8'),
)
expectEqual('ios module export', expoConfig.ios.modules[0], 'PebbleRelayCryptoModule')
expectEqual(
  'android module export',
  expoConfig.android.modules[0],
  'nebutra.pebble.relaycrypto.PebbleRelayCryptoModule',
)

const gradle = readFileSync(join(moduleRoot, 'android', 'build.gradle'), 'utf8')
expectIncludes('android namespace', gradle, "namespace 'nebutra.pebble.relaycrypto'")
expectIncludes('android group', gradle, "group = 'nebutra.pebble.relaycrypto'")

const kotlin = readFileSync(
  join(
    moduleRoot,
    'android',
    'src',
    'main',
    'java',
    'nebutra',
    'pebble',
    'relaycrypto',
    'PebbleRelayCryptoModule.kt',
  ),
  'utf8',
)
expectIncludes('android package declaration', kotlin, 'package nebutra.pebble.relaycrypto')
expectIncludes('android module name', kotlin, 'Name("PebbleRelayCrypto")')
expectIncludes('android relay algorithm', kotlin, 'X25519-HKDF-SHA256-AES-256-GCM')
expectIncludes('android associated data', kotlin, 'pebble.mobile-relay.v1')
expectIncludes('android x25519 keypair', kotlin, 'KeyPairGenerator.getInstance("X25519")')
expectIncludes('android x25519 agreement', kotlin, 'KeyAgreement.getInstance("X25519")')
expectIncludes('android aes gcm', kotlin, 'Cipher.getInstance("AES/GCM/NoPadding")')
expectIncludes('android hkdf hmac', kotlin, 'Mac.getInstance("HmacSHA256")')
expectIncludes('android secure random', kotlin, 'SecureRandom()')
expectIncludes('android url-safe base64 encode', kotlin, 'Base64.getUrlEncoder().withoutPadding()')
expectIncludes('android url-safe base64 decode', kotlin, 'Base64.getUrlDecoder()')

const swift = readFileSync(join(moduleRoot, 'ios', 'PebbleRelayCryptoModule.swift'), 'utf8')
expectIncludes('ios module name', swift, 'Name("PebbleRelayCrypto")')
expectIncludes('ios relay algorithm', swift, 'X25519-HKDF-SHA256-AES-256-GCM')
expectIncludes('ios associated data', swift, 'pebble.mobile-relay.v1')
expectIncludes('ios x25519 key agreement', swift, 'Curve25519.KeyAgreement.PrivateKey')
expectIncludes('ios hkdf', swift, 'hkdfDerivedSymmetricKey')
expectIncludes('ios aes gcm', swift, 'AES.GCM')
expectIncludes('ios secure random', swift, 'SecRandomCopyBytes')

const protocol = readText('src/relay/relay-protocol.ts')
expectIncludes(
  'typescript mobile relay protocol',
  protocol,
  "MOBILE_RELAY_PROTOCOL_VERSION = 'pebble.mobile-relay.v1'",
)

console.log(`native relay crypto static contract ok (${checks.length} checks)`)
