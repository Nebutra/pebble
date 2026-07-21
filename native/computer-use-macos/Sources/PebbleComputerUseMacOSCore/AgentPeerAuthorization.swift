import Foundation

public func isTrustedPebbleBundleIdentifier(_ bundleIdentifier: String?) -> Bool {
    guard let bundleIdentifier else { return false }
    return bundleIdentifier == "nebutra.pebble" ||
        bundleIdentifier.hasPrefix("nebutra.pebble.dev.") ||
        bundleIdentifier == "com.nebutra.pebble" ||
        bundleIdentifier.hasPrefix("com.nebutra.pebble.dev.")
}

public func isAuthorizedPebbleAgentPeer(
    peerBundleIdentifier: String?,
    parentBundleIdentifier: String?,
    command: String?
) -> Bool {
    if isTrustedPebbleBundleIdentifier(peerBundleIdentifier) {
        return true
    }
    guard let command,
          command.contains("/out/main/computer-sidecar.js") ||
              command.contains("/Contents/Resources/app.asar.unpacked/out/main/computer-sidecar.js")
    else {
        return false
    }
    // Legacy sidecars are temporarily accepted only through a trusted Pebble
    // parent; the generic Electron bundle identity is never sufficient.
    return isTrustedPebbleBundleIdentifier(parentBundleIdentifier)
}
