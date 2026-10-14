/* eslint-disable */
// Puts an SVG file on the macOS clipboard as public.svg-image (what Wecra's paste reads as vector artwork).
// osascript -l JavaScript pasteboard-svg.js <file.svg>
ObjC.import('AppKit');
function run(argv) {
  const svg = $.NSString.stringWithContentsOfFileEncodingError(argv[0], $.NSUTF8StringEncoding, null);
  const pb = $.NSPasteboard.generalPasteboard;
  pb.clearContents;
  return pb.setStringForType(svg, 'public.svg-image');
}
