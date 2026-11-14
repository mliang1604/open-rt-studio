/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  IDENTIFIERS_INCLUDED,
  IDENTIFIERS_LEFT_OUT,
  REPORT_NOTICE,
  escapeHtml,
  reportFilename,
  reportHtml,
  reportTime,
  type ReportContent,
} from './registration-report';

const PNG = 'data:image/png;base64,iVBORw0KGgo=';
const CONTENT: ReportContent = {
  made: new Date(2026, 10, 4, 9, 5, 7),
  identifiers: false,
  images: [
    { role: 'Base image', rows: [{ name: 'Modality', value: 'CT' }] },
    { role: 'Compared image', rows: [{ name: 'Modality', value: 'MR' }] },
  ],
  registration: 'Placed by registration “REG” (written this image → base).',
  steps: [{ caption: 'Registration', rows: [{ name: 'Used', value: 'turned round' }] }],
  parts: [
    {
      key: 'landmarks',
      title: 'Landmarks: target registration error',
      section: {
        title: 'Landmarks: target registration error',
        about: null,
        tables: [
          { caption: 'Target registration error', rows: [{ name: 'Mean', value: '2.50 mm' }] },
        ],
        notes: ['Measured at 2 landmarks only. Includes the error of placing them.'],
      },
    },
    { key: 'structures', title: 'Structures: surface distances and overlap', section: null },
    {
      key: 'field',
      title: 'Deformation field',
      section: {
        title: 'Deformation field',
        about: 'Over the whole field.',
        tables: [{ caption: 'Displacement', rows: [{ name: 'Largest', value: '5.10 mm' }] }],
        notes: ['Shows whether the deformation is physically plausible, not whether it is right.'],
      },
    },
  ],
  pictures: [{ caption: 'Axial', dataUrl: PNG }],
};

/** The report as a document, to ask it what it holds. */
function read(content: ReportContent): Document {
  return new DOMParser().parseFromString(reportHtml(content), 'text/html');
}
const textOf = (node: Element | null): string =>
  node?.textContent.replace(/\s+/g, ' ').trim() ?? '';

