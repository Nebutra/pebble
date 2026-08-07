import PebbleComputerUseMacOSCore
import XCTest

final class AgentPeerAuthorizationTests: XCTestCase {
    func testParsesTheFullAgentInvocation() {
        let parsed = AgentLaunchArguments.parse([
            "--agent", "/tmp/provider.sock", "--token-file", "/tmp/provider.token", "--peer-pid", "4321"
        ])

        XCTAssertEqual(
            parsed,
            AgentLaunchArguments(
                socketPath: "/tmp/provider.sock",
                tokenFilePath: "/tmp/provider.token",
                expectedPeerProcessId: 4321
            )
        )
    }

    func testRejectsAnInvocationWithoutAPeerPid() {
        XCTAssertNil(AgentLaunchArguments.parse([
            "--agent", "/tmp/provider.sock", "--token-file", "/tmp/provider.token"
        ]))
    }

    func testRejectsAMalformedOrNonPositivePeerPid() {
        for pid in ["0", "-1", "not-a-pid", ""] {
            XCTAssertNil(
                AgentLaunchArguments.parse([
                    "--agent", "/tmp/provider.sock", "--token-file", "/tmp/provider.token",
                    "--peer-pid", pid
                ]),
                "expected \(pid) to be rejected"
            )
        }
    }

    func testRejectsEmptyPathsAndReorderedFlags() {
        XCTAssertNil(AgentLaunchArguments.parse([
            "--agent", "", "--token-file", "/tmp/provider.token", "--peer-pid", "42"
        ]))
        XCTAssertNil(AgentLaunchArguments.parse([
            "--agent", "/tmp/provider.sock", "--token-file", "", "--peer-pid", "42"
        ]))
        XCTAssertNil(AgentLaunchArguments.parse([
            "--agent", "/tmp/provider.sock", "--peer-pid", "42", "--token-file", "/tmp/provider.token"
        ]))
    }

    func testOnlyTheSupervisingProcessIsAuthorized() {
        XCTAssertTrue(isAuthorizedAgentPeer(peerProcessId: 4321, expectedProcessId: 4321))
        XCTAssertFalse(isAuthorizedAgentPeer(peerProcessId: 4322, expectedProcessId: 4321))
    }

    func testAnUnreadablePeerIsRejected() {
        XCTAssertFalse(isAuthorizedAgentPeer(peerProcessId: nil, expectedProcessId: 4321))
    }

    func testAnUnboundHelperAuthorizesNobody() {
        XCTAssertFalse(isAuthorizedAgentPeer(peerProcessId: 0, expectedProcessId: 0))
        XCTAssertFalse(isAuthorizedAgentPeer(peerProcessId: nil, expectedProcessId: 0))
    }
}
