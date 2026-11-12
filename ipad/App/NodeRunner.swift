import Foundation
import NodeMobile

// Starts Node (nodejs-mobile) inside this app. Node can be started once per process, and it
// only returns when it exits, so it runs on its own thread (ServerHost).
enum NodeRunner {
    static func run(arguments: [String]) -> Int32 {
        // Node expects argv as one contiguous block of NUL-terminated strings.
        let sizes = arguments.map { $0.utf8.count + 1 }
        let total = sizes.reduce(0, +)
        let block = UnsafeMutablePointer<CChar>.allocate(capacity: total)
        block.initialize(repeating: 0, count: total)
        defer { block.deallocate() }

        var argv: [UnsafeMutablePointer<CChar>?] = []
        var offset = 0
        for (index, argument) in arguments.enumerated() {
            let start = block + offset
            var position = 0
            for byte in argument.utf8 {
                start[position] = CChar(bitPattern: byte)
                position += 1
            }
            argv.append(start)
            offset += sizes[index]
        }

        let count = Int32(arguments.count)
        return argv.withUnsafeMutableBufferPointer { buffer -> Int32 in
            node_start(count, buffer.baseAddress)
        }
    }
}
