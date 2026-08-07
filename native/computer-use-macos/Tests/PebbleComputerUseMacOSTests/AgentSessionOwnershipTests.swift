import PebbleComputerUseMacOSCore
import XCTest

final class AgentSessionOwnershipTests: XCTestCase {
    private let first = AgentSessionConnectionID(rawValue: 1)
    private let second = AgentSessionConnectionID(rawValue: 2)

    func testTheFirstAuthorizedConnectionClaimsTheSession() {
        var ownership = AgentSessionOwnership()

        XCTAssertEqual(ownership.registerConnection(first, authorized: true), .claimed)
        XCTAssertEqual(ownership.registerConnection(second, authorized: true), .retained)
    }

    func testAnUnauthorizedConnectionNeverClaimsOrClosesTheSession() {
        var ownership = AgentSessionOwnership()

        XCTAssertEqual(ownership.registerConnection(first, authorized: false), .rejected)
        XCTAssertFalse(ownership.disconnect(first))
    }

    func testTheSessionClosesOnlyAfterTheLastAuthorizedConnectionLeaves() {
        var ownership = AgentSessionOwnership()
        _ = ownership.registerConnection(first, authorized: true)
        _ = ownership.registerConnection(second, authorized: true)

        XCTAssertFalse(ownership.disconnect(first))
        XCTAssertTrue(ownership.disconnect(second))
    }

    func testAnUnauthorizedPeerCannotTakeDownAClaimedSession() {
        var ownership = AgentSessionOwnership()
        _ = ownership.registerConnection(first, authorized: true)
        _ = ownership.registerConnection(second, authorized: false)

        XCTAssertFalse(ownership.disconnect(second))
        XCTAssertTrue(ownership.disconnect(first))
    }

    func testALateReconnectCannotResurrectAClosedSession() {
        var ownership = AgentSessionOwnership()
        _ = ownership.registerConnection(first, authorized: true)
        XCTAssertTrue(ownership.disconnect(first))

        XCTAssertEqual(ownership.registerConnection(second, authorized: true), .rejected)
    }

    func testADuplicateDisconnectDoesNotReportTheSessionClosedTwice() {
        var ownership = AgentSessionOwnership()
        _ = ownership.registerConnection(first, authorized: true)

        XCTAssertTrue(ownership.disconnect(first))
        XCTAssertFalse(ownership.disconnect(first))
    }

    func testAnUnclaimedSessionNeverCloses() {
        var ownership = AgentSessionOwnership()
        _ = ownership.registerConnection(first, authorized: false)
        _ = ownership.registerConnection(second, authorized: false)

        XCTAssertFalse(ownership.disconnect(first))
        XCTAssertFalse(ownership.disconnect(second))
    }

    func testTokenStillGatesAnAuthorizedPeer() {
        XCTAssertTrue(
            isAuthenticatedAgentSession(expectedToken: "t", requestToken: "t", authorizedPeer: true)
        )
        XCTAssertFalse(
            isAuthenticatedAgentSession(expectedToken: "t", requestToken: "x", authorizedPeer: true)
        )
        XCTAssertFalse(
            isAuthenticatedAgentSession(expectedToken: "t", requestToken: "t", authorizedPeer: false)
        )
    }
}
