// Opt-in: the prototype player on a real file's Message (OWNER_MSG=<raw kiwi Message bytes>), to look at what a
// transition draws frame by frame (docs/research/figma/live/2026-10-20/prototype-playback.txt "Whole-file audit").
// Skipped without OWNER_MSG. OWNER_STEPS: "click x y" / "move x y" / "tick ms" / "dump id,id,…" separated by ';'
// (frame coordinates, the window the frame's size).
#include <algorithm>
#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <functional>
#include <unordered_map>
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
  if (pageEnv && std::string(pageEnv) == "auto") {
    // The page holding the frame: follow the parents in the Message.
    std::unordered_map<Guid, Guid, GuidHash> parent;
    std::unordered_map<Guid, NodeType, GuidHash> type;
    for (const NodeChange& c : m.changes) {
      parent[c.guid] = c.props.parentIndex.guid;
      type[c.guid] = c.props.type;
    }
    for (Guid cur = frame; cur != kNoGuid; cur = parent.count(cur) ? parent[cur] : kNoGuid)
      if (type[cur] == NodeType::CANVAS) {
        page = cur;
        break;
      }
    std::printf("page %s\n", page.toString().c_str());
  }
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
  // Derived ids ("I1:2;3:4") are written with '|' for ';' in the steps (';' separates them).
  auto pid = [](std::string id) {
    std::replace(id.begin(), id.end(), '|', ';');
    return Guid::parse(id);
  };
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
    } else if (op == "tap" || op == "tapname" || op == "hovername") {
      // A click at a layer's centre, in the shown frame's coordinates. `tapname <root> <name>`: the first layer named so
      // under root (a name with '_' for spaces); `hovername`: only moves there.
      std::string id;
      w >> id;
      Guid g = pid(id);
      if (op != "tap") {
        std::string name;
        w >> name;
        std::replace(name.begin(), name.end(), '_', ' ');
        Guid found = kNoGuid;
        std::function<void(Guid)> find = [&](Guid c) {
          if (found != kNoGuid) return;
          if (ed.document().get(c)->props.name == name && c != g) {
            found = c;
            return;
          }
          for (Guid k : ed.document().children(c)) find(k);
        };
        find(g);
        REQUIRE(found != kNoGuid);
        g = found;
      }
      const auto& d = ed.document();
      REQUIRE(d.has(g));
      Mat2x3 m = d.worldTransform(g), s = d.worldTransform(player.screen());
      const NodeProps& gp = d.get(g)->props;
      double x = m.m02 + gp.size.x / 2 - s.m02, y = m.m12 + gp.size.y / 2 - s.m12;
      std::printf("%s %s \"%s\" at %.0f,%.0f\n", op.c_str(), g.toString().c_str(), gp.name.c_str(), x, y);
      player.pointer(PointerEvent::MOVE, x, y, 0, 0);
      tick(300);
      if (op == "hovername") continue;
      player.pointer(PointerEvent::DOWN, x, y, 1, 0);
      player.pointer(PointerEvent::UP, x, y, 0, 0);
    } else if (op == "down" || op == "up") {
      double x, y;
      w >> x >> y;
      player.pointer(op == "down" ? PointerEvent::DOWN : PointerEvent::UP, x, y, op == "down" ? 1 : 0, 0);
    } else if (op == "state") {
      std::printf("state t=%.0f screen %s overlays %zu animating %d\n", t, player.screen().toString().c_str(), player.overlays().size(), player.animating());
    } else if (op == "tick") {
      double ms;
      w >> ms;
      tick(ms);
    } else if (op == "tree") {
      std::string id;
      w >> id;
      Guid g = pid(id);
      const auto& d = ed.document();
      for (Guid c : d.children(g)) {
        const NodeProps& cp = d.get(c)->props;
        std::printf("tree %s child %s \"%s\" vis %d t(%.0f,%.0f) s(%.0f,%.0f) main %s al %d rz %d abs %d\n", id.c_str(), c.toString().c_str(), cp.name.c_str(),
                    cp.visible, cp.transform.m02, cp.transform.m12, cp.size.x, cp.size.y, ed.mainOf(c).toString().c_str(), cp.isAutoLayout(),
                    cp.stack().stackReverseZIndex, cp.stackPositioning == StackPositioning::ABSOLUTE);
      }
    } else if (op == "ix") {
      // A subtree with every layer's interactions (what each plays) and every instance's main: `ix <id> <depth>`.
      std::string id;
      int depth = 3;
      w >> id >> depth;
      const auto& d = ed.document();
      std::function<void(Guid, int)> walk = [&](Guid g, int level) {
        const NodeProps& gp = d.get(g)->props;
        Guid main = gp.type == NodeType::INSTANCE ? ed.mainOf(g) : kNoGuid;
        std::string mainName = main != kNoGuid ? d.get(main)->props.name : "";
        auto list = ed.playedInteractions(g);
        if (gp.type == NodeType::INSTANCE || !list.empty())
          std::printf("%*s%s \"%s\" %s%s\n", level * 2, "", g.toString().c_str(), gp.name.c_str(), main != kNoGuid ? "= " : "", mainName.c_str());
        for (const auto& i : list)
          for (const auto& a : i.actions)
            std::printf("%*s  [%s] %s %s → %s \"%s\" %s %.2fs\n", level * 2, "", proto::triggerName(i.trigger), proto::connectionName(a.connection),
                        proto::navigationName(a.navigation), a.dest.toString().c_str(), d.has(a.dest) ? d.get(a.dest)->props.name.c_str() : "",
                        proto::transitionName(a.transition), a.duration);
        if (level < depth)
          for (Guid c : d.children(g)) walk(c, level + 1);
      };
      walk(pid(id), 0);
    } else if (op == "mains") {
      // Every instance under `id` with the variant it shows now (state dumps before / after).
      std::string id;
      w >> id;
      const auto& d = ed.document();
      std::function<void(Guid, int)> walk = [&](Guid g, int level) {
        const NodeProps& gp = d.get(g)->props;
        if (gp.type == NodeType::INSTANCE) {
          Guid main = ed.mainOf(g);
          std::printf("mains %*s\"%s\" = %s\n", level * 2, "", gp.name.c_str(), main != kNoGuid ? d.get(main)->props.name.c_str() : "?");
        }
        for (Guid c : d.children(g)) walk(c, level + 1);
      };
      walk(pid(id), 0);
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
          Guid g = pid(id);
          auto o = it.overrides->find(g);
          if (o != it.overrides->end())
            std::printf("   %s vis %d op %.2f t(%.0f,%.0f) s(%.0f,%.0f)\n", id.c_str(), o->second.visible, o->second.opacity, o->second.transform.m02,
                        o->second.transform.m12, o->second.size.x, o->second.size.y);
        }
      }
    }
  }
}
