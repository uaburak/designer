import type { DefaultSkill } from "./types";

export const TURKISH_MICROCOPY: DefaultSkill = {
  name: "turkish-microcopy",
  description:
    "Write clear, natural Turkish UI copy (Türkçe arayüz metni): buttons, labels, errors, empty states, toasts, confirmations, onboarding — sentence case with Turkish casing rules, a consistent siz/sen choice, length limits, no translationese. Use for any Turkish text in a design, for translating UI into Turkish, or reviewing Turkish copy.",
  instructions: `Write Turkish that a Turkish product team would ship, not a translation of English.

## 1. Voice
- Pick one address and keep it on every screen: "siz" (most products, banking, B2B) or "sen" (young consumer brands) — ask the owner or follow the file's existing copy. Never mix in one flow.
- Short, active, concrete. Prefer verbs: "Kaydet", "Gönder", "Devam et". Drop filler ("Lütfen" only where it softens a demand; not on every button).
- Avoid translationese: "Başarıyla kaydedildi" → "Kaydedildi"; "Bir hata meydana geldi" → "Bir sorun oluştu"; "… yapmak için tıklayın" → put the action on the button; "kullanıcı" when you can say "siz".

## 2. Casing and spelling
- Sentence case everywhere (buttons, titles, menu items): "Yeni dosya oluştur", not "Yeni Dosya Oluştur". Proper nouns keep capitals.
- Turkish I: i ↔ İ, ı ↔ I. All-caps labels must uppercase with Turkish rules ("İNDİR", not "INDIR"): if you use textCase UPPER on a text layer, make sure the layer's language is Turkish, or type the capitals yourself.
- Apostrophe before suffixes on proper nouns and numbers: "Wecra'ya", "İstanbul'da", "3'te", "2026'da". Suffix vowel harmony after numbers and abbreviations follows pronunciation: "PDF'i", "1'i", "5'e", "%10'u".
- Dates and numbers: "21 Ekim 2026", "21.10.2026"; times "14:30"; decimals with comma, thousands with dot: "1.250,50 ₺" (currency sign after the number with a space, or "₺1.250,50" if the brand does so — be consistent). Percent before the number: "%20".
- "de/da" conjunction written apart, suffix attached; "ki" apart as conjunction. "-mı/-mi" written apart.

## 3. Patterns
- Buttons: verb in imperative, 1–3 words: "Kaydet", "İptal", "Sil", "Devam et", "Tekrar dene", "Daha fazla göster". Destructive confirm repeats the action: "Dosyayı sil" — not "Evet".
- Confirmations: title asks, body states the consequence: "Dosya silinsin mi?" / "Bu işlem geri alınamaz. 3 sayfa ve 12 yorum da silinecek." Buttons: "Sil" / "Vazgeç".
- Errors: what happened + how to fix, no blame, no codes up front: "Bağlantı kurulamadı. İnternetinizi kontrol edip tekrar deneyin." Field errors under the field: "Geçerli bir e-posta adresi girin." Not "Geçersiz giriş!".
- Empty states: what this place is for + the first action: "Henüz dosyanız yok" / "İlk dosyanızı oluşturarak başlayın." + "Dosya oluştur".
- Success / toasts: past tense, short: "Kaydedildi", "Bağlantı kopyalandı", "Davet gönderildi". Undo when possible: "Silindi · Geri al".
- Loading: "Yükleniyor…", specific when you can: "Dosyalar yükleniyor…" (use the ellipsis character …).
- Form labels: nouns, not questions: "E-posta", "Şifre", "Ad soyad". Placeholders show an example, never replace the label: "ornek@firma.com".
- Settings toggles: describe the on state: "Bildirimleri göster".
- Onboarding: one benefit per screen, second person, under 2 lines.

## 4. Length
- Turkish runs ~20–30 % longer than English; design widths for it. Limits: buttons ≤ 20 characters (≤ 14 on mobile), tab and menu items ≤ 18, toasts ≤ 60, error lines ≤ 90, titles ≤ 40. Shorten by choosing a stronger verb, not by abbreviating ("Ayarlar" not "Ayrlr").
- Agglutination makes long single words ("Kaydedemediklerimizden"): allow wrapping or a wider box; never hyphenate buttons.

## 5. In Wecra
- Write copy straight into the text layers (update_nodes characters). For TR / EN, make a STRING variable collection "Content" with modes TR and EN, bind texts (bind_variable field "characters"), and switch frames with set_variable_mode; a language toggle in prototypes uses SET_VARIABLE_MODE.
- Review mode: add_comment on each text layer that needs a change: "Öneri: 'Başarıyla kaydedildi' → 'Kaydedildi' (daha kısa, çeviri kokmuyor)."

## Checklist
- [ ] One address (siz or sen) across the flow
- [ ] Sentence case; Turkish İ/ı casing; apostrophes and suffix harmony correct
- [ ] Numbers, dates, currency in Turkish format
- [ ] Buttons as verbs; errors say what and how; empty states give a first action
- [ ] Within length limits; no translationese; TR / EN via variables when bilingual`,
};
