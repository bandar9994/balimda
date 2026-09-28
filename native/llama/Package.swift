// swift-tools-version: 5.9
// Balimda — © 2026 Bandar Altariqi. All rights reserved.
// Licensed under the Balimda License (see LICENSE).

import PackageDescription

let package = Package(
    name: "BalimdaLlama",
    platforms: [.iOS(.v15)],
    products: [
        .library(
            name: "BalimdaLlama",
            targets: ["LlamaPlugin"])
    ],
    dependencies: [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", from: "8.0.0")
    ],
    targets: [
        // llama.cpp's own build for Apple devices (Metal GPU), same release as Android.
        .binaryTarget(
            name: "llama",
            url: "https://github.com/ggml-org/llama.cpp/releases/download/b11170/llama-b11170-xcframework.zip",
            checksum: "f28302b59b997ac6b626e78a315dd33ad19cb51058a3e98ec996d3ae9693664e"),
        // The engine shared with Android (chat template, fitting the chat, KV cache reuse).
        .target(
            name: "BalimdaEngine",
            dependencies: ["llama"],
            path: "engine",
            publicHeadersPath: "include",
            linkerSettings: [.linkedLibrary("c++")]),
        .target(
            name: "LlamaPlugin",
            dependencies: [
                .product(name: "Capacitor", package: "capacitor-swift-pm"),
                .product(name: "Cordova", package: "capacitor-swift-pm"),
                "BalimdaEngine"
            ],
            path: "ios/Sources/LlamaPlugin")
    ],
    cxxLanguageStandard: .cxx17
)
