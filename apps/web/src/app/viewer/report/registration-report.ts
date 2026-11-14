/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The registration report (#87): what a registration is, the images it is
// between, and every number that was measured of it in the viewer, as one
// HTML file that needs nothing else to be read or printed.
//
// The report says what the panels say, in their words: a section is made
// where its numbers are made, and carried here whole, notes and all. Nothing
// in it says whether a number is good (`docs/registration-metrics.md`).
//
// Text from files (names, descriptions) is escaped wherever it is written,
// and the file forbids itself scripts and anything fetched.

/** One line of a table: a name and a value with its unit. */
export interface ReportRow {
  readonly name: string;
  readonly value: string;
}

export interface ReportTable {
  readonly caption: string;
  readonly rows: readonly ReportRow[];
}

/** What one panel measured: its tables, and the notes that go with them. */
export interface ReportSection {
  readonly title: string;
  /** What it was measured on, in a line; null when the title says it all. */
  readonly about: string | null;
  readonly tables: readonly ReportTable[];
  readonly notes: readonly string[];
}

/** A kind of measurement the report has a place for, measured or not. */
export interface ReportPart {
  /** A short name for markup and tests: `landmarks`, `structures`, `field`. */
  readonly key: string;
  readonly title: string;
  /** Null when it was not measured: the report says so, and has no numbers for it. */
  readonly section: ReportSection | null;
}

/** One of the two images, as rows of a table. */
export interface ReportImage {
  readonly role: string;
  readonly rows: readonly ReportRow[];
}

/** A picture of a pane as it was drawn when the report was made. */
export interface ReportPicture {
  readonly caption: string;
  /** A `data:image/png` address: the picture is in the file itself. */
  readonly dataUrl: string;
}

export interface ReportContent {
  readonly made: Date;
  /** Whether the patient's and the objects' identifiers are in the report. */
  readonly identifiers: boolean;
  readonly images: readonly ReportImage[];
  /** The registration in a line, as the layers panel says it. */
  readonly registration: string;
  /** Each registration gone through, in order, as rows of a table. */
  readonly steps: readonly ReportTable[];
  readonly parts: readonly ReportPart[];
  readonly pictures: readonly ReportPicture[];
}

/** The notice every page of a report carries. */
export const REPORT_NOTICE =
  'Not for clinical use. Made with Open RT Studio, which is not a medical device.';

/** What a report without identifiers says of what it leaves out, and what it keeps. */
export const IDENTIFIERS_LEFT_OUT =
  'Identifiers are left out: the patient’s name and ID, dates, study and series descriptions, and every UID. Names that were typed for registrations, structures and landmarks are kept as they are, and so is anything written into an image’s own pixels.';

/** What a report with identifiers says of itself. */
export const IDENTIFIERS_INCLUDED =
  'This report holds the patient’s name and ID and the UIDs of the images and registrations. Guard it like the data.';

/** Text made safe to write into HTML, between tags or inside an attribute. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const two = (value: number): string => String(value).padStart(2, '0');

/** A time as the report writes it: the local date and time to the minute. */
export function reportTime(date: Date): string {
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}`;
}

/** The report's file name: what it is and when it was made, and nothing of the patient. */
export function reportFilename(date: Date): string {
  const day = `${date.getFullYear()}${two(date.getMonth() + 1)}${two(date.getDate())}`;
  const time = `${two(date.getHours())}${two(date.getMinutes())}${two(date.getSeconds())}`;
  return `registration-report-${day}-${time}.html`;
}

function table({ caption, rows }: ReportTable): string {
  const lines = rows
    .map(
      (row) =>
        `<tr><th scope="row">${escapeHtml(row.name)}</th><td>${escapeHtml(row.value)}</td></tr>`,
    )
    .join('');
  return `<table class="numbers"><caption>${escapeHtml(caption)}</caption><tbody>${lines}</tbody></table>`;
}

const paragraph = (text: string, kind = 'note'): string =>
  `<p class="${kind}">${escapeHtml(text)}</p>`;

function part({ key, title, section }: ReportPart): string {
  const body = section
    ? [
        section.about ? paragraph(section.about, 'about') : '',
        ...section.tables.map(table),
        ...section.notes.map((note) => paragraph(note)),
      ].join('')
    : paragraph('Not measured.', 'none');
  const state = section ? 'measured' : 'none';
  return `<section data-report="${escapeHtml(key)}" data-state="${state}"><h2>${escapeHtml(section?.title ?? title)}</h2>${body}</section>`;
}

/**
 * A data address is written only when it is a PNG's: nothing else is ever a
 * picture here, and nothing else gets into an `src`.
 */
function picture({ caption, dataUrl }: ReportPicture): string {
  if (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(dataUrl)) return '';
  return `<figure><img src="${dataUrl}" alt="${escapeHtml(caption)}"><figcaption>${escapeHtml(caption)}</figcaption></figure>`;
}

const STYLE = `
:root { color-scheme: light; }
* { box-sizing: border-box; }
body { margin: 0; background: #fcfcfb; color: #0b0b0b; font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
table.pages { width: 100%; max-width: 820px; margin: 0 auto; border-collapse: collapse; }
table.pages > * > tr > td { padding: 0 16px; }
thead { display: table-header-group; }
tfoot { display: table-footer-group; }
.notice { margin: 0; padding: 8px 0; border-bottom: 2px solid #0b0b0b; font-weight: 700; letter-spacing: 0.02em; }
tfoot .notice { border-bottom: 0; border-top: 2px solid #0b0b0b; }
h1 { margin: 20px 0 4px; font-size: 24px; }
h2 { margin: 24px 0 6px; font-size: 17px; break-after: avoid; }
h3 { margin: 12px 0 4px; font-size: 14px; }
p { margin: 6px 0; }
.made, .note, .about, .none { color: #52514e; }
.identifiers { padding: 8px 10px; border: 1px solid #c3c2b7; border-radius: 4px; }
table.numbers { border-collapse: collapse; margin: 8px 0; break-inside: avoid; }
table.numbers caption { text-align: left; font-weight: 600; padding-bottom: 2px; }
table.numbers th { text-align: left; font-weight: 400; color: #52514e; padding: 2px 16px 2px 0; vertical-align: top; }
table.numbers td { padding: 2px 0; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
table.numbers tr { border-top: 1px solid #e1e0d9; }
.images { display: flex; flex-wrap: wrap; gap: 0 32px; }
.pictures { display: flex; flex-wrap: wrap; gap: 12px; }
figure { margin: 0; flex: 1 1 240px; max-width: 380px; break-inside: avoid; }
figure img { display: block; width: 100%; height: auto; background: #000; }
figcaption { color: #52514e; padding: 2px 0 6px; }
@media print {
  body { background: #fff; }
  table.pages { max-width: none; }
}
`;

/**
 * The report as one HTML file. The notice is the head and the foot of a
 * table that holds everything else, so a browser prints it at the top and
 * the bottom of every page.
 */
export function reportHtml(content: ReportContent): string {
  const images = content.images
    .map((image) => `<div>${table({ caption: image.role, rows: image.rows })}</div>`)
    .join('');
  const pictures = content.pictures.map(picture).join('');
  const sections = [
    `<h1>Registration report</h1>` +
      `<p class="made">Made ${escapeHtml(reportTime(content.made))}. What was measured in the viewer when it was made, and nothing that says whether a number is good.</p>` +
      `<p class="identifiers" data-report-identifiers="${content.identifiers ? 'included' : 'left-out'}">${escapeHtml(content.identifiers ? IDENTIFIERS_INCLUDED : IDENTIFIERS_LEFT_OUT)}</p>`,
    `<section data-report="images"><h2>Images</h2><div class="images">${images}</div></section>`,
    `<section data-report="registration"><h2>Registration</h2>${paragraph(content.registration, 'about')}${content.steps.map(table).join('')}</section>`,
    ...content.parts.map(part),
    `<section data-report="pictures"><h2>Pictures</h2>` +
      (pictures
        ? `${paragraph('The panes as they were drawn when the report was made. Marks the viewer lays over a pane, such as arrows and landmarks, are not in them.')}<div class="pictures">${pictures}</div>`
        : paragraph('No picture could be taken.', 'none')) +
      `</section>`,
  ];
  const rows = sections.map((section) => `<tr><td>${section}</td></tr>`).join('\n');
  const notice = `<tr><td><p class="notice" data-report-notice>${escapeHtml(REPORT_NOTICE)}</p></td></tr>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Registration report</title>
<style>${STYLE}</style>
</head>
<body>
<table class="pages" role="presentation">
<thead>${notice}</thead>
<tfoot>${notice}</tfoot>
<tbody>
${rows}
</tbody>
</table>
</body>
</html>
`;
}
