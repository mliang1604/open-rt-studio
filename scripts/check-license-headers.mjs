/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Checks that every source file starts with the MPL 2.0 header described in
// docs/license-headers.md. Run with --fix to add the header where it is missing.
//
//   node scripts/check-license-headers.mjs [--fix] [file ...]
//
// With no files given it checks everything git tracks plus untracked files
// that are not ignored.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, extname } from 'node:path';

const HEADER_LINES = [
  'This Source Code Form is subject to the terms of the Mozilla Public',
  'License, v. 2.0. If a copy of the MPL was not distributed with this',
  'file, You can obtain one at https://mozilla.org/MPL/2.0/.',
];

const BLOCK = ['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs', '.css', '.scss', '.wgsl'];
const C_FAMILY = ['.c', '.cc', '.cpp', '.cxx', '.h', '.hh', '.hpp'];
const MARKUP = ['.html'];
const HASH = ['.sh', '.cmake'];

/** Directories whose files keep their own notices or are generated. */
const EXCLUDED = /(^|\/)(third_party|node_modules|dist|out-tsc|\.angular|coverage)\//;

/** @returns {'block' | 'markup' | 'hash' | null} the comment style, or null if no header is needed */
export function commentStyle(path) {
  if (EXCLUDED.test(path)) return null;
  const ext = extname(path).toLowerCase();
  if (BLOCK.includes(ext) || C_FAMILY.includes(ext)) return 'block';
  if (MARKUP.includes(ext)) return 'markup';
  if (HASH.includes(ext) || basename(path) === 'CMakeLists.txt') return 'hash';
  return null;
}

/** The header as it is written for a comment style, without a trailing newline. */
export function headerFor(style) {
  const [a, b, c] = HEADER_LINES;
  switch (style) {
    case 'block':
      return `/* ${a}\n * ${b}\n * ${c} */`;
    case 'markup':
      return `<!-- ${a}\n   - ${b}\n   - ${c} -->`;
    case 'hash':
      return `# ${a}\n# ${b}\n# ${c}`;
    default:
      throw new Error(`Unknown comment style: ${style}`);
  }
}

/** Lines that may come before the header: a shebang or an HTML doctype. */
function splitPreamble(text) {
  const match = /^(#![^\n]*\n|<!doctype[^>]*>\s*\n)/i.exec(text);
  return match ? [match[0], text.slice(match[0].length)] : ['', text];
}

/** True when the text starts with the header (after an allowed first line). */
export function hasHeader(text) {
  // Skip a byte order mark if the file has one.
  const [, body] = splitPreamble(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  // Compare on words only, so comment markers and line breaks do not matter.
  const words = (s) => s.replace(/[^A-Za-z0-9]+/g, ' ').trim();
  return words(body.slice(0, 600)).startsWith(words(HEADER_LINES.join(' ')));
}

/** The text with the header added at the top. */
export function addHeader(text, style) {
  const [preamble, body] = splitPreamble(text);
  return `${preamble}${headerFor(style)}\n\n${body.replace(/^\n+/, '')}`;
}

function listFiles() {
  const out = execFileSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  return out.split('\0').filter(Boolean);
}

function main(argv) {
  const fix = argv.includes('--fix');
  const named = argv.filter((a) => !a.startsWith('--'));
  const files = named.length > 0 ? named : listFiles();

  const missing = [];
  let checked = 0;
  for (const path of files) {
    const style = commentStyle(path);
    if (!style) continue;
    let text;
    try {
      text = readFileSync(path, 'utf8');
    } catch {
      continue; // deleted in the working tree but still in the index
    }
    checked++;
    if (hasHeader(text)) continue;
    if (fix) writeFileSync(path, addHeader(text, style));
    missing.push(path);
  }

  if (missing.length === 0) {
    console.log(`License headers: ${checked} files checked, all have the MPL 2.0 header.`);
    return 0;
  }
  if (fix) {
    console.log(`License headers: added the MPL 2.0 header to ${missing.length} files.`);
    return 0;
  }
  console.error(`License headers: ${missing.length} of ${checked} files lack the MPL 2.0 header:`);
  for (const path of missing) console.error(`  ${path}`);
  console.error('Run "node scripts/check-license-headers.mjs --fix" to add it.');
  console.error('See docs/license-headers.md.');
  return 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)));
}
