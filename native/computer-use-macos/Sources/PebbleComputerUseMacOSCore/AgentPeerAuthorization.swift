import Foundation

/// The `--agent` invocation Pebble makes. `--peer-pid` is required: the helper
/// binds to exactly one supervising process rather than trusting a bundle
/// identifier, which any process running under a Pebble parent could present.
public struct AgentLaunchArguments: Equatable, Sendable {
    public let socketPath: String
    public let tokenFilePath: String
    public let expectedPeerProcessId: Int32

    public init(socketPath: String, tokenFilePath: String, expectedPeerProcessId: Int32) {
        self.socketPath = socketPath
        self.tokenFilePath = tokenFilePath
        self.expectedPeerProcessId = expectedPeerProcessId
    }

    /// Parses the exact argument shape, in order. A partial or reordered
    /// invocation is rejected rather than defaulted, so a caller that omits
    /// `--peer-pid` cannot silently fall back to an unbound helper.
    public static func parse(_ arguments: [String]) -> AgentLaunchArguments? {
        guard arguments.count == 6,
              arguments[0] == "--agent",
              !arguments[1].isEmpty,
              arguments[2] == "--token-file",
              !arguments[3].isEmpty,
              arguments[4] == "--peer-pid",
              let expectedPeerProcessId = Int32(arguments[5]),
              expectedPeerProcessId > 0
        else {
            return nil
        }
        return AgentLaunchArguments(
            socketPath: arguments[1],
            tokenFilePath: arguments[3],
            expectedPeerProcessId: expectedPeerProcessId
        )
    }
}

/// Exact identity, not a family: only the process Pebble named at launch may
/// drive the helper.
public func isAuthorizedAgentPeer(peerProcessId: Int32?, expectedProcessId: Int32) -> Bool {
    expectedProcessId > 0 && peerProcessId == expectedProcessId
}
