/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  addTimepoint,
  assignStudy,
  groupStudies,
  MAX_TIMEPOINT_NAME,
  MAX_TIMEPOINT_STUDIES,
  MAX_TIMEPOINTS,
  moveTimepoint,
  readTimepoints,
  removeTimepoint,
  renameTimepoint,
  timepointName,
  timepointOf,
  type Timepoint,
} from './timepoints';

const study = (studyUid: string, date: string | null) => ({ studyUid, date });
const STUDIES = [
  study('1.1', '20260105'),
  study('1.2', '20260105'),
  study('1.3', '20260316'),
  study('1.4', null),
];
const shape = (groups: ReturnType<typeof groupStudies<(typeof STUDIES)[number]>>) =>
  groups.map((group) => [
    group.id,
    group.name,
    group.automatic,
    group.studies.map((one) => one.studyUid),
  ]);

describe('studies in groups', () => {
  it('are grouped by study date when nobody has grouped them, undated last', () => {
    expect(shape(groupStudies(STUDIES, []))).toEqual([
      ['date:20260105', '2026-01-05', true, ['1.1', '1.2']],
      ['date:20260316', '2026-03-16', true, ['1.3']],
      ['date:', 'No date', true, ['1.4']],
    ]);
    expect(groupStudies([], [])).toEqual([]);
  });

  it('are in the timepoints that were made, in their order, and the rest by date after them', () => {
    const timepoints: Timepoint[] = [
      { id: 'b', name: 'Re-plan', studyUids: ['1.3'] },
      { id: 'a', name: 'Planning', studyUids: ['1.2'] },
      { id: 'c', name: 'Fraction 10', studyUids: [] },
    ];
    expect(shape(groupStudies(STUDIES, timepoints))).toEqual([
      ['b', 'Re-plan', false, ['1.3']],
      ['a', 'Planning', false, ['1.2']],
      // One that was made and holds nothing is there all the same.
      ['c', 'Fraction 10', false, []],
      ['date:20260105', '2026-01-05', true, ['1.1']],
      ['date:', 'No date', true, ['1.4']],
    ]);
  });

  it('are each in one group: the first timepoint that names a study has it, and a study that is not here is passed over', () => {
    const timepoints: Timepoint[] = [
      { id: 'a', name: 'A', studyUids: ['1.1', '9.9'] },
      { id: 'b', name: 'B', studyUids: ['1.1', '1.2'] },
    ];
    expect(shape(groupStudies(STUDIES.slice(0, 2), timepoints))).toEqual([
      ['a', 'A', false, ['1.1']],
      ['b', 'B', false, ['1.2']],
    ]);
  });
});

