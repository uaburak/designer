// Figma Motion, round 8e (docs/motion.md §4.11, §6.6): audio on a timeline root — `audioFills` (603) clips and their
// `audioTracks` (605) rows, added from a stored file, moved, trimmed, re-volumed, muted, split at the playhead and
// deleted (MOTION_ADD_AUDIO / SET_AUDIO / SPLIT_AUDIO / REMOVE_AUDIO), each one undo step, and listed in the timeline
// model. The engine only stores them: the renderer plays and mixes them.
#include "Helpers.h"
#include "doctest.h"
#include "editor/Editor.h"
#include "motion/Model.h"
#include "scene/CodecKiwi.h"

using namespace eng;
using namespace eng::test;

namespace {

const Guid kRoot{1, 1}, kRect{1, 2}, kChild{1, 3};
const char* kHash = "0123456789abcdef0123456789abcdef01234567";

void load(Editor& e) {
  std::vector<NodeChange> nodes = baseChanges();
  nodes.push_back(make(kRoot, NodeType::FRAME, kPage, "!", {0, 0, 400, 300}, "Root"));
  nodes.push_back(make(kRect, NodeType::ROUNDED_RECTANGLE, kRoot, "!", {20, 30, 100, 50}, "Rect"));
  nodes.push_back(make(kChild, NodeType::FRAME, kRoot, "\"", {200, 30, 50, 50}, "Inner"));
  e.setSessionID(1);
  e.setViewport(800, 600, 1, 800, 600);
  e.loadDocument(nodes, kPage);
  e.takeEvents();
}

CommandArgs args(const std::string& json) {
  CommandArgs a;
  REQUIRE(json::parse(json, a.raw));
  return a;
}

json::Value parsed(const std::string& text) {
  json::Value v;
  REQUIRE(json::parse(text, v));
  return v;
}

motion::State on(int64_t timeUs) {
  motion::State s;
  s.on = true;
  s.root = kRoot;
  s.timeUs = timeUs;
  return s;
}

std::string addAudio(int64_t offsetUs, int64_t durationUs, const std::string& extra = "") {
  return R"({"root":"1:1","mediaHash":")" + std::string(kHash) + R"(","name":"Beat.mp3","offsetUs":)" + std::to_string(offsetUs) +
         R"(,"durationUs":)" + std::to_string(durationUs) + extra + "}";
}

std::vector<motion::AudioClip> clipsOf(const Editor& e) { return motion::decodeAudioClips(e.document().get(kRoot)->props); }
std::vector<motion::AudioRow> rowsOf(const Editor& e) { return motion::decodeAudioRows(e.document().get(kRoot)->props); }

}  // namespace

TEST_CASE("motion audio: Add audio puts a clip on a row of its own on the root; the timeline lists both; one undo step") {
  Editor e;
  load(e);
  e.setSelection({kRect});
  e.setMotion(on(0));
  REQUIRE(e.command(CommandId::MOTION_ADD_AUDIO, args(addAudio(250000, 3000000))) == OK);
  CHECK(e.undoStack().undoLabel() == "Add audio");
  REQUIRE(e.lastCreated().size() == 1);
  std::vector<motion::AudioClip> clips = clipsOf(e);
  std::vector<motion::AudioRow> rows = rowsOf(e);
  REQUIRE(clips.size() == 1);
  REQUIRE(rows.size() == 1);
  CHECK(clips[0].id == e.lastCreated()[0]);
  CHECK(clips[0].mediaHash == kHash);
  CHECK(clips[0].name == "Beat.mp3");
  CHECK(clips[0].offsetUs == 250000);
  CHECK(clips[0].startUs == 0);
  CHECK(clips[0].durationUs == 3000000);
  CHECK(clips[0].volume == doctest::Approx(1));
  CHECK_FALSE(clips[0].mute);
  CHECK(clips[0].track == rows[0].id);
  CHECK(rows[0].name == "Beat.mp3");
  CHECK(rows[0].gain == doctest::Approx(1));
  // A second file gets its own row; one naming a row joins it.
  REQUIRE(e.command(CommandId::MOTION_ADD_AUDIO, args(addAudio(0, 1000000))) == OK);
  CHECK(rowsOf(e).size() == 2);
  REQUIRE(e.command(CommandId::MOTION_ADD_AUDIO, args(addAudio(5000000, 500000, R"(,"trackId":")" + rows[0].id.toString() + "\""))) == OK);
  CHECK(rowsOf(e).size() == 2);
  CHECK(clipsOf(e)[2].track == rows[0].id);
  // The timeline model: the rows, then the clips with their region.
  json::Writer w;
  e.writeMotionTimeline(w, kRoot);
  json::Value tl = parsed(w.take());
  REQUIRE(tl.get("audioTracks")->array.size() == 2);
  REQUIRE(tl.get("audio")->array.size() == 3);
  const json::Value& a = tl.get("audio")->array[0];
  CHECK(a.get("id")->string == clips[0].id.toString());
  CHECK(a.get("trackId")->string == rows[0].id.toString());
  CHECK(a.get("mediaHash")->string == kHash);
  CHECK(a.get("offsetUs")->number == 250000);
  CHECK(a.get("startUs")->number == 0);
  CHECK(a.get("durationUs")->number == 3000000);
  CHECK(a.get("volume")->number == doctest::Approx(1));
  CHECK_FALSE(a.get("mute")->boolean);
  CHECK(tl.get("audioTracks")->array[0].get("name")->string == "Beat.mp3");
  // Each add was one step; the first undone leaves the root without audio.
  REQUIRE(e.command(CommandId::UNDO) == OK);
  REQUIRE(e.command(CommandId::UNDO) == OK);
  CHECK(clipsOf(e).size() == 1);
  REQUIRE(e.command(CommandId::UNDO) == OK);
  CHECK(clipsOf(e).empty());
  CHECK(rowsOf(e).empty());
  REQUIRE(e.command(CommandId::REDO) == OK);
  CHECK(clipsOf(e).size() == 1);
}

