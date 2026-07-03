/**
 * LocalSend-style device names — a friendly "Adjective Noun" pair ("Toasty
 * Lemon", "Quiet Walrus") generated once per device and persisted in settings
 * (`syncDeviceName`). Discovery advertises this name so a user syncing three
 * machines sees three distinct, memorable devices instead of "Mesa device"
 * three times. The name is cosmetic: a peer's real identity is its TLS
 * certificate fingerprint (see sync.ts).
 */

const ADJECTIVES = [
  "Amber", "Brave", "Breezy", "Bright", "Bubbly", "Calm", "Cheery", "Chilly",
  "Clever", "Cosmic", "Cozy", "Crispy", "Curly", "Dandy", "Dapper", "Dusty",
  "Fluffy", "Frosty", "Fuzzy", "Gentle", "Giddy", "Glossy", "Golden", "Happy",
  "Hazy", "Jolly", "Jumpy", "Lucky", "Mellow", "Merry", "Mighty", "Minty",
  "Misty", "Nifty", "Peppy", "Perky", "Plucky", "Polite", "Quiet", "Rosy",
  "Sandy", "Shiny", "Silky", "Sleepy", "Snappy", "Sneaky", "Snowy", "Sparky",
  "Speedy", "Spiffy", "Sunny", "Swift", "Toasty", "Witty", "Zesty", "Zippy",
] as const;

const NOUNS = [
  "Acorn", "Badger", "Bagel", "Bamboo", "Beacon", "Biscuit", "Breeze",
  "Cactus", "Canyon", "Cherry", "Clover", "Comet", "Cricket", "Dolphin",
  "Donut", "Falcon", "Fern", "Fox", "Gecko", "Glacier", "Harbor", "Hedgehog",
  "Kiwi", "Koala", "Lagoon", "Lemon", "Mango", "Maple", "Meadow", "Nutmeg",
  "Otter", "Panda", "Peach", "Pebble", "Penguin", "Pepper", "Pickle", "Pine",
  "Pretzel", "Puffin", "Raccoon", "Raven", "River", "Sprout", "Summit",
  "Tiger", "Truffle", "Tulip", "Walnut", "Walrus", "Wombat", "Zephyr",
] as const;

/**
 * Generate a random "Adjective Noun" device name. `rand` is injectable for
 * tests and must return a float in [0, 1) (like `Math.random`).
 */
export function generateDeviceName(rand: () => number = Math.random): string {
  const pick = (words: readonly string[]) =>
    words[Math.min(Math.floor(rand() * words.length), words.length - 1)];
  return `${pick(ADJECTIVES)} ${pick(NOUNS)}`;
}

/** Exposed for tests (combination-space checks). */
export const DEVICE_NAME_WORDS = { adjectives: ADJECTIVES, nouns: NOUNS };
