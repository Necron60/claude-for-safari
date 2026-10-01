// Draws the extension's PNG icons. Run from the project folder:
//   swift tools/make-icons.swift
import AppKit

let outDir = URL(fileURLWithPath: "extension/icons", isDirectory: true)
try? FileManager.default.createDirectory(at: outDir, withIntermediateDirectories: true)

let terracotta = CGColor(srgbRed: 0xD9 / 255, green: 0x77 / 255, blue: 0x57 / 255, alpha: 1)
let cream = CGColor(srgbRed: 0xFA / 255, green: 0xF9 / 255, blue: 0xF5 / 255, alpha: 1)

// One tapered ray pointing along +x, rounded at the tip.
func ray(length: CGFloat, base: CGFloat, tip: CGFloat) -> CGPath {
    let path = CGMutablePath()
    path.move(to: CGPoint(x: 0, y: -base / 2))
    path.addLine(to: CGPoint(x: length - tip / 2, y: -tip / 2))
    path.addArc(center: CGPoint(x: length - tip / 2, y: 0), radius: tip / 2,
                startAngle: -.pi / 2, endAngle: .pi / 2, clockwise: false)
    path.addLine(to: CGPoint(x: 0, y: base / 2))
    path.closeSubpath()
    return path
}

// A starburst of alternating long and short rays.
func drawSpark(_ ctx: CGContext, center: CGPoint, radius: CGFloat, rays: Int, weight: CGFloat, color: CGColor) {
    ctx.setFillColor(color)
    for i in 0..<rays {
        let long = i % 2 == 0
        let length = radius * (long ? 1.0 : 0.74)
        var transform = CGAffineTransform(translationX: center.x, y: center.y)
            .rotated(by: CGFloat(i) * 2 * .pi / CGFloat(rays) + .pi / 2)
        if let path = ray(length: length, base: radius * 0.30 * weight, tip: radius * 0.16 * weight)
            .copy(using: &transform) {
            ctx.addPath(path)
            ctx.fillPath()
        }
    }
    ctx.fillEllipse(in: CGRect(x: center.x - radius * 0.2, y: center.y - radius * 0.2,
                               width: radius * 0.4, height: radius * 0.4))
}

func render(size: Int, name: String, draw: (CGContext, CGFloat) -> Void) throws {
    guard let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size,
                                     bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                                     colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0),
          let context = NSGraphicsContext(bitmapImageRep: rep) else { return }
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = context
    let ctx = context.cgContext
    ctx.setShouldAntialias(true)
    ctx.interpolationQuality = .high
    draw(ctx, CGFloat(size))
    NSGraphicsContext.restoreGraphicsState()
    let data = rep.representation(using: .png, properties: [:])!
    try data.write(to: outDir.appendingPathComponent(name))
}

// Toolbar: the spark alone, slightly heavier so it holds up at 16px.
for size in [16, 19, 32, 38, 48] {
    try render(size: size, name: "toolbar-\(size).png") { ctx, s in
        drawSpark(ctx, center: CGPoint(x: s / 2, y: s / 2), radius: s * 0.47, rays: 10, weight: 1.25, color: terracotta)
    }
}

// App / settings icon: cream spark on a terracotta rounded square.
for size in [48, 96, 128, 256, 512] {
    try render(size: size, name: "icon-\(size).png") { ctx, s in
        let inset = s * 0.06
        let rect = CGRect(x: inset, y: inset, width: s - inset * 2, height: s - inset * 2)
        ctx.addPath(CGPath(roundedRect: rect, cornerWidth: s * 0.22, cornerHeight: s * 0.22, transform: nil))
        ctx.setFillColor(terracotta)
        ctx.fillPath()
        drawSpark(ctx, center: CGPoint(x: s / 2, y: s / 2), radius: s * 0.3, rays: 10, weight: 1.0, color: cream)
    }
}

print("Icons written to \(outDir.path)")
