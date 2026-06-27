// Generates Loopkeeper's 1024×1024 app icon (opaque, no alpha) — a white "loop" ring with a
// gap being closed by a checkmark, on the brand gradient. Run:
//   swift ios/tools/gen-icon.swift ios/Assets.xcassets/AppIcon.appiconset/icon-1024.png
import AppKit

let side = 1024
let rep = NSBitmapImageRep(
    bitmapDataPlanes: nil, pixelsWide: side, pixelsHigh: side,
    bitsPerSample: 8, samplesPerPixel: 3, hasAlpha: false, isPlanar: false,
    colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0
)!

let ctx = NSGraphicsContext(bitmapImageRep: rep)!
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = ctx
let cg = ctx.cgContext

// Brand gradient background.
let space = CGColorSpaceCreateDeviceRGB()
let grad = CGGradient(
    colorsSpace: space,
    colors: [
        NSColor(srgbRed: 0.30, green: 0.36, blue: 0.92, alpha: 1).cgColor,
        NSColor(srgbRed: 0.12, green: 0.50, blue: 0.98, alpha: 1).cgColor,
    ] as CFArray,
    locations: [0, 1]
)!
cg.drawLinearGradient(grad, start: CGPoint(x: 0, y: side), end: CGPoint(x: side, y: 0), options: [])

cg.setStrokeColor(NSColor.white.cgColor)
cg.setLineCap(.round)

// The "loop": a ring with a gap (an open loop).
cg.setLineWidth(74)
cg.addArc(center: CGPoint(x: 512, y: 512), radius: 300, startAngle: .pi * 0.32, endAngle: .pi * 2.18, clockwise: false)
cg.strokePath()

// The "kept": a checkmark closing it.
cg.setLineWidth(74)
cg.move(to: CGPoint(x: 392, y: 520))
cg.addLine(to: CGPoint(x: 476, y: 426))
cg.addLine(to: CGPoint(x: 648, y: 624))
cg.strokePath()

NSGraphicsContext.restoreGraphicsState()

let out = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "icon-1024.png"
let png = rep.representation(using: .png, properties: [:])!
try! png.write(to: URL(fileURLWithPath: out))
print("wrote \(out)")
