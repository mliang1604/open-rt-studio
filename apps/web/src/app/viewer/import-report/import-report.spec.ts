/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { TestBed } from '@angular/core/testing';

import { IMPORT_REPORT_LISTED, ImportReportCard, type ImportReport } from './import-report';

function render(report: ImportReport) {
  const fixture = TestBed.createComponent(ImportReportCard);
  fixture.componentRef.setInput('report', report);
  fixture.detectChanges();
  return fixture;
}

const skipped = (count: number) =>
  Array.from({ length: count }, (_, i) => ({
    name: `file-${i + 1}.dcm`,
    reason: `reason ${i + 1}`,
  }));

describe('ImportReportCard', () => {
  it('says how many of how many files were skipped', () => {
    const el = render({ total: 14, skipped: skipped(2) }).nativeElement as HTMLElement;
    expect(el.querySelector('h2')?.textContent).toBe('2 of 14 files were skipped');
    expect(el.getAttribute('role')).toBe('region');
    expect(el.getAttribute('aria-labelledby')).toBe('import-report-title');
    expect(el.querySelector('#import-report-title')?.getAttribute('role')).toBe('status');
  });

  it('uses the singular for one file', () => {
    const el = render({ total: 3, skipped: skipped(1) }).nativeElement as HTMLElement;
    expect(el.querySelector('h2')?.textContent).toBe('1 of 3 files was skipped');
  });

  it('names each skipped file with its reason, in order', () => {
    const el = render({
      total: 5,
      skipped: [
        {
          name: 'a.dcm',
          reason: 'Unsupported transfer syntax 1.2.840.10008.1.2.4.70, JPEG Lossless',
        },
        { name: 'b.dcm', reason: '12-bit JPEG is not supported' },
      ],
    }).nativeElement as HTMLElement;
    const rows = Array.from(el.querySelectorAll('li')).map((li) => [
      li.querySelector('.import-report-name')?.textContent,
      li.querySelector('.import-report-reason')?.textContent,
    ]);
    expect(rows).toEqual([
      ['a.dcm', 'Unsupported transfer syntax 1.2.840.10008.1.2.4.70, JPEG Lossless'],
      ['b.dcm', '12-bit JPEG is not supported'],
    ]);
    expect(el.textContent).toContain('The other files were imported.');
    expect(el.textContent).not.toContain('more');
  });

  it('lists the first few and counts the rest', () => {
    const el = render({ total: 40, skipped: skipped(IMPORT_REPORT_LISTED + 5) })
      .nativeElement as HTMLElement;
    expect(el.querySelectorAll('li')).toHaveLength(IMPORT_REPORT_LISTED);
    expect(el.textContent).toContain('and 5 more');
    expect(el.querySelector('h2')?.textContent).toBe(
      `${IMPORT_REPORT_LISTED + 5} of 40 files were skipped`,
    );
  });

  it('says nothing was imported when every file was skipped', () => {
    const el = render({ total: 2, skipped: skipped(2) }).nativeElement as HTMLElement;
    expect(el.querySelector('h2')?.textContent).toBe('2 of 2 files were skipped');
    expect(el.querySelector('.import-report-note')?.textContent?.trim()).toBe(
      'Nothing was imported.',
    );
  });

  it('emits dismissed when Dismiss is pressed', () => {
    const fixture = render({ total: 2, skipped: skipped(1) });
    const dismissed = vi.fn();
    fixture.componentInstance.dismissed.subscribe(dismissed);
    (fixture.nativeElement as HTMLElement).querySelector('button')!.click();
    expect(dismissed).toHaveBeenCalledTimes(1);
  });
});
