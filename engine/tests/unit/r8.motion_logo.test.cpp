// Figma Motion, an end-to-end piece on the editing commands (docs/motion.md §4.9) and the evaluator (§4.4): the Figma
// logo's five pieces animated over an 8 s LOOP timeline — they assemble (position, opacity, scale, staggered), pulse,
// spin (the circle bobs), then leave. Built only through MOTION_ADD_KEYFRAME / MOTION_SET_TIMELINE, played back
// through the motion layer; a few frames are checked. MOTION_LOGO_DIR=<dir> also writes the evaluated frames at 30 fps
// (`figma-logo-frames.json`, drawn by scripts/motion-logo-render.mjs) and the finished document as a NODE_CHANGES
// message (`figma-logo-motion.json`, the editor's `?editor&doc=motion` fixture).
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <string>

#include "Helpers.h"
#include "doctest.h"
#include "editor/Editor.h"
#include "scene/CodecJson.h"

using namespace eng;
using namespace eng::test;

namespace {

const Guid kRoot{1, 1};
const Guid kPiece[5] = {{1, 2}, {1, 3}, {1, 4}, {1, 5}, {1, 6}};
const char* kPieceRef[5] = {"1:2", "1:3", "1:4", "1:5", "1:6"};
const char* kPieceName[5] = {"Red", "Orange", "Purple", "Blue", "Green"};
// The logo: 100 × 100 cells of a 200 × 300 grid, inside a 400 × 600 frame at (100, 150).
const double kCell = 100;
const double kLogoX = 100, kLogoY = 150;
const double kAt[5][2] = {{0, 0}, {1, 0}, {0, 1}, {1, 1}, {0, 2}};
const uint32_t kColor[5] = {0xF24E1E, 0xFF7262, 0xA259FF, 0x1ABCFE, 0x0ACF83};
// Corner radii TL, TR, BR, BL: the half-pills, the circle (an ELLIPSE), the three-quarter round.
const double kRadii[5][4] = {{50, 0, 0, 50}, {0, 50, 50, 0}, {50, 0, 0, 50}, {0, 0, 0, 0}, {50, 0, 50, 50}};
// Where each piece comes from (and leaves to), relative to its place.
const double kFrom[5][2] = {{-320, -120}, {320, -120}, {-320, 0}, {320, 0}, {-320, 140}};

void load(Editor& e) {
  std::vector<NodeChange> nodes = baseChanges();
  NodeChange root = make(kRoot, NodeType::FRAME, kPage, "!", {0, 0, 400, 600}, "Figma logo");
  Paint bg;
  bg.color = Color::hex(0x0F0F0F);
  root.props.fillPaints = {bg};
  nodes.push_back(root);
  std::string pos = "!";
  for (int i = 0; i < 5; i++) {
    NodeType type = i == 3 ? NodeType::ELLIPSE : NodeType::ROUNDED_RECTANGLE;
    NodeChange c = make(kPiece[i], type, kRoot, pos, {kLogoX + kAt[i][0] * kCell, kLogoY + kAt[i][1] * kCell, kCell, kCell}, kPieceName[i]);
    Paint fill;
    fill.color = Color::hex(kColor[i]);
    c.props.fillPaints = {fill};
    if (type == NodeType::ROUNDED_RECTANGLE) c.props.cornerRadii = {kRadii[i][0], kRadii[i][1], kRadii[i][2], kRadii[i][3]};
    nodes.push_back(c);
    pos[0]++;
  }
  e.setSessionID(1);
  e.setViewport(800, 600, 1, 800, 600);
  e.loadDocument(nodes, kPage);
  e.takeEvents();
}

motion::State on(int64_t timeUs) {
  motion::State s;
  s.on = true;
  s.root = kRoot;
  s.timeUs = timeUs;
  return s;
}

std::string num(double v) {
  char b[64];
  std::snprintf(b, sizeof b, "%.4g", v);
  return b;
}

// One keyframe through the public command: field, time (ms), a FLOAT or VECTOR value, the easing into it.
void key(Editor& e, int piece, const char* field, double ms, const std::string& value, const char* easing) {
  std::string json = std::string("{\"nodes\":[\"") + kPieceRef[piece] + "\"],\"field\":{\"type\":\"PROPERTY\",\"name\":\"" + field + "\"},\"timeUs\":" +
                     std::to_string(static_cast<long long>(ms * 1000)) + ",\"value\":" + value + ",\"easing\":{\"type\":\"" + easing + "\"}}";
  CommandArgs a;
  REQUIRE(json::parse(json, a.raw));
  REQUIRE(e.command(CommandId::MOTION_ADD_KEYFRAME, a) == OK);
}
std::string f(double v) { return "{\"type\":\"FLOAT\",\"value\":" + num(v) + "}"; }
std::string vec(double x, double y) { return "{\"type\":\"VECTOR\",\"value\":{\"x\":" + num(x) + ",\"y\":" + num(y) + "}}"; }

// The animation: assemble (0–2 s), pulse (2.6–3.6 s), spin / bob (4–5.6 s), leave (6.4–7.6 s); 8 s LOOP.
void animate(Editor& e) {
  CommandArgs tl;
  REQUIRE(json::parse(R"({"root":"1:1","durationUs":8000000,"playback":"LOOP","snappingFps":30})", tl.raw));
  REQUIRE(e.command(CommandId::MOTION_SET_TIMELINE, tl) == OK);
  for (int i = 0; i < 5; i++) {
    const double t0 = i * 150;
    // Assemble: from outside, faded and small, settling with a spring.
    key(e, i, "TRANSLATION_XY", t0, vec(kFrom[i][0], kFrom[i][1]), "LINEAR");
    key(e, i, "TRANSLATION_XY", t0 + 900, vec(0, 0), "BOUNCY");
    key(e, i, "OPACITY", t0, f(0), "LINEAR");
    key(e, i, "OPACITY", t0 + 500, f(1), "EASE_OUT");
    key(e, i, "SCALE_XY", t0, vec(0.6, 0.6), "LINEAR");
    key(e, i, "SCALE_XY", t0 + 900, vec(1, 1), "EASE_OUT_BACK");
    // Pulse: a breath, one piece after the other.
    const double p0 = 2600 + i * 80;
    key(e, i, "SCALE_XY", p0, vec(1, 1), "LINEAR");
    key(e, i, "SCALE_XY", p0 + 300, vec(1.15, 1.15), "EASE_IN_AND_OUT");
    key(e, i, "SCALE_XY", p0 + 800, vec(1, 1), "EASE_OUT");
    // Spin (the circle bobs instead: a turn is invisible on it).
    const double s0 = 4000 + i * 100;
    if (i == 3) {
      key(e, i, "TRANSLATION_XY", s0, vec(0, 0), "LINEAR");
      key(e, i, "TRANSLATION_XY", s0 + 600, vec(0, -60), "EASE_OUT");
      key(e, i, "TRANSLATION_XY", s0 + 1200, vec(0, 0), "BOUNCY");
    } else {
      key(e, i, "ROTATION", s0, f(0), "LINEAR");
      key(e, i, "ROTATION", s0 + 1200, f(360), "EASE_IN_AND_OUT");
    }
    // Leave: back out the way it came, fading and shrinking.
    const double l0 = 6400 + i * 120;
    key(e, i, "TRANSLATION_XY", l0, vec(0, 0), "LINEAR");
    key(e, i, "TRANSLATION_XY", l0 + 600, vec(kFrom[i][0], kFrom[i][1]), "EASE_IN");
    key(e, i, "OPACITY", l0 + 100, f(1), "LINEAR");
    key(e, i, "OPACITY", l0 + 600, f(0), "EASE_IN");
    key(e, i, "SCALE_XY", l0, vec(1, 1), "LINEAR");
    key(e, i, "SCALE_XY", l0 + 600, vec(0.6, 0.6), "EASE_IN");
  }
}

size_t countType(const Document& d, NodeType t) {
  size_t n = 0;
  d.forEach([&](const Node& node) { n += node.props.type == t ? 1 : 0; });
  return n;
}

}  // namespace

