// Opt-in: the prototype player on a real file's Message (OWNER_MSG=<raw kiwi Message bytes>), to look at what a
// transition draws frame by frame (docs/research/figma/live/2026-10-20/prototype-playback.txt "Whole-file audit").
// Skipped without OWNER_MSG. OWNER_STEPS: "click x y" / "move x y" / "tick ms" / "dump id,id,…" separated by ';'
// (frame coordinates, the window the frame's size).
#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <sstream>

#include "doctest.h"
#include "editor/Editor.h"
#include "proto/Player.h"
#include "scene/CodecKiwi.h"

using namespace eng;

TEST_CASE("proto.owner_file: a real file's transition, dumped (OWNER_MSG)") {
  const char* path = std::getenv("OWNER_MSG");
  if (!path) return;
  std::ifstream in(path, std::ios::binary);
  REQUIRE(in.good());
  std::stringstream ss;
  ss << in.rdbuf();
  std::string bytes = ss.str();
  codec::KiwiMessage m;
  REQUIRE(codec::readMessage(bytes, m));
  const char* pageEnv = std::getenv("OWNER_PAGE");
  const char* frameEnv = std::getenv("OWNER_FRAME");
  Guid page = Guid::parse(pageEnv ? pageEnv : "1:3531"), frame = Guid::parse(frameEnv ? frameEnv : "1:3894");
  Editor ed;
  ed.setSessionID(77);
  ed.loadDocument(std::move(m.changes), page);
  const NodeProps* fp = ed.document().has(frame) ? &ed.document().get(frame)->props : nullptr;
  REQUIRE(fp);
  ed.setViewport(fp->size.x, fp->size.y, 1, static_cast<int>(fp->size.x), static_cast<int>(fp->size.y));
  proto::Player player(ed);
  player.setScale(proto::ScaleMode::FIT);
  REQUIRE(player.start(page, frame));
  double t = 0;
  auto tick = [&](double ms) {
    while (ms > 0) {
      double s = std::min(16.0, ms);
      t += s;
      ms -= s;
      player.tick(t);
    }
  };
  tick(32);
  std::string steps = std::getenv("OWNER_STEPS") ? std::getenv("OWNER_STEPS") : "";
  std::stringstream st(steps);
  std::string step;
  while (std::getline(st, step, ';')) {
    std::stringstream w(step);
    std::string op;
    w >> op;
    if (op == "click" || op == "move") {
      double x, y;
      w >> x >> y;
      player.pointer(PointerEvent::MOVE, x, y, 0, 0);
      if (op == "click") {
        player.pointer(PointerEvent::DOWN, x, y, 1, 0);
        player.pointer(PointerEvent::UP, x, y, 0, 0);
      }
    } else if (op == "tick") {
      double ms;
      w >> ms;
      tick(ms);
    } else if (op == "tree") {
      std::string id;
      w >> id;
      Guid g = Guid::parse(id);
      const auto& d = ed.document();
      for (Guid c : d.children(g)) {
        const NodeProps& cp = d.get(c)->props;
        std::printf("tree %s child %s \"%s\" vis %d t(%.0f,%.0f) s(%.0f,%.0f) main %s\n", id.c_str(), c.toString().c_str(), cp.name.c_str(), cp.visible,
                    cp.transform.m02, cp.transform.m12, cp.size.x, cp.size.y, ed.mainOf(c).toString().c_str());
      }
    } else if (op == "dump") {
      std::string ids;
      w >> ids;
      const PresentScene& s = player.scene();
      std::printf("---- t=%.0f items %zu\n", t, s.items.size());
      for (size_t i = 0; i < s.items.size(); i++) {
        const PresentItem& it = s.items[i];
        std::printf("item %zu node %s css(%.0f,%.0f) ov %zu\n", i, it.node.toString().c_str(), it.parentCss.m02, it.parentCss.m12,
                    it.overrides ? it.overrides->size() : 0);
        if (!it.overrides) continue;
        std::stringstream is(ids);
        std::string id;
        while (std::getline(is, id, ',')) {
          Guid g = Guid::parse(id);
          auto o = it.overrides->find(g);
          if (o != it.overrides->end())
            std::printf("   %s vis %d op %.2f t(%.0f,%.0f) s(%.0f,%.0f)\n", id.c_str(), o->second.visible, o->second.opacity, o->second.transform.m02,
                        o->second.transform.m12, o->second.size.x, o->second.size.y);
        }
      }
    }
  }
}
