import { add, multiply } from "./math.mjs";
if (add(2, 3) !== 5) throw new Error("add is wrong");
if (multiply(2, 3) !== 6) throw new Error("multiply is wrong");
console.log("math.mjs passes");