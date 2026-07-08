// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "PebbleComputerUseMacOS",
    platforms: [
        .macOS(.v14)
    ],
    products: [
        .library(
            name: "PebbleComputerUseMacOSCore",
            targets: ["PebbleComputerUseMacOSCore"]
        ),
        .executable(
            name: "pebble-computer-use-macos",
            targets: ["PebbleComputerUseMacOS"]
        )
    ],
    targets: [
        .target(
            name: "PebbleComputerUseMacOSCore",
            path: "Sources/PebbleComputerUseMacOSCore"
        ),
        .executableTarget(
            name: "PebbleComputerUseMacOS",
            dependencies: ["PebbleComputerUseMacOSCore"],
            path: "Sources/PebbleComputerUseMacOS"
        ),
        .testTarget(
            name: "PebbleComputerUseMacOSTests",
            dependencies: ["PebbleComputerUseMacOSCore"],
            path: "Tests/PebbleComputerUseMacOSTests"
        )
    ]
)