TEST_CASE("motion audio: only a timeline root takes audio, and only a stored file with a length") {
  Editor e;
  load(e);
  e.setMotion(on(0));
  CHECK(e.command(CommandId::MOTION_ADD_AUDIO, args(R"({"root":"1:3","mediaHash":"ab","durationUs":1000})")) == E_INVALID);  // not top-level
  CHECK(e.command(CommandId::MOTION_ADD_AUDIO, args(R"({"root":"1:1","mediaHash":"","durationUs":1000})")) == E_INVALID);
  CHECK(e.command(CommandId::MOTION_ADD_AUDIO, args(R"({"root":"1:1","mediaHash":"ab","durationUs":0})")) == E_INVALID);
  CHECK(clipsOf(e).empty());
  // Without `root`, the timeline's root.
  e.setSelection({kRect});
  REQUIRE(e.command(CommandId::MOTION_ADD_AUDIO, args(R"({"mediaHash":"ab","name":"x.wav","durationUs":1000})")) == OK);
  CHECK(clipsOf(e).size() == 1);
}

TEST_CASE("motion audio: Edit audio moves, trims, re-volumes and mutes a clip, and mutes its row; one step each") {
  Editor e;
  load(e);
  e.setMotion(on(0));
  REQUIRE(e.command(CommandId::MOTION_ADD_AUDIO, args(addAudio(0, 4000000))) == OK);
  std::string id = e.lastCreated()[0].toString();
  std::string row = rowsOf(e)[0].id.toString();
  REQUIRE(e.command(CommandId::MOTION_SET_AUDIO, args(R"({"root":"1:1","edits":[{"id":")" + id + R"(","offsetUs":500000,"startUs":1000000,"durationUs":2000000,"volume":1.7,"mute":true}]})")) == OK);
  CHECK(e.undoStack().undoLabel() == "Edit audio");
  motion::AudioClip c = clipsOf(e)[0];
  CHECK(c.offsetUs == 500000);
  CHECK(c.startUs == 1000000);
  CHECK(c.durationUs == 2000000);
  CHECK(c.volume == doctest::Approx(1));  // clamped to 0–1
  CHECK(c.mute);
  // The row's eye: its own mute, the clip's untouched.
  REQUIRE(e.command(CommandId::MOTION_SET_AUDIO, args(R"({"root":"1:1","tracks":[{"id":")" + row + R"(","mute":true,"gain":0.5}]})")) == OK);
  CHECK(rowsOf(e)[0].mute);
  CHECK(rowsOf(e)[0].gain == doctest::Approx(0.5));
  // Unknown clips and rows change nothing (no step).
  CHECK(e.command(CommandId::MOTION_SET_AUDIO, args(R"({"root":"1:1","edits":[{"id":"9:9","volume":0}]})")) == E_INVALID);
  REQUIRE(e.command(CommandId::UNDO) == OK);
  CHECK_FALSE(rowsOf(e)[0].mute);
  REQUIRE(e.command(CommandId::UNDO) == OK);
  CHECK(clipsOf(e)[0].offsetUs == 0);
  CHECK_FALSE(clipsOf(e)[0].mute);
}

