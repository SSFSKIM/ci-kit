// Part of the mac runner's dialog check (dialog.sh): the windows on screen, so a system dialog that is up but not in
// front is seen too (2026-10-21: a SecurityAgent keychain prompt sat on the mini's screen for hours with Terminal in
// front, and a read of the frontmost app alone would have admitted every job under it).
//
// One line per window on screen, tab-separated: owner pid, layer, alpha, x, y, width, height (points), the owner's
// bundle id ('-' when it has none) and its name. The owner fields, layer, alpha and bounds need no Screen Recording
// grant; a window's title does, so it is never read. Nothing here raises a prompt, creates an event or acts on a window.
// Exits 1 when the window server gives no list (a session with no window server to ask).
import AppKit
import CoreGraphics

guard let windows = CGWindowListCopyWindowInfo(.optionOnScreenOnly, kCGNullWindowID) as? [[String: Any]] else {
    FileHandle.standardError.write("no window list\n".data(using: .utf8)!)
    exit(1)
}
var bundles: [Int32: String] = [:]
var out = ""
for window in windows {
    guard let pid = (window[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value else { continue }
    let layer = (window[kCGWindowLayer as String] as? NSNumber)?.intValue ?? 0
    let alpha = (window[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 1
    var bounds = CGRect.zero
    if let dict = window[kCGWindowBounds as String] as? NSDictionary {
        bounds = CGRect(dictionaryRepresentation: dict as CFDictionary) ?? .zero
    }
    if bundles[pid] == nil {
        bundles[pid] = NSRunningApplication(processIdentifier: pid)?.bundleIdentifier ?? "-"
    }
    // A tab or newline in a name would break the line; neither belongs in one.
    let name = ((window[kCGWindowOwnerName as String] as? String) ?? "")
        .replacingOccurrences(of: "\t", with: " ").replacingOccurrences(of: "\n", with: " ")
    out += "\(pid)\t\(layer)\t\(alpha)\t\(Int(bounds.minX))\t\(Int(bounds.minY))\t\(Int(bounds.width))\t\(Int(bounds.height))\t\(bundles[pid]!)\t\(name)\n"
}
print(out, terminator: "")
