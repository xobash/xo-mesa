import { describe, it, expect } from "vitest";
import { planKeyMigration } from "./migrate";

describe("planKeyMigration", () => {
  const FROM = "telperion:";
  const TO = "mesa:";

  it("copies every legacy-prefixed key to the new prefix", () => {
    const moves = planKeyMigration(
      ["telperion:theme", "telperion:settings", "unrelated"],
      FROM,
      TO,
      () => false
    );
    expect(moves).toEqual([
      { from: "telperion:theme", to: "mesa:theme" },
      { from: "telperion:settings", to: "mesa:settings" },
    ]);
  });

  it("never clobbers a target key that already exists", () => {
    const present = new Set(["mesa:theme"]);
    const moves = planKeyMigration(
      ["telperion:theme", "telperion:lastVault"],
      FROM,
      TO,
      (k) => present.has(k)
    );
    // theme already migrated → only lastVault is copied
    expect(moves).toEqual([{ from: "telperion:lastVault", to: "mesa:lastVault" }]);
  });

  it("ignores keys without the legacy prefix", () => {
    expect(
      planKeyMigration(["mesa:theme", "random", "other:thing"], FROM, TO, () => false)
    ).toEqual([]);
  });

  it("is a no-op when there is nothing to migrate", () => {
    expect(planKeyMigration([], FROM, TO, () => false)).toEqual([]);
  });

  it("preserves the suffix after the prefix exactly", () => {
    const moves = planKeyMigration(["telperion:a:b:c"], FROM, TO, () => false);
    expect(moves).toEqual([{ from: "telperion:a:b:c", to: "mesa:a:b:c" }]);
  });
});
