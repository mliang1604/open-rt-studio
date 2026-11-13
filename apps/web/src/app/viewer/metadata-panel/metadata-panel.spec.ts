/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { TestBed } from '@angular/core/testing';
import type { DicomMetadata, RawTag } from '@open-rt-studio/dicom';

import { MetadataPanel } from './metadata-panel';

const TAGS: readonly RawTag[] = [
  { tag: '(0008,0060)', name: 'Modality', vr: 'CS', value: 'CT' },
  { tag: '(0009,0010)', name: null, vr: null, value: 'PRIVATE' },
];
const METADATA: DicomMetadata = {
  curated: [
    { title: 'Patient', fields: [{ label: 'Name', value: 'SYNTHETIC^PHANTOM' }] },
    { title: 'Series', fields: [{ label: 'Modality', value: 'CT' }] },
  ],
  rawTags: TAGS,
};

function render(rawTags: readonly RawTag[] = TAGS, filter = '') {
  const fixture = TestBed.createComponent(MetadataPanel);
  fixture.componentRef.setInput('metadata', METADATA);
  fixture.componentRef.setInput('rawTags', rawTags);
  fixture.componentRef.setInput('filter', filter);
  fixture.detectChanges();
  return { fixture, host: fixture.nativeElement as HTMLElement };
}

describe('MetadataPanel', () => {
  it('shows the curated groups with their fields', () => {
    const { host } = render();
    const groups = Array.from(host.querySelectorAll('.info-group h3')).map((h) => h.textContent);
    expect(groups).toEqual(['Patient', 'Series', 'Raw tags']);
    const first = host.querySelector('.info-row')!;
    expect(first.querySelector('dt')?.textContent).toBe('Name');
    expect(first.querySelector('dd')?.textContent).toBe('SYNTHETIC^PHANTOM');
  });

  it('lists the raw tags it is given, with a dash for an unknown name or VR', () => {
    const { host } = render();
    const rows = Array.from(host.querySelectorAll('.raw-tag')).map((row) =>
      Array.from(row.children).map((cell) => cell.textContent),
    );
    expect(rows).toEqual([
      ['(0008,0060)', 'Modality', 'CS', 'CT'],
      ['(0009,0010)', '—', '—', 'PRIVATE'],
    ]);
  });

  it('says so when no tag matches the filter', () => {
    const { host } = render([], 'zzz');
    expect(host.querySelector('.raw-tag-empty')?.textContent).toContain('No tags match “zzz”.');
    expect(host.querySelector<HTMLInputElement>('.info-search')!.value).toBe('zzz');
  });

  it('reports what is typed into the filter', () => {
    const { fixture, host } = render();
    const typed: string[] = [];
    fixture.componentInstance.filterChange.subscribe((text) => typed.push(text));
    const input = host.querySelector<HTMLInputElement>('.info-search')!;
    input.value = 'modality';
    input.dispatchEvent(new Event('input'));
    expect(typed).toEqual(['modality']);
  });

  it('asks to close on the Close button', () => {
    const { fixture, host } = render();
    let closed = 0;
    fixture.componentInstance.closed.subscribe(() => closed++);
    host.querySelector<HTMLButtonElement>('.info-close')!.click();
    expect(closed).toBe(1);
  });
});
