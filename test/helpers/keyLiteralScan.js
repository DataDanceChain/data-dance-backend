/**
 * Finds quoted 64-hex literals, which is what a private key looks like, in source files.
 *
 * A key was once committed to this (public) repository as `const X = "0x<64 hex>"`. The scan is
 * deliberately wider than that shape: it flags EVERY quoted literal of 64 hex characters (with or
 * without 0x, any quote style), wherever it sits: a default (`process.env.X || "0x..."`), an
 * argument (`new Wallet("0x...")`), a value on the line below its name, a member of an object, any
 * variable name. Only a literal bound to an explicitly allowed (file, name) pair is let through.
 *
 * It reports file:line and the name the literal is bound to, never the literal itself, so a failing
 * run cannot print a key.
 */
const fs = require('fs');
const path = require('path');

// A quoted literal of exactly 64 hex characters. Run over the whole text (not line by line), so the
// literal may sit on a line of its own.
const QUOTED_KEY_LITERAL = /["'`](?:0x)?[0-9a-fA-F]{64}["'`]/g;
const SOURCE_FILE = /\.(?:[cm]?[jt]s|[jt]sx)$/;

/**
 * The name a literal is bound to: the identifier directly before `:` or `=` (a quote around it is
 * fine), whitespace and line breaks allowed in between. Null when there is none: an argument, a
 * `||` default, an array element.
 */
function boundName(text, index) {
  const before = text.slice(Math.max(0, index - 200), index);
  const match = /([A-Za-z_$][\w$]*)["'`]?\s*[:=]\s*$/.exec(before);
  return match ? match[1] : null;
}

function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) line += 1;
  return line;
}

function* sourceFiles(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* sourceFiles(full);
    else if (SOURCE_FILE.test(entry.name)) yield full;
  }
}

/**
 * Every quoted 64-hex literal under `root`/`dirs`, as { file, line, name, allowed }, `file`
 * relative to `root` with forward slashes. `allowed` is true only when the literal's (file, name)
 * is in `allowlist` ([{ file, name }]).
 */
function findKeyLiterals(root, { dirs = ['src', 'scripts'], allowlist = [] } = {}) {
  const found = [];
  for (const dir of dirs) {
    const base = path.join(root, dir);
    if (!fs.existsSync(base)) continue;
    for (const full of sourceFiles(base)) {
      const text = fs.readFileSync(full, 'utf8');
      const file = path.relative(root, full).split(path.sep).join('/');
      for (const match of text.matchAll(QUOTED_KEY_LITERAL)) {
        const name = boundName(text, match.index);
        found.push({
          file,
          line: lineOf(text, match.index),
          name,
          allowed: name !== null && allowlist.some((entry) => entry.file === file && entry.name === name),
        });
      }
    }
  }
  return found;
}

module.exports = { findKeyLiterals };