TEST_CASE("motion audio: Split audio at the playhead makes two regions of the file; Delete audio takes a region, then its row") {
  Editor e;
  load(e);
  e.setMotion(on(0));
  REQUIRE(e.command(CommandId::MOTION_ADD_AUDIO, args(addAudio(1000000, 3000000))) == OK);
  Guid first = e.lastCreated()[0];
  REQUIRE(e.command(CommandId::MOTION_SET_AUDIO, args(R"({"root":"1:1","edits":[{"id":")" + first.toString() + R"(","startUs":200000,"volume":0.4}]})")) == OK);
  // Outside the clip, or on its edges: nothing to split.
  CHECK(e.command(CommandId::MOTION_SPLIT_AUDIO, args(R"({"root":"1:1","id":")" + first.toString() + R"(","atUs":1000000})")) == E_INVALID);
  CHECK(e.command(CommandId::MOTION_SPLIT_AUDIO, args(R"({"root":"1:1","id":")" + first.toString() + R"(","atUs":4500000})")) == E_INVALID);
  REQUIRE(e.command(CommandId::MOTION_SPLIT_AUDIO, args(R"({"root":"1:1","id":")" + first.toString() + R"(","atUs":2500000})")) == OK);
  CHECK(e.undoStack().undoLabel() == "Split audio");
  REQUIRE(e.lastCreated().size() == 1);
  std::vector<motion::AudioClip> clips = clipsOf(e);
  REQUIRE(clips.size() == 2);
  CHECK(clips[0].id == first);
  CHECK(clips[0].offsetUs == 1000000);
  CHECK(clips[0].durationUs == 1500000);
  CHECK(clips[1].id == e.lastCreated()[0]);
  CHECK(clips[1].offsetUs == 2500000);
  CHECK(clips[1].startUs == 1700000);  // the file plays on where the first region stopped
  CHECK(clips[1].durationUs == 1500000);
  CHECK(clips[1].volume == doctest::Approx(0.4));
  CHECK(clips[1].track == clips[0].track);
  CHECK(clips[1].mediaHash == kHash);
  // Delete the second region: the row stays for the first; delete that one too: the row goes.
  REQUIRE(e.command(CommandId::MOTION_REMOVE_AUDIO, args(R"({"root":"1:1","ids":[")" + clips[1].id.toString() + R"("]})")) == OK);
  CHECK(e.undoStack().undoLabel() == "Delete audio");
  CHECK(clipsOf(e).size() == 1);
  CHECK(rowsOf(e).size() == 1);
  REQUIRE(e.command(CommandId::MOTION_REMOVE_AUDIO, args(R"({"root":"1:1","ids":[")" + first.toString() + R"("]})")) == OK);
  CHECK(clipsOf(e).empty());
  CHECK(rowsOf(e).empty());
  CHECK(e.command(CommandId::MOTION_REMOVE_AUDIO, args(R"({"root":"1:1","ids":["1:2"]})")) == E_INVALID);
  REQUIRE(e.command(CommandId::UNDO) == OK);
  REQUIRE(e.command(CommandId::UNDO) == OK);
  REQUIRE(e.command(CommandId::UNDO) == OK);
  CHECK(clipsOf(e).size() == 1);
  CHECK(clipsOf(e)[0].durationUs == 3000000);
}

TEST_CASE("motion audio: the clips and rows survive loading the document again") {
  Editor e;
  load(e);
  e.setMotion(on(0));
  REQUIRE(e.command(CommandId::MOTION_ADD_AUDIO, args(addAudio(0, 1000000))) == OK);
  // The fields round-trip through the file's encoding (the kiwi Message).
  std::string bytes = codec::writeMessage(1, {NodeChange::created(kRoot, e.document().get(kRoot)->props)});
  codec::KiwiMessage back;
  REQUIRE(codec::readMessage(bytes, back));
  REQUIRE(back.changes.size() == 1);
  std::vector<motion::AudioClip> clips = motion::decodeAudioClips(back.changes[0].props);
  REQUIRE(clips.size() == 1);
  CHECK(clips[0].durationUs == 1000000);
  CHECK(clips[0].mediaHash == kHash);
  CHECK(clips[0].name == "Beat.mp3");
  REQUIRE(motion::decodeAudioRows(back.changes[0].props).size() == 1);
  CHECK(clips[0].track == motion::decodeAudioRows(back.changes[0].props)[0].id);
}
