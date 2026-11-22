// Makes docs/images/demo.gif from demo-mode screenshots (Apple ImageIO, no extra tools).
// Run from docs/images: swift ../../scripts/make-demo-gif.swift demo.gif panel.png panel-chat-card.png panel-edit-groups.png panel-projects-card.png
import Foundation
import ImageIO
import UniformTypeIdentifiers
import CoreGraphics
let a = CommandLine.arguments
let out = URL(fileURLWithPath: a[1])
let scale = 0.7
let files = Array(a[2...])
let dest = CGImageDestinationCreateWithURL(out as CFURL, UTType.gif.identifier as CFString, files.count, nil)!
CGImageDestinationSetProperties(dest, [kCGImagePropertyGIFDictionary: [kCGImagePropertyGIFLoopCount: 0]] as CFDictionary)
for (i, f) in files.enumerated() {
  let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: f) as CFURL, nil)!
  let img = CGImageSourceCreateImageAtIndex(src, 0, nil)!
  let w = Int(Double(img.width) * scale), h = Int(Double(img.height) * scale)
  let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
  ctx.interpolationQuality = .high
  ctx.draw(img, in: CGRect(x: 0, y: 0, width: w, height: h))
  let delay = i == 0 ? 3.0 : 2.2
  CGImageDestinationAddImage(dest, ctx.makeImage()!, [kCGImagePropertyGIFDictionary: [kCGImagePropertyGIFDelayTime: delay]] as CFDictionary)
}
print(CGImageDestinationFinalize(dest))
