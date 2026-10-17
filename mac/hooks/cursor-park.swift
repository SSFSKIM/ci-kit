// Part of the mac runner's job-started hook: park the real cursor on the menu bar before every job.
//
// An e2e app opens its window wherever macOS puts it, and the real cursor may rest over that spot. The window then
// gets pointer events the test never sent (2026-10-16: MAWS's dashboard hover step failed twice on a pointerover at
// the same 963,776, where the cursor sat). The menu bar is never under an app window, and warping the cursor needs no
// Accessibility grant. Prints the position before and after; never fails the job.
import CoreGraphics

let bounds = CGDisplayBounds(CGMainDisplayID())
if CommandLine.arguments.dropFirst().first == "--describe" {
    // The mode's pixel width is the backing framebuffer, not the panel's physical pixels (scaled HiDPI included).
    // CGDisplayBounds is in points. This branch only reads; it never creates an event or moves the cursor.
    if let mode = CGDisplayCopyDisplayMode(CGMainDisplayID()), mode.width > 0, bounds.width > 0, bounds.height > 0 {
        let scale = Double(mode.pixelWidth) / Double(mode.width)
        let scaleText = scale == scale.rounded() ? "\(Int(scale))" : "\(scale)"
        print("\(Int(bounds.width))x\(Int(bounds.height))@\(scaleText)x")
    } else {
        print("unknown")
    }
} else {
    let before = CGEvent(source: nil)?.location
    let target = CGPoint(x: bounds.midX, y: bounds.minY + 2)
    let result = CGWarpMouseCursorPosition(target)
    let after = CGEvent(source: nil)?.location
    func show(_ p: CGPoint?) -> String { p.map { "\(Int($0.x)),\(Int($0.y))" } ?? "unknown" }
    print("cursor before=\(show(before)) after=\(show(after)) target=\(show(target))\(result == .success ? "" : " warp-error=\(result.rawValue)")")
}
