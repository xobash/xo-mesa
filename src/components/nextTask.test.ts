// @vitest-environment jsdom
import { expect, it } from "vitest";
import { nextTask } from "./nextTask";

it("runs queued tasks later, in order, each in its own task", async () => {
  const order: string[] = [];
  nextTask(() => { order.push("a"); nextTask(() => order.push("c")); });
  nextTask(() => order.push("b"));
  order.push("sync");
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(order).toEqual(["sync", "a", "b", "c"]);
});
