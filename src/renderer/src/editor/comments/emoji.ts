/**
 * The emoji picker's set (live Figma: category tabs — recent, smileys, nature, food, activity, travel, objects,
 * symbols, flags —, a search field, "Frequently used", then the categories). Figma lists every Unicode emoji; this is a
 * curated subset with names to search by.
 */
export interface EmojiCategory {
  id: string;
  label: string;
  /** The tab's glyph */
  icon: string;
  emoji: [string, string][];
}

export const FREQUENT: string[] = ["➕", "👍", "👎", "😀", "❤️", "🎉", "🔥", "👀", "✅", "🙏"];

export const CATEGORIES: EmojiCategory[] = [
  {
    id: "people",
    label: "Smileys & People",
    icon: "😀",
    emoji: [
      ["😀", "grinning"], ["😃", "smiley"], ["😄", "smile"], ["😁", "grin"], ["😆", "laughing"], ["😅", "sweat smile"], ["😂", "joy"], ["🙂", "slightly smiling"],
      ["😉", "wink"], ["😊", "blush"], ["😍", "heart eyes"], ["🤩", "star struck"], ["😘", "kissing heart"], ["😋", "yum"], ["😎", "sunglasses"], ["🤔", "thinking"],
      ["🤨", "raised eyebrow"], ["😐", "neutral"], ["😶", "no mouth"], ["🙄", "eye roll"], ["😏", "smirk"], ["😮", "open mouth"], ["😯", "hushed"], ["😴", "sleeping"],
      ["😢", "cry"], ["😭", "sob"], ["😱", "scream"], ["😡", "rage"], ["🤯", "exploding head"], ["🥳", "partying"], ["🥺", "pleading"], ["🤗", "hugging"],
      ["👍", "thumbs up +1"], ["👎", "thumbs down -1"], ["👏", "clap"], ["🙌", "raised hands"], ["🙏", "pray thanks"], ["👌", "ok hand"], ["✌️", "victory"], ["🤞", "crossed fingers"],
      ["👋", "wave"], ["💪", "muscle"], ["👀", "eyes"], ["🧠", "brain"],
    ],
  },
  {
    id: "nature",
    label: "Animals & Nature",
    icon: "🐻",
    emoji: [["🐶", "dog"], ["🐱", "cat"], ["🦊", "fox"], ["🐻", "bear"], ["🐼", "panda"], ["🦄", "unicorn"], ["🐝", "bee"], ["🌸", "cherry blossom"], ["🌻", "sunflower"], ["🌲", "tree"], ["🌈", "rainbow"], ["⭐", "star"], ["🌙", "moon"], ["☀️", "sun"], ["⚡", "zap lightning"], ["❄️", "snowflake"]],
  },
  {
    id: "food",
    label: "Food & Drink",
    icon: "🍔",
    emoji: [["🍎", "apple"], ["🍕", "pizza"], ["🍔", "hamburger"], ["🌮", "taco"], ["🍣", "sushi"], ["🍩", "doughnut"], ["🍪", "cookie"], ["🎂", "birthday cake"], ["☕", "coffee"], ["🍵", "tea"], ["🍺", "beer"], ["🥂", "clinking glasses"]],
  },
  {
    id: "activity",
    label: "Activity",
    icon: "⚽",
    emoji: [["⚽", "soccer"], ["🏀", "basketball"], ["🎯", "dart target"], ["🎮", "video game"], ["🎨", "art palette"], ["🎵", "musical note"], ["🏆", "trophy"], ["🥇", "first place medal"], ["🎉", "tada party"], ["🎊", "confetti"]],
  },
  {
    id: "travel",
    label: "Travel & Places",
    icon: "🚗",
    emoji: [["🚀", "rocket"], ["✈️", "airplane"], ["🚗", "car"], ["🚲", "bike"], ["🏠", "house"], ["🏢", "office"], ["🗺️", "map"], ["🏝️", "island"], ["⛰️", "mountain"], ["🌍", "earth globe"]],
  },
  {
    id: "objects",
    label: "Objects",
    icon: "💡",
    emoji: [["💡", "bulb idea"], ["📌", "pushpin"], ["📎", "paperclip"], ["✏️", "pencil"], ["📝", "memo"], ["📅", "calendar"], ["📷", "camera"], ["💻", "laptop"], ["📱", "phone"], ["🔒", "lock"], ["🔑", "key"], ["🛠️", "tools"], ["📦", "package"], ["🎁", "gift"]],
  },
  {
    id: "symbols",
    label: "Symbols",
    icon: "❤️",
    emoji: [["❤️", "heart"], ["🧡", "orange heart"], ["💛", "yellow heart"], ["💚", "green heart"], ["💙", "blue heart"], ["💜", "purple heart"], ["🔥", "fire"], ["✨", "sparkles"], ["💯", "100"], ["✅", "check mark"], ["❌", "cross mark"], ["⚠️", "warning"], ["❓", "question"], ["❗", "exclamation"], ["➕", "plus"], ["➖", "minus"]],
  },
  {
    id: "flags",
    label: "Flags",
    icon: "🏁",
    emoji: [["🏁", "checkered flag"], ["🚩", "red flag"], ["🏳️", "white flag"], ["🏴", "black flag"], ["🇹🇷", "turkey"], ["🇺🇸", "united states"], ["🇬🇧", "united kingdom"], ["🇩🇪", "germany"], ["🇫🇷", "france"], ["🇯🇵", "japan"]],
  },
];

const NAMES = new Map(CATEGORIES.flatMap((c) => c.emoji));

export function searchEmoji(query: string): string[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return [...NAMES].filter(([, name]) => name.includes(q)).map(([e]) => e);
}

export const emojiName = (e: string): string => NAMES.get(e) ?? e;