describe('the registration report as a file', () => {
  it('says it is not for clinical use at the head and the foot of every page', () => {
    const page = read(CONTENT);
    // The head and the foot of a table are printed on every page it runs over.
    expect(textOf(page.querySelector('table.pages > thead [data-report-notice]'))).toBe(
      REPORT_NOTICE,
    );
    expect(textOf(page.querySelector('table.pages > tfoot [data-report-notice]'))).toBe(
      REPORT_NOTICE,
    );
    expect(REPORT_NOTICE).toContain('Not for clinical use');
    // Everything else is in the table's body.
    expect(page.querySelectorAll('table.pages > tbody section').length).toBe(6);
    expect(page.body.children).toHaveLength(1);
  });

  it('needs nothing else and runs nothing: no script, nothing fetched', () => {
    const html = reportHtml(CONTENT);
    expect(html).not.toMatch(/<script|<link|<iframe|javascript:|\son[a-z]+=/i);
    expect(html).toContain(
      `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">`,
    );
    expect(html.match(/\b(?:src|href)="(?!data:image\/png;base64,)/g)).toBeNull();
    expect(html.startsWith('<!doctype html>')).toBe(true);
  });

  it('has the images, the registration, and each measured part with its numbers and notes', () => {
    const page = read(CONTENT);
    expect(textOf(page.querySelector('h1'))).toBe('Registration report');
    expect(textOf(page.querySelector('.made'))).toContain('Made 2026-11-04 09:05.');
    expect(
      [...page.querySelectorAll('[data-report="images"] caption')].map((one) => textOf(one)),
    ).toEqual(['Base image', 'Compared image']);
    const registration = page.querySelector('[data-report="registration"]')!;
    expect(textOf(registration.querySelector('.about'))).toBe(
      'Placed by registration “REG” (written this image → base).',
    );
    expect(textOf(registration.querySelector('caption'))).toBe('Registration');
    expect(textOf(registration.querySelector('th'))).toBe('Used');
    expect(textOf(registration.querySelector('td'))).toBe('turned round');
    const landmarks = page.querySelector('[data-report="landmarks"]')!;
    expect(landmarks.getAttribute('data-state')).toBe('measured');
    expect(textOf(landmarks.querySelector('th'))).toBe('Mean');
    expect(textOf(landmarks.querySelector('td'))).toBe('2.50 mm');
    expect(textOf(landmarks.querySelector('.note'))).toBe(
      'Measured at 2 landmarks only. Includes the error of placing them.',
    );
    const field = page.querySelector('[data-report="field"]')!;
    expect(textOf(field.querySelector('.about'))).toBe('Over the whole field.');
    expect(textOf(field.querySelector('td'))).toBe('5.10 mm');
  });

  it('says of a part that was not measured that it was not, and gives it no numbers', () => {
    const structures = read(CONTENT).querySelector('[data-report="structures"]')!;
    expect(structures.getAttribute('data-state')).toBe('none');
    expect(textOf(structures.querySelector('h2'))).toBe(
      'Structures: surface distances and overlap',
    );
    expect(textOf(structures.querySelector('p'))).toBe('Not measured.');
    expect(structures.querySelector('table')).toBeNull();
  });

  it('says whether identifiers are in it', () => {
    const without = read(CONTENT).querySelector('[data-report-identifiers]')!;
    expect(without.getAttribute('data-report-identifiers')).toBe('left-out');
    expect(textOf(without)).toBe(IDENTIFIERS_LEFT_OUT);
    const withThem = read({ ...CONTENT, identifiers: true }).querySelector(
      '[data-report-identifiers]',
    )!;
    expect(withThem.getAttribute('data-report-identifiers')).toBe('included');
    expect(textOf(withThem)).toBe(IDENTIFIERS_INCLUDED);
  });

  it('writes text from files as text, whatever it holds', () => {
    const hostile = '<img src=x onerror="alert(1)"> & "quoted" </td><script>alert(2)</script>';
    const page = read({
      ...CONTENT,
      images: [{ role: hostile, rows: [{ name: hostile, value: hostile }] }],
      registration: hostile,
      steps: [{ caption: hostile, rows: [{ name: hostile, value: hostile }] }],
      parts: [
        {
          key: 'x" onclick="alert(3)',
          title: hostile,
          section: {
            title: hostile,
            about: hostile,
            tables: [{ caption: hostile, rows: [{ name: hostile, value: hostile }] }],
            notes: [hostile],
          },
        },
      ],
      pictures: [{ caption: hostile, dataUrl: PNG }],
    });
    // Nothing of it became markup: no script, one picture (the real one), no handler.
    expect(page.querySelector('script')).toBeNull();
    expect(page.querySelectorAll('img')).toHaveLength(1);
    expect(page.querySelector('img')!.getAttribute('alt')).toBe(hostile);
    expect(page.querySelector('[onerror], [onclick]')).toBeNull();
    // And it is all there to be read.
    expect(textOf(page.querySelector('[data-report="registration"] .about'))).toBe(hostile);
    expect(textOf(page.querySelector('figcaption'))).toBe(hostile);
    expect(escapeHtml(`<a href="x" title='y'>&</a>`)).toBe(
      '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;',
    );
  });

  it('carries its pictures in itself, and takes nothing but a PNG for one', () => {
    const page = read({
      ...CONTENT,
      pictures: [
        { caption: 'Axial', dataUrl: PNG },
        { caption: 'From elsewhere', dataUrl: 'https://example.org/a.png' },
        { caption: 'Not a picture', dataUrl: 'data:text/html;base64,PHNjcmlwdD4=' },
        { caption: 'Broken out', dataUrl: `${PNG}" onerror="alert(1)` },
      ],
    });
    const pictures = [...page.querySelectorAll('figure')];
    expect(pictures.map((one) => textOf(one.querySelector('figcaption')))).toEqual(['Axial']);
    expect(pictures[0].querySelector('img')!.getAttribute('src')).toBe(PNG);
    expect(textOf(page.querySelector('[data-report="pictures"] .note'))).toContain(
      'Marks the viewer lays over a pane, such as arrows and landmarks, are not in them.',
    );
    // With none, it says so.
    const none = read({ ...CONTENT, pictures: [] }).querySelector('[data-report="pictures"]')!;
    expect(textOf(none.querySelector('p'))).toBe('No picture could be taken.');
    expect(none.querySelector('img')).toBeNull();
  });

  it('never says a number is good', () => {
    const page = read(CONTENT);
    const own = textOf(page.querySelector('h1')!.parentElement);
    expect(own).toContain('nothing that says whether a number is good');
    expect(reportHtml({ ...CONTENT, parts: [] })).not.toMatch(
      /pass|fail|accept|tolerance|within limits/i,
    );
  });

  it('is named for what it is and when it was made, and nothing of the patient', () => {
    expect(reportFilename(CONTENT.made)).toBe('registration-report-20261104-090507.html');
    expect(reportTime(CONTENT.made)).toBe('2026-11-04 09:05');
  });
});
