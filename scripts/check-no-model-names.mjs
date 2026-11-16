#!/usr/bin/env node
// Gate: no object name from a real TM1 model in the repository.
//
// The list of real names cannot live in the repo — it would be the leak. It is
// read from docs/internal/model-names/names.txt, which is gitignored and exists
// only on a maintainer's machine. Without that file (CI, a fresh clone) the
// gate reports that it was skipped and passes.
//
// names.txt: one name per line, `#` starts a comment. A name matches as a whole
// word, ignoring case. Checked are all tracked files plus new files that are
// not ignored, so a test written a minute ago is covered before it is committed.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const NAMES_FILE = "docs/internal/model-names/names.txt";
// evals/ is the one place that names objects of a server on purpose: its
// answers are facts about the demo model the evaluation runs against.
const SKIP_FILES =
  /^evals\/|(^|\/)(npm-shrinkwrap\.json|package-lock\.json)$|\.(png|jpe?g|gif|ico|pdf|zip|tgz)$/i;

if (!existsSync(NAMES_FILE)) {
  console.log(`model-names: skipped, no local name list (${NAMES_FILE})`);
  process.exit(0);
}

const names = [
  ...new Set(
    readFileSync(NAMES_FILE, "utf8")
      .split(/\r?\n/)
      .map((line) => line.replace(/#.*$/, "").trim())
      .filter(Boolean),
  ),
];
if (names.length === 0) {
  console.log("model-names: skipped, the local name list is empty");
  process.exit(0);
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// Longest first, so the longer of two overlapping names is the one reported.
const alternation = names
  .sort((a, b) => b.length - a.length)
  .map(escape)
  .join("|");
const pattern = new RegExp(
  `(?<![A-Za-z0-9_])(?:${alternation})(?![A-Za-z0-9_])`,
  "gi",
);

const files = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
  { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
)
  .split("\0")
  .filter((f) => f && !SKIP_FILES.test(f) && existsSync(f));

const hits = [];
for (const file of files) {
  const lines = readFileSync(file, "utf8").split("\n");
  lines.forEach((text, i) => {
    for (const m of text.matchAll(pattern)) {
      hits.push(`${file}:${i + 1}: ${m[0]}`);
    }
  });
}

if (hits.length > 0) {
  console.error(
    `model-names: ${hits.length} name(s) from a real TM1 model found. Use invented names.\n`,
  );
  for (const hit of hits.slice(0, 50)) console.error(`  ${hit}`);
  if (hits.length > 50) console.error(`  … and ${hits.length - 50} more`);
  console.error(
    `\nA harmless everyday word on the list? Remove it from ${NAMES_FILE}.`,
  );
  process.exit(1);
}
console.log(
  `model-names: ok, ${files.length} files checked against ${names.length} names`,
);
