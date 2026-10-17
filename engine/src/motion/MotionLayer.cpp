#include "motion/MotionLayer.h"

#include <algorithm>
#include <cmath>

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
    default: return 0;  // PATH_TRIM_*, GRID gaps (extra fields): the next increment
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

size_t MotionLayer::apply(Document& doc, const MotionIndex& index, Guid root, int64_t timeUs, const BaseResolver& resolve) {
  if (!doc.has(root)) return 0;
  Timeline tl = index.timeline(doc, root);
  int64_t tau = localTime(timeUs - tl.offsetUs, tl.durationUs, tl.playback);
  auto tracks = [&](Guid id) { return index.track(id); };
  size_t written = 0;
  for (Guid id : index.animatedUnder(doc, root)) {
    const AnimatedNode* an = index.node(id);
    if (!an || !doc.has(id)) continue;
    Entry& entry = remember(doc, id);
    // Start from the base every time: the values are a function of (document, time), never of the last frame.
    NodeProps p = entry.base;
    FieldMask mask = 0;
    // The motion transform's components, folded from their bases (motionTransform; the expression's own literal base
    // wins when it has one).
    bool motion = false;
    Vec2 translation = an->base.translation, scale = an->base.scale;
    double rotation = an->base.rotation, shear = an->base.shear;
    LayerBase anchor = an->base;
    for (const Binding& b : an->bindings) {
      KeyframeValue base;
      bool haveBase = false;
      if (b.base.kind == VariableData::Kind::FLOAT) {
        base = KeyframeValue::number(b.base.floatValue);
        haveBase = true;
      } else if (b.base.kind == VariableData::Kind::COLOR) {
        base = KeyframeValue::color(b.base.colorValue);
        haveBase = true;
      } else if (b.base.present() && resolve) {
        haveBase = resolve(id, b.base, base);
      }
      if (b.slot.kind == Slot::Kind::NODE) {
        const FieldInfo* info = fieldInfo(b.slot.field);
        if (!info) continue;
        if (isMotionTransformField(b.slot.field)) {
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
          if (!foldValue(base, b.params, tau, tracks, v)) continue;
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
        if (!foldValue(base, b.params, tau, tracks, v)) continue;
        FieldMask m = maskOf(b.slot.field);
        if (!m) continue;
        if (writeNodeFloat(p, b.slot.field, storedToNode(*info, v.f))) mask |= m;
      } else if (b.slot.kind == Slot::Kind::FILL_COLOR || b.slot.kind == Slot::Kind::STROKE_COLOR || b.slot.kind == Slot::Kind::FILL_OPACITY ||
                 b.slot.kind == Slot::Kind::STROKE_OPACITY) {
        bool fill = b.slot.kind == Slot::Kind::FILL_COLOR || b.slot.kind == Slot::Kind::FILL_OPACITY;
        std::vector<Paint>& list = fill ? p.fillPaints : p.strokePaints;
        if (b.slot.index >= list.size()) continue;
        Paint& pt = list[b.slot.index];
        bool color = b.slot.kind == Slot::Kind::FILL_COLOR || b.slot.kind == Slot::Kind::STROKE_COLOR;
        if (!haveBase) base = color ? KeyframeValue::color(pt.color) : KeyframeValue::number(pt.opacity);
        KeyframeValue v;
        if (!foldValue(base, b.params, tau, tracks, v)) continue;
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
        if (!foldValue(base, b.params, tau, tracks, v)) continue;
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
    if (motion) {
      p.transform = motionTransform(entry.base.transform, entry.base.size, anchor, translation, rotation, scale, shear);
      mask |= F_TRANSFORM;
    }
    entry.mask |= mask;
    if (!entry.mask) continue;
    NodeChange c = NodeChange::changed(id);
    c.mask = entry.mask;
    c.props = std::move(p);
    if (doc.apply(c)) written++;
  }
  return written;
}

void MotionLayer::restore(Document& doc) {
  for (auto& [id, e] : entries_) {
    if (!e.mask || !doc.has(id)) continue;
    NodeChange c = NodeChange::changed(id);
    c.mask = e.mask;
    c.props = e.base;
    doc.apply(c);
  }
  entries_.clear();
}

}  // namespace eng::motion
