#include "motion/MotionLayer.h"

#include <algorithm>
#include <cmath>

#include "text/TextLayout.h"

namespace eng::motion {

namespace {

FieldMask maskOf(VariableField f) {
  switch (f) {
    case VariableField::OPACITY: return F_OPACITY;
    case VariableField::CORNER_RADIUS:
    case VariableField::RECTANGLE_TOP_LEFT_CORNER_RADIUS:
    case VariableField::RECTANGLE_TOP_RIGHT_CORNER_RADIUS:
    case VariableField::RECTANGLE_BOTTOM_LEFT_CORNER_RADIUS:
    case VariableField::RECTANGLE_BOTTOM_RIGHT_CORNER_RADIUS: return F_CORNER_RADII;
    case VariableField::STROKE_WEIGHT: return F_STROKE_WEIGHT;
    case VariableField::BORDER_TOP_WEIGHT:
    case VariableField::BORDER_BOTTOM_WEIGHT:
    case VariableField::BORDER_LEFT_WEIGHT:
    case VariableField::BORDER_RIGHT_WEIGHT: return F_BORDER_WEIGHTS;
    case VariableField::STACK_SPACING: return F_STACK_SPACING;
    case VariableField::STACK_COUNTER_SPACING: return F_STACK_COUNTER_SPACING;
    case VariableField::STACK_PADDING_LEFT: return F_STACK_PADDING_LEFT;
    case VariableField::STACK_PADDING_TOP: return F_STACK_PADDING_TOP;
    case VariableField::STACK_PADDING_RIGHT: return F_STACK_PADDING_RIGHT;
    case VariableField::STACK_PADDING_BOTTOM: return F_STACK_PADDING_BOTTOM;
    case VariableField::WIDTH:
    case VariableField::HEIGHT: return F_SIZE;
    case VariableField::ARC_DATA_STARTING_ANGLE:
    case VariableField::ARC_DATA_ENDING_ANGLE:
    case VariableField::ARC_DATA_INNER_RADIUS: return F_ARC_DATA;
    case VariableField::STAR_INNER_SCALE: return F_STAR_INNER_SCALE;
    case VariableField::POLYGON_COUNT: return F_COUNT;
    // Kept in `extra` (Fields.cpp): path trim (the stroke trimmed by NodeGeometry, docs/motion.md §4.13), grid gaps.
    case VariableField::PATH_TRIM_START:
    case VariableField::PATH_TRIM_END:
    case VariableField::GRID_ROW_GAP:
    case VariableField::GRID_COLUMN_GAP: return F_EXTRA;
    default: return 0;
  }
}

double resolvePercent(const Number& n, double size) {
  switch (n.units) {
    case NumberUnits::PERCENT: return size * n.value / 100;
    default: return n.value;
  }
}

}  // namespace

Vec2 MotionLayer::anchorPoint(const LayerBase& b, Vec2 size) { return {resolvePercent(b.originX, size.x), resolvePercent(b.originY, size.y)}; }

Mat2x3 MotionLayer::motionTransform(const Mat2x3& layout, Vec2 size, const LayerBase& anchor, Vec2 translation, double rotationStored,
                                    Vec2 scale, double shear) {
  Vec2 o = anchorPoint(anchor, size);
  // The stored rotation is already −radians (Figma's positive rotation is counter-clockwise on a y-down canvas), so
  // Mat2x3::rotate(stored) is R(−r).
  Mat2x3 R = Mat2x3::rotate(rotationStored);
  Mat2x3 Sh{1, shear, 0, 0, 1, 0};
  Mat2x3 S{scale.x, 0, 0, 0, scale.y, 0};
  return layout * Mat2x3::translate(o.x, o.y) * Mat2x3::translate(translation.x, translation.y) * R * Sh * S * Mat2x3::translate(-o.x, -o.y);
}

LayerBase MotionLayer::poseAt(const MotionIndex& index, const AnimatedNode& an, int64_t tau) {
  LayerBase pose = an.base;
  auto tracks = [&](Guid id) { return index.track(id); };
  for (const Binding& b : an.bindings) {
    if (b.slot.kind != Slot::Kind::NODE || !isMotionTransformField(b.slot.field)) continue;
    KeyframeValue base;
    switch (b.slot.field) {
      case VariableField::MOTION_TRANSLATION_X: base = KeyframeValue::number(pose.translation.x); break;
      case VariableField::MOTION_TRANSLATION_Y: base = KeyframeValue::number(pose.translation.y); break;
      case VariableField::MOTION_TRANSLATION_XY: base = KeyframeValue::vector(pose.translation); break;
      case VariableField::MOTION_ROTATION: base = KeyframeValue::number(pose.rotation); break;
      case VariableField::MOTION_SCALE_X: base = KeyframeValue::number(pose.scale.x); break;
      case VariableField::MOTION_SCALE_Y: base = KeyframeValue::number(pose.scale.y); break;
      case VariableField::MOTION_SCALE_XY: base = KeyframeValue::vector(pose.scale); break;
      case VariableField::MOTION_SHEAR: base = KeyframeValue::number(pose.shear); break;
      case VariableField::MOTION_TRANSFORM_ORIGIN_X: base = KeyframeValue::number(pose.originX.value); break;
      case VariableField::MOTION_TRANSFORM_ORIGIN_Y: base = KeyframeValue::number(pose.originY.value); break;
      case VariableField::MOTION_TRANSFORM_ORIGIN_XY: base = KeyframeValue::vector({pose.originX.value, pose.originY.value}); break;
      default: break;
    }
    const FieldInfo* info = fieldInfo(b.slot.field);
    if (b.base.kind == VariableData::Kind::FLOAT && !(info && info->value == ValueKind::VECTOR)) base = KeyframeValue::number(b.base.floatValue);
    KeyframeValue v;
    if (!foldValue(base, b.params, tau, tracks, v)) continue;
    Vec2 xy = v.kind == ValueKind::VECTOR ? v.v : Vec2{v.f, v.f};
    switch (b.slot.field) {
      case VariableField::MOTION_TRANSLATION_X: pose.translation.x = v.f; break;
      case VariableField::MOTION_TRANSLATION_Y: pose.translation.y = v.f; break;
      case VariableField::MOTION_TRANSLATION_XY: pose.translation = xy; break;
      case VariableField::MOTION_ROTATION: pose.rotation = v.f; break;
      case VariableField::MOTION_SCALE_X: pose.scale.x = v.f; break;
      case VariableField::MOTION_SCALE_Y: pose.scale.y = v.f; break;
      case VariableField::MOTION_SCALE_XY: pose.scale = xy; break;
      case VariableField::MOTION_SHEAR: pose.shear = v.f; break;
      case VariableField::MOTION_TRANSFORM_ORIGIN_X: pose.originX.value = v.f; break;
      case VariableField::MOTION_TRANSFORM_ORIGIN_Y: pose.originY.value = v.f; break;
      case VariableField::MOTION_TRANSFORM_ORIGIN_XY:
        pose.originX.value = xy.x;
        pose.originY.value = xy.y;
        break;
      default: break;
    }
  }
  return pose;
}

MotionLayer::Entry& MotionLayer::remember(const Document& doc, Guid id) {
  auto it = entries_.find(id);
  if (it != entries_.end()) return it->second;
  Entry e;
  e.base = doc.get(id)->props;
  return entries_.emplace(id, std::move(e)).first->second;
}

const NodeProps* MotionLayer::baseOf(Guid id) const {
  auto it = entries_.find(id);
  return it == entries_.end() ? nullptr : &it->second.base;
}

bool MotionLayer::instanceTime(const Document& doc, const MotionIndex& index, Guid instance, Guid main, Guid containing, int64_t tau,
                               int64_t& out) {
  const Node* n = doc.get(instance);
  if (!n) return false;
  Assignment a = decodeAssignment(n->props, main, containing);
  if (a.disabled) return false;
  Timeline tl = index.timeline(doc, main);
  if (tl.disabled) return false;
  out = localTime(tau - a.offsetUs, tl.durationUs, tl.playback);
  return true;
}

size_t MotionLayer::apply(Document& doc, const MotionIndex& index, Guid root, int64_t timeUs, const Hooks& hooks) {
  // The values are a function of (document, time), never of the last frame: start from the base values.
  restore(doc);
  if (!doc.has(root)) return 0;
  Timeline tl = index.timeline(doc, root);
  auto tracks = [&](Guid id) { return index.track(id); };
  auto mainOf = [&](Guid id) {
    if (hooks.mainOf) return hooks.mainOf(id);
    const Node* n = doc.get(id);
    return n ? n->props.comp().symbolData.symbolID : kNoGuid;
  };

  // 1. What plays, and at which local time (docs/motion.md §4.3, §4.4): the root's layers in its time; an instance whose
  // main plays, its sublayers in its main's — offset by its assignment in the timeline it sits in, under the main's
  // playback style (nested instances compose).
  struct Work {
    Guid id;
    const AnimatedNode* an;
    int64_t tau;
  };
  std::vector<Work> work;
  auto visit = [&](auto&& self, Guid parent, Guid containing, int64_t tau) -> void {
    for (Guid c : doc.children(parent)) {
      const Node* n = doc.get(c);
      if (!n) continue;
      Guid layer = c;
      if (c.isDerived()) layer = hooks.sourceOf ? hooks.sourceOf(c) : kNoGuid;
      if (const AnimatedNode* an = layer != kNoGuid ? index.node(layer) : nullptr) work.push_back({c, an, tau});
      if (n->props.type != NodeType::INSTANCE) {
        self(self, c, containing, tau);
        continue;
      }
      // An instance: its sublayers are its main's layers; they play only when the main does.
      Guid main = mainOf(c);
      int64_t inner = 0;
      if (main != kNoGuid && index.plays(main) && instanceTime(doc, index, c, main, containing, tau, inner)) self(self, c, main, inner);
    }
  };
  int64_t tau = localTime(timeUs - tl.offsetUs, tl.durationUs, tl.playback);
  Guid rootMain = doc.get(root)->props.type == NodeType::INSTANCE ? mainOf(root) : kNoGuid;
  if (rootMain != kNoGuid && index.plays(rootMain)) {
    // A top-level instance of an animated component is a root that plays its main.
    int64_t inner = 0;
    if (instanceTime(doc, index, root, rootMain, root, tau, inner)) visit(visit, root, rootMain, inner);
  } else {
    visit(visit, root, root, tau);
  }

  // 2. Each layer's fields over its base; the motion transform's components kept for step 4.
  struct Pose {
    Guid id;
    LayerBase anchor;
    Vec2 translation, scale;
    double rotation, shear;
  };
  std::vector<Pose> poses;
  std::vector<Guid> laidOut;  // layers whose layout inputs changed
  // A text preset's parameters (round 8h): played per element in step 5, not by the text itself.
  struct Staggered {
    Guid id, layer;
    int64_t tau;
    std::vector<std::pair<VariableField, std::vector<Param>>> fields;
  };
  std::vector<Staggered> staggered;
  size_t written = 0;
  for (const Work& w : work) {
    const AnimatedNode* an = w.an;
    Entry& entry = remember(doc, w.id);
    NodeProps p = entry.base;
    FieldMask mask = 0;
    bool layout = false;
    // The motion transform's components, folded from their bases (motionTransform; the expression's own literal base
    // wins when it has one).
    bool motion = false;
    Vec2 translation = an->base.translation, scale = an->base.scale;
    double rotation = an->base.rotation, shear = an->base.shear;
    LayerBase anchor = an->base;
    bool text = entry.base.type == NodeType::TEXT && hooks.textLayout;
    for (const Binding& b : an->bindings) {
      // On a text, its staggered presets' parameters go to step 5; the rest fold here.
      std::vector<Param> own;
      const std::vector<Param>* params = &b.params;
      if (text && std::any_of(b.params.begin(), b.params.end(), [](const Param& q) { return q.staggered; })) {
        std::vector<Param> per;
        for (const Param& q : b.params) (q.staggered ? per : own).push_back(q);
        params = &own;
        if (b.slot.kind == Slot::Kind::NODE && (b.slot.field == VariableField::OPACITY || isMotionTransformField(b.slot.field))) {
          if (staggered.empty() || staggered.back().id != w.id) staggered.push_back({w.id, an->id, w.tau, {}});
          staggered.back().fields.push_back({b.slot.field, std::move(per)});
        }
      }
      KeyframeValue base;
      bool haveBase = false;
      if (b.base.kind == VariableData::Kind::FLOAT) {
        base = KeyframeValue::number(b.base.floatValue);
        haveBase = true;
      } else if (b.base.kind == VariableData::Kind::COLOR) {
        base = KeyframeValue::color(b.base.colorValue);
        haveBase = true;
      } else if (b.base.present() && hooks.resolve) {
        haveBase = hooks.resolve(w.id, b.base, base);
      }
      if (b.slot.kind == Slot::Kind::NODE) {
        const FieldInfo* info = fieldInfo(b.slot.field);
        if (!info) continue;
        if (isMotionTransformField(b.slot.field)) {
          // An XY field's literal argument is a placeholder (the schema has no VECTOR literal): its base is the
          // layer's motionTransform, which a preset's OFFSET track then moves (round 8h).
          if (info->value == ValueKind::VECTOR && b.base.kind == VariableData::Kind::FLOAT) haveBase = false;
          if (!haveBase) {
            switch (b.slot.field) {
              case VariableField::MOTION_TRANSLATION_X: base = KeyframeValue::number(an->base.translation.x); break;
              case VariableField::MOTION_TRANSLATION_Y: base = KeyframeValue::number(an->base.translation.y); break;
              case VariableField::MOTION_TRANSLATION_XY: base = KeyframeValue::vector(an->base.translation); break;
              case VariableField::MOTION_ROTATION: base = KeyframeValue::number(an->base.rotation); break;
              case VariableField::MOTION_SCALE_X: base = KeyframeValue::number(an->base.scale.x); break;
              case VariableField::MOTION_SCALE_Y: base = KeyframeValue::number(an->base.scale.y); break;
              case VariableField::MOTION_SCALE_XY: base = KeyframeValue::vector(an->base.scale); break;
              case VariableField::MOTION_SHEAR: base = KeyframeValue::number(an->base.shear); break;
              case VariableField::MOTION_TRANSFORM_ORIGIN_X: base = KeyframeValue::number(an->base.originX.value); break;
              case VariableField::MOTION_TRANSFORM_ORIGIN_Y: base = KeyframeValue::number(an->base.originY.value); break;
              case VariableField::MOTION_TRANSFORM_ORIGIN_XY: base = KeyframeValue::vector({an->base.originX.value, an->base.originY.value}); break;
              default: break;
            }
          }
          KeyframeValue v;
          if (!foldValue(base, *params, w.tau, tracks, v)) continue;
          motion = true;
          // A FLOAT on an XY track is uniform (SCALE_XY's FLOAT input, docs/motion.md §4.5).
          auto vec = [&](Vec2) { return v.kind == ValueKind::VECTOR ? v.v : Vec2{v.f, v.f}; };
          switch (b.slot.field) {
            case VariableField::MOTION_TRANSLATION_X: translation.x = v.f; break;
            case VariableField::MOTION_TRANSLATION_Y: translation.y = v.f; break;
            case VariableField::MOTION_TRANSLATION_XY: translation = vec(translation); break;
            case VariableField::MOTION_ROTATION: rotation = v.f; break;
            case VariableField::MOTION_SCALE_X: scale.x = v.f; break;
            case VariableField::MOTION_SCALE_Y: scale.y = v.f; break;
            case VariableField::MOTION_SCALE_XY: scale = vec(scale); break;
            case VariableField::MOTION_SHEAR: shear = v.f; break;
            case VariableField::MOTION_TRANSFORM_ORIGIN_X: anchor.originX.value = v.f; break;
            case VariableField::MOTION_TRANSFORM_ORIGIN_Y: anchor.originY.value = v.f; break;
            case VariableField::MOTION_TRANSFORM_ORIGIN_XY:
              anchor.originX.value = vec({anchor.originX.value, anchor.originY.value}).x;
              anchor.originY.value = vec({anchor.originX.value, anchor.originY.value}).y;
              break;
            default: break;
          }
          continue;
        }
        if (!haveBase) {
          double cur = 0;
          if (!readNodeFloat(entry.base, b.slot.field, cur)) continue;
          base = KeyframeValue::number(nodeToStored(*info, cur));
        }
        KeyframeValue v;
        if (!foldValue(base, *params, w.tau, tracks, v)) continue;
        FieldMask m = maskOf(b.slot.field);
        if (!m) continue;
        if (writeNodeFloat(p, b.slot.field, storedToNode(*info, v.f))) {
          mask |= m;
          layout |= info->layout;
        }
      } else if (b.slot.kind == Slot::Kind::FILL_COLOR || b.slot.kind == Slot::Kind::STROKE_COLOR || b.slot.kind == Slot::Kind::FILL_OPACITY ||
                 b.slot.kind == Slot::Kind::STROKE_OPACITY) {
        bool fill = b.slot.kind == Slot::Kind::FILL_COLOR || b.slot.kind == Slot::Kind::FILL_OPACITY;
        std::vector<Paint>& list = fill ? p.fillPaints : p.strokePaints;
        if (b.slot.index >= list.size()) continue;
        Paint& pt = list[b.slot.index];
        bool color = b.slot.kind == Slot::Kind::FILL_COLOR || b.slot.kind == Slot::Kind::STROKE_COLOR;
        if (!haveBase) base = color ? KeyframeValue::color(pt.color) : KeyframeValue::number(pt.opacity);
        KeyframeValue v;
        if (!foldValue(base, *params, w.tau, tracks, v)) continue;
        if (color) {
          if (v.kind != ValueKind::COLOR) continue;
          pt.color = v.c;
        } else {
          pt.opacity = static_cast<float>(std::clamp(v.f, 0.0, 1.0));  // [unverified: stored 0–1]
        }
        mask |= fill ? F_FILLS : F_STROKES;
      } else if (b.slot.kind == Slot::Kind::EFFECT) {
        if (b.slot.index >= p.effects.size()) continue;
        Effect& e = p.effects[b.slot.index];
        if (!haveBase) {
          switch (b.slot.effect) {
            case Slot::EffectField::RADIUS: base = KeyframeValue::number(e.radius); break;
            case Slot::EffectField::SPREAD: base = KeyframeValue::number(e.spread); break;
            case Slot::EffectField::OFFSET_X: base = KeyframeValue::number(e.offset.x); break;
            case Slot::EffectField::OFFSET_Y: base = KeyframeValue::number(e.offset.y); break;
            case Slot::EffectField::COLOR: base = KeyframeValue::color(e.color); break;
          }
        }
        KeyframeValue v;
        if (!foldValue(base, *params, w.tau, tracks, v)) continue;
        switch (b.slot.effect) {
          case Slot::EffectField::RADIUS: e.radius = std::max(0.0, v.f); break;
          case Slot::EffectField::SPREAD: e.spread = std::clamp(v.f, -30000.0, 30000.0); break;
          case Slot::EffectField::OFFSET_X: e.offset.x = v.f; break;
          case Slot::EffectField::OFFSET_Y: e.offset.y = v.f; break;
          case Slot::EffectField::COLOR:
            if (v.kind == ValueKind::COLOR) e.color = v.c;
            break;
        }
        mask |= F_EFFECTS;
      }
    }
    if (motion) poses.push_back({w.id, anchor, translation, scale, rotation, shear});
    if (layout) laidOut.push_back(w.id);
    entry.mask |= mask;
    if (!mask) continue;
    NodeChange c = NodeChange::changed(w.id);
    c.mask = mask;
    c.props = std::move(p);
    if (doc.apply(c)) written++;
  }

  // 3. Layout (docs/motion.md §4.5): a size, padding or gap at its value moves the siblings and children as in Figma —
  // the layer and the auto-layout frame or group it sits in are laid out again, as previews.
  if (!laidOut.empty() && hooks.relayout) {
    std::vector<Guid> dirty;
    for (Guid id : laidOut) {
      dirty.push_back(id);
      Guid parent = doc.parentOf(id);
      const Node* pn = doc.get(parent);
      if (pn && (pn->props.isAutoLayout() || pn->props.fitsChildren())) dirty.push_back(parent);
    }
    hooks.relayout(dirty);
  }

  // 4. The motion transforms, over where layout left each layer (visual only: nothing lays out after them).
  for (const Pose& q : poses) {
    const Node* n = doc.get(q.id);
    if (!n) continue;
    Entry& entry = remember(doc, q.id);
    NodeChange c = NodeChange::changed(q.id);
    c.mask = F_TRANSFORM;
    c.props = n->props;
    c.props.transform = motionTransform(n->props.transform, n->props.size, q.anchor, q.translation, q.rotation, q.scale, q.shear);
    entry.mask |= F_TRANSFORM;
    if (doc.apply(c)) written++;
  }

  // 5. Text stagger (docs/motion.md §4.10; round 8h): each element of a text plays its staggered tracks its rank × the
  // step later — moved, turned and scaled about its own box's centre over identity bases, faded by its own opacity —
  // as poses the renderer draws its glyphs with; the text's own box stays. Its props are written again as they are, so
  // the canvas draws it again where its elements reach (its ink grows by them, Renderer's text ink).
  for (const Staggered& st : staggered) {
    const text::TextLayout* L = hooks.textLayout(st.id);
    // A text preset's clip's own stagger, else the text's own (MOTION_SET_TEXT_STAGGER, round 8i).
    const Stagger* sg = nullptr;
    for (const auto& f : st.fields)
      for (const Param& q : f.second)
        if (const Preset* pr = sg ? nullptr : index.preset(q.preset)) sg = &pr->stagger;
    if (const AnimatedNode* own = sg ? nullptr : index.node(st.layer); own && own->stagger.enabled) sg = &own->stagger;
    if (!L || !sg) continue;
    TextElements els = groupElements(*L, sg->grouping);
    std::vector<uint32_t> ranks = staggerRanks(els.boxes.size(), sg->order, st.layer);
    TextElementPoses out;
    out.elementOf = els.elementOf;
    out.transform.resize(els.boxes.size());
    out.alpha.resize(els.boxes.size(), 1);
    bool reached = false;
    for (size_t e = 0; e < els.boxes.size(); e++) {
      int64_t tauE = st.tau - static_cast<int64_t>(ranks[e]) * sg->stepUs;
      Vec2 t{0, 0}, sc{1, 1};
      double r = 0, op = 1;
      for (const auto& [field, params] : st.fields) {
        bool vector = field == VariableField::MOTION_TRANSLATION_XY || field == VariableField::MOTION_SCALE_XY;
        bool scaling = field == VariableField::MOTION_SCALE_X || field == VariableField::MOTION_SCALE_Y || field == VariableField::MOTION_SCALE_XY;
        KeyframeValue base = field == VariableField::OPACITY ? KeyframeValue::number(100)
                             : vector                        ? KeyframeValue::vector(scaling ? Vec2{1, 1} : Vec2{0, 0})
                                                             : KeyframeValue::number(scaling ? 1 : 0);
        KeyframeValue v;
        if (!foldValue(base, params, tauE, tracks, v)) continue;
        Vec2 xy = v.kind == ValueKind::VECTOR ? v.v : Vec2{v.f, v.f};
        switch (field) {
          case VariableField::OPACITY: op = std::clamp(v.f / 100, 0.0, 1.0); break;
          case VariableField::MOTION_TRANSLATION_X: t.x = v.f; break;
          case VariableField::MOTION_TRANSLATION_Y: t.y = v.f; break;
          case VariableField::MOTION_TRANSLATION_XY: t = xy; break;
          case VariableField::MOTION_ROTATION: r = v.f; break;
          case VariableField::MOTION_SCALE_X: sc.x = v.f; break;
          case VariableField::MOTION_SCALE_Y: sc.y = v.f; break;
          case VariableField::MOTION_SCALE_XY: sc = xy; break;
          default: break;
        }
      }
      const Rect& box = els.boxes[e];
      Vec2 c{box.x + box.w / 2, box.y + box.h / 2};
      Mat2x3 m = Mat2x3::translate(c.x + t.x, c.y + t.y) * Mat2x3::rotate(r) * Mat2x3{sc.x, 0, 0, 0, sc.y, 0} * Mat2x3::translate(-c.x, -c.y);
      out.transform[e] = m;
      out.alpha[e] = static_cast<float>(op);
      Vec2 corners[4] = {m.apply({box.x, box.y}), m.apply({box.right(), box.y}), m.apply({box.x, box.bottom()}), m.apply({box.right(), box.bottom()})};
      for (Vec2 q : corners) {
        Rect pt{q.x, q.y, 0, 0};
        out.reach = reached ? out.reach.united(pt) : pt;
        reached = true;
      }
    }
    texts_[st.id] = std::move(out);
    const Node* n = doc.get(st.id);
    if (!n) continue;
    Entry& entry = remember(doc, st.id);
    NodeChange c = NodeChange::changed(st.id);
    c.mask = F_OPACITY;
    c.props = n->props;
    entry.mask |= F_OPACITY;
    if (doc.apply(c)) written++;
  }
  return written;
}

bool MotionLayer::preview(Document& doc, const NodeChange& c) {
  if (!c.mask || !doc.has(c.guid)) return false;
  Entry& entry = remember(doc, c.guid);
  entry.mask |= c.mask;
  return doc.apply(c);
}

void MotionLayer::restore(Document& doc) {
  texts_.clear();
  for (auto& [id, e] : entries_) {
    if (!e.mask || !doc.has(id)) continue;
    NodeChange c = NodeChange::changed(id);
    c.mask = e.mask;
    c.props = e.base;
    if (e.mask & F_EXTRA)
      // Unmodelled fields merge (Document::apply): a key the layer added (a pathTrim the base hasn't) goes as empty.
      for (const auto& [key, value] : doc.get(id)->props.extra)
        if (!e.base.extra.count(key)) c.props.extra[key] = std::string();
    doc.apply(c);
  }
  entries_.clear();
}

}  // namespace eng::motion
