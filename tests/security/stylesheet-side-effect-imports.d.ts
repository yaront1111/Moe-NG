/**
 * STYLESHEET SIDE-EFFECT IMPORTS, declared for the lane's typecheck and for nothing else.
 *
 * A control-room component may `import "../styles/x.css"` purely to make the stylesheet ship.
 * `tsc` rejects that as TS2882 unless something in the program declares the module, and the
 * control-room's own project only gets it from `/// <reference types="vite/client" />` at
 * board-surface.tsx:1. That reference is not usable here: `vite` is a control-room dependency
 * and does not resolve from `tests/security`, which is not a workspace package and has no
 * `package.json` of its own. Four lines of ambient declaration, in the lane, is the smaller
 * answer than giving the lane a manifest.
 *
 * IT DECLARES NOTHING ABOUT A BOUNDARY. No layer, no refusal, no shape — a stylesheet import
 * carries no value, and the arms that reach one assert on the daemon's own refusal instead.
 */
declare module "*.css";
