public struct AgentSessionConnectionID: Hashable, Sendable {
    public let rawValue: UInt64

    public init(rawValue: UInt64) {
        self.rawValue = rawValue
    }
}

public enum AgentSessionRegistration: Sendable, Equatable {
    /// Not from the supervising process, or arriving after the session closed.
    case rejected
    /// First authorized connection; the helper now has an owner.
    case claimed
    /// A further authorized connection while the session is already owned.
    case retained
}

/// Tracks which authorized connections are live so the helper can exit once its
/// owner is gone. Without this, killing Pebble leaves the helper running with
/// accessibility and screen-recording grants and nothing driving it.
public struct AgentSessionOwnership: Sendable {
    private var authorizedConnections: Set<AgentSessionConnectionID> = []
    private var wasClaimed = false
    private var sessionClosed = false

    public init() {}

    public mutating func registerConnection(
        _ connection: AgentSessionConnectionID,
        authorized: Bool
    ) -> AgentSessionRegistration {
        // Why: once the owner has hung up the helper is on its way out, so a
        // late reconnect must not resurrect it.
        guard authorized, !sessionClosed else { return .rejected }
        guard authorizedConnections.insert(connection).inserted else { return .rejected }
        guard !wasClaimed else { return .retained }
        wasClaimed = true
        return .claimed
    }

    /// Reports whether this disconnect ended the session, i.e. the helper should
    /// reap itself. Only a claimed session with no authorized connections left
    /// closes, so an unauthorized peer hanging up can never take the helper down.
    public mutating func disconnect(_ connection: AgentSessionConnectionID) -> Bool {
        guard authorizedConnections.remove(connection) != nil else { return false }
        guard wasClaimed, authorizedConnections.isEmpty else { return false }
        sessionClosed = true
        return true
    }
}

public func isAuthenticatedAgentSession(
    expectedToken: String?,
    requestToken: String?,
    authorizedPeer: Bool
) -> Bool {
    guard authorizedPeer else { return false }
    guard let expectedToken else { return true }
    return requestToken == expectedToken
}
