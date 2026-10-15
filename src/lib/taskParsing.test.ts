import { expect, it } from "vitest";
import { parseTasks } from "./taskParsing";

it("only a matching fence marker closes a code fence", () => {
  const src = ["```sh", "~~~", "- [ ] not a task", "```", "````", "```", "- [ ] still code", "````", "- [ ] real"].join("\n");
  expect(parseTasks("a.md", "a", src).map((task) => task.text)).toEqual(["real"]);
});
