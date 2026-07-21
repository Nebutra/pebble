import PebbleComputerUseMacOSCore
import XCTest

final class AgentPeerAuthorizationTests: XCTestCase {
    func testTrustedTauriApplicationCanConnectDirectly() {
        XCTAssertTrue(isAuthorizedPebbleAgentPeer(
            peerBundleIdentifier: "nebutra.pebble",
            parentBundleIdentifier: nil,
            command: "/Applications/Pebble.app/Contents/MacOS/pebble-desktop-tauri"
        ))
        XCTAssertTrue(isAuthorizedPebbleAgentPeer(
            peerBundleIdentifier: "com.nebutra.pebble.dev.workspace",
            parentBundleIdentifier: nil,
            command: nil
        ))
    }

    func testUntrustedDirectPeerIsRejected() {
        XCTAssertFalse(isAuthorizedPebbleAgentPeer(
            peerBundleIdentifier: "com.example.untrusted",
            parentBundleIdentifier: nil,
            command: "/tmp/client"
        ))
        XCTAssertFalse(isTrustedPebbleBundleIdentifier("com.github.Electron"))
    }

    func testLegacySidecarRequiresTrustedPebbleParent() {
        let command = "/tmp/out/main/computer-sidecar.js"
        XCTAssertTrue(isAuthorizedPebbleAgentPeer(
            peerBundleIdentifier: nil,
            parentBundleIdentifier: "nebutra.pebble.dev.workspace",
            command: command
        ))
        XCTAssertFalse(isAuthorizedPebbleAgentPeer(
            peerBundleIdentifier: "com.github.Electron",
            parentBundleIdentifier: "com.github.Electron",
            command: command
        ))
    }
}