TEST_CASE("motion logo: the Figma logo's five pieces keyframed over an 8 s loop, played by the layer") {
  Editor e;
  load(e);
  e.setMotion(on(0));
  animate(e);
  const Document& doc = e.document();
  // Five pieces × (position, opacity, scale, rotation or the bob on the same position track): 4 tracks each but the circle's 3.
  CHECK(countType(doc, NodeType::KEYFRAME_TRACK) == 19);
  motion::Timeline tl = e.motionIndex().timeline(doc, kRoot);
  CHECK(tl.durationUs == 8000000);
  CHECK(tl.playback == motion::Playback::LOOP);
  const Node* red = doc.get(kPiece[0]);
  const Node* blue = doc.get(kPiece[3]);
  // t = 0: the red piece is away and invisible, small.
  e.setMotion(on(0));
  CHECK(red->props.opacity == doctest::Approx(0));
  CHECK(red->props.transform.m02 < kLogoX - 200);
  // t = 2.2 s: everything has arrived at its place, full size and opaque.
  e.setMotion(on(2200000));
  for (int i = 0; i < 5; i++) {
    const Node* n = doc.get(kPiece[i]);
    CHECK(n->props.opacity == doctest::Approx(1));
    CHECK(n->props.transform.m02 == doctest::Approx(kLogoX + kAt[i][0] * kCell).epsilon(0.01));
    CHECK(n->props.transform.m12 == doctest::Approx(kLogoY + kAt[i][1] * kCell).epsilon(0.01));
    CHECK(n->props.transform.m00 == doctest::Approx(1).epsilon(0.01));
  }
  // t = 2.9 s: the red piece is mid-pulse, bigger than 1.
  e.setMotion(on(2900000));
  CHECK(red->props.transform.m00 > 1.1);
  // t = 4.3 s: the red piece is a quarter into its turn (a rotation shows in m01); at 4.6 s the circle is up.
  e.setMotion(on(4300000));
  CHECK(std::fabs(red->props.transform.m01) > 0.1);
  e.setMotion(on(4600000));
  CHECK(blue->props.transform.m12 < kLogoY + kCell - 30);
  // t = 7.9 s: gone again; the base is untouched.
  e.setMotion(on(7900000));
  CHECK(red->props.opacity == doctest::Approx(0));
  e.setMotion(motion::State{});
  CHECK(red->props.opacity == doctest::Approx(1));
  CHECK(red->props.transform.m02 == doctest::Approx(kLogoX));

  const char* dir = std::getenv("MOTION_LOGO_DIR");
  if (!dir) return;
  // The frames at 30 fps: each piece's matrix, size, opacity, radii and colour.
  std::string out = "{\"root\":{\"w\":400,\"h\":600,\"bg\":\"#0F0F0F\"},\"fps\":30,\"frames\":[";
  const int frames = 8 * 30;
  for (int fi = 0; fi <= frames; fi++) {
    e.setMotion(on(static_cast<int64_t>(std::llround(fi * 1e6 / 30.0))));
    out += fi ? ",[" : "[";
    for (int i = 0; i < 5; i++) {
      const NodeProps& p = doc.get(kPiece[i])->props;
      char buf[512];
      std::snprintf(buf, sizeof buf, "%s{\"m\":[%.5g,%.5g,%.5g,%.5g,%.5g,%.5g],\"w\":%g,\"h\":%g,\"o\":%.4g,\"r\":[%g,%g,%g,%g],\"c\":\"#%06X\",\"e\":%d}", i ? "," : "",
                    p.transform.m00, p.transform.m01, p.transform.m02, p.transform.m10, p.transform.m11, p.transform.m12, p.size.x, p.size.y, p.opacity,
                    p.cornerRadii[0], p.cornerRadii[1], p.cornerRadii[2], p.cornerRadii[3], kColor[i], i == 3 ? 1 : 0);
      out += buf;
    }
    out += "]";
  }
  out += "]}";
  std::string path = std::string(dir) + "/figma-logo-frames.json";
  FILE* fp = std::fopen(path.c_str(), "wb");
  REQUIRE(fp);
  std::fwrite(out.data(), 1, out.size(), fp);
  std::fclose(fp);
  // The document, Motion off (base values), as the editor's fixture message.
  e.setMotion(motion::State{});
  json::Writer w;
  codec::writeMessage(w, 1, e.encodeDocument());
  std::string msg = w.take();
  path = std::string(dir) + "/figma-logo-motion.json";
  fp = std::fopen(path.c_str(), "wb");
  REQUIRE(fp);
  std::fwrite(msg.data(), 1, msg.size(), fp);
  std::fclose(fp);
  MESSAGE("wrote " << path);
}
