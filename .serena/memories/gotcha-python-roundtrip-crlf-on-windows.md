# Gotcha: scripted file edits silently rewrite the file to CRLF

This repo pins `* text=auto eol=lf` in `.gitattributes` and `core.autocrlf=true`, so the
working tree is LF-only. A quick probe edit like

```bash
python - <<'EOF'
s = open(path, encoding='utf-8').read()      # universal newlines: CRLF/LF -> \n
open(path, 'w', encoding='utf-8').write(s)   # newline=None on Windows: \n -> \r\n
EOF
```

round-trips through text mode and converts the WHOLE file to CRLF, not just the edited line.
`git diff --stat` then prints
`warning: in the working copy of '<file>', CRLF will be replaced by LF the next time Git touches it`
and the diff looks enormous / every line touched.

Fixes:
- Read and write in **binary** mode when scripting an edit: `open(p,'rb').read()` /
  `open(p,'wb').write(data)`, or pass `newline='\n'` explicitly to the text-mode write.
- To repair a file already flipped: `data = open(p,'rb').read().replace(b'\r\n', b'\n')` then
  write back in binary.
- Detect it with `grep -qU $'\r' <file>` (the `-U` matters: without it ripgrep/grep may treat
  the file as text and hide the CR).

Prefer the Edit tool for real changes; reserve scripted edits for throwaway probes (mutation
testing a gate, reading a computed value out of an assertion failure) and always restore from a
byte-level backup (`cp file /tmp/x.bak` first, `cp /tmp/x.bak file` after) rather than
re-editing the text back.
