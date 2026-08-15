# Gotcha: `import.meta.url` is an **http** URL inside `.tsx` under @vitejs/plugin-react

Hit on `task-04673fd0e786481fad95a9343fee500c` (control-room shell frame), copying the
source-scan helper out of `apps/control-room/src/scaffold.test.tsx`.

`scaffold.test.tsx:30` has:

```ts
const readOwnSource = (fileName: string): string =>
  readFileSync(fileURLToPath(new URL(fileName, import.meta.url)), "utf8");
```

Reused verbatim in a new `.tsx` test it throws:

    TypeError: The URL must be of scheme file

Probed directly. In a `.ts` test file:

    import.meta.url === "file:///D:/projexts/moe-next/apps/control-room/src/shell/probe.test.ts"

In a `.tsx` test file in the same directory, `new URL("./frame.tsx", import.meta.url).href`:

    "http://localhost:3000/src/shell/frame.tsx"

The React plugin rewrites `import.meta` for HMR, so the base becomes the dev-server
origin. Passing `.href` instead of the URL object does not help — the scheme is
genuinely http.

## What to do

Resolve from the Vitest root instead, which is the package dir:

```ts
const source = readFileSync(resolve(process.cwd(), "src/shell/frame.tsx"), "utf8");
```

## The part that matters more than the fix

A source scan that reads the wrong path, or an empty file, **passes every
`not.toContain` assertion forever**. Absence assertions are vacuous by default. Always
anchor one positive assertion proving the read landed:

```ts
expect(source).toContain("export function ShellFrame");
expect(source).not.toContain("Unavailable");
```

Same failure shape as `mem:pattern-guard-the-case-list-not-just-the-cases`, but for file
reads rather than generated cases.

Related: `mem:convention-control-room-test-id-prefixes`.