describe('changing timepoints', () => {
  const made: Timepoint[] = [
    { id: 'a', name: 'Planning', studyUids: ['1.1', '1.2'] },
    { id: 'b', name: 'Re-plan', studyUids: ['1.3'] },
  ];

  it('adds one at the end, with studies that leave where they were', () => {
    expect(addTimepoint(made, 'c', '  Fraction\n 10 ', ['1.2', '1.3'])).toEqual([
      { id: 'a', name: 'Planning', studyUids: ['1.1'] },
      { id: 'b', name: 'Re-plan', studyUids: [] },
      { id: 'c', name: 'Fraction 10', studyUids: ['1.2', '1.3'] },
    ]);
    expect(addTimepoint([], 'c', 'New')).toEqual([{ id: 'c', name: 'New', studyUids: [] }]);
  });

  it('renames one, to one line of a name’s length', () => {
    expect(renameTimepoint(made, 'b', ` ${'x'.repeat(80)} `)[1].name).toBe(
      'x'.repeat(MAX_TIMEPOINT_NAME),
    );
    expect(timepointName('a\tb\n c')).toBe('a b c');
    expect(renameTimepoint(made, 'zz', 'New')).toEqual(made);
  });

  it('moves one a place earlier or later, and leaves the ends where they are', () => {
    expect(moveTimepoint(made, 'b', -1).map((one) => one.id)).toEqual(['b', 'a']);
    expect(moveTimepoint(made, 'a', 1).map((one) => one.id)).toEqual(['b', 'a']);
    expect(moveTimepoint(made, 'a', -1)).toEqual(made);
    expect(moveTimepoint(made, 'b', 1)).toEqual(made);
    expect(moveTimepoint(made, 'zz', 1)).toEqual(made);
  });

  it('removes one, whose studies are then in none', () => {
    const left = removeTimepoint(made, 'a');
    expect(left).toEqual([made[1]]);
    expect(timepointOf(left, '1.1')).toBeNull();
  });

  it('puts a study in one and out of any other, or out of all', () => {
    const moved = assignStudy(made, '1.1', 'b');
    expect(moved).toEqual([
      { id: 'a', name: 'Planning', studyUids: ['1.2'] },
      { id: 'b', name: 'Re-plan', studyUids: ['1.3', '1.1'] },
    ]);
    expect(timepointOf(moved, '1.1')).toBe('b');
    expect(assignStudy(made, '1.4', 'a')[0].studyUids).toEqual(['1.1', '1.2', '1.4']);
    expect(assignStudy(made, '1.3', null)[1].studyUids).toEqual([]);
    // Put where it is, it is there once.
    expect(assignStudy(made, '1.1', 'a')[0].studyUids).toEqual(['1.2', '1.1']);
  });

  it('changes nothing of what it was given', () => {
    const frozen = Object.freeze(made.map((one) => Object.freeze({ ...one })));
    addTimepoint(frozen, 'c', 'C', ['1.1']);
    renameTimepoint(frozen, 'a', 'New');
    moveTimepoint(frozen, 'a', 1);
    removeTimepoint(frozen, 'a');
    assignStudy(frozen, '1.1', 'b');
    expect(frozen).toEqual(made);
  });
});

describe('timepoints read back from where they were kept', () => {
  it('are what was kept when it is well formed', () => {
    const kept = [
      { id: 'a', name: 'Planning', studyUids: ['1.1', '1.2'] },
      { id: 'b-2', name: '', studyUids: [] },
    ];
    expect(readTimepoints(JSON.parse(JSON.stringify(kept)))).toEqual(kept);
  });

  it('are nothing for what is no list', () => {
    for (const value of [null, undefined, 'x', 7, {}, { timepoints: [] }]) {
      expect(readTimepoints(value)).toBeNull();
    }
    expect(readTimepoints([])).toEqual([]);
  });

  it('leave out what is not a timepoint, and what a timepoint may not have', () => {
    expect(
      readTimepoints([
        null,
        'x',
        { id: 'a b', name: 'Bad id', studyUids: [] },
        { id: 'a', name: 7, studyUids: [] },
        {
          id: 'a',
          name: ` ${'n'.repeat(80)}\n`,
          studyUids: ['1.1', 'not-a-uid', 7, '1.1'],
          more: 1,
        },
        // The same id again, and a study that another has.
        { id: 'a', name: 'Twice', studyUids: [] },
        { id: 'b', name: 'B', studyUids: ['1.1', '1.2'] },
        { id: 'c', name: 'C', studyUids: 'none' },
      ]),
    ).toEqual([
      { id: 'a', name: 'n'.repeat(MAX_TIMEPOINT_NAME), studyUids: ['1.1'] },
      { id: 'b', name: 'B', studyUids: ['1.2'] },
      { id: 'c', name: 'C', studyUids: [] },
    ]);
  });

  it('stop at as many timepoints and studies as a patient may have', () => {
    const many = Array.from({ length: MAX_TIMEPOINTS + 5 }, (_, at) => ({
      id: `t${at}`,
      name: 'T',
      studyUids: [],
    }));
    expect(readTimepoints(many)).toHaveLength(MAX_TIMEPOINTS);
    const full = [
      {
        id: 'a',
        name: 'A',
        studyUids: Array.from({ length: MAX_TIMEPOINT_STUDIES + 5 }, (_, at) => `1.2.${at}`),
      },
    ];
    expect(readTimepoints(full)![0].studyUids).toHaveLength(MAX_TIMEPOINT_STUDIES);
  });
});
