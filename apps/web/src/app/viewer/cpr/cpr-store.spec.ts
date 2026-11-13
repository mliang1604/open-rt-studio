/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { TestBed } from '@angular/core/testing';

import { CPR_HALF_WIDTH_RANGE, CprStore } from './cpr-store';

function store(): CprStore {
  TestBed.configureTestingModule({ providers: [CprStore] });
  return TestBed.inject(CprStore);
}

describe('CprStore', () => {
  it('starts with no path and the tool off', () => {
    const s = store();
    expect(s.points()).toEqual([]);
    expect(s.hasPath()).toBe(false);
    expect(s.drawing()).toBe(false);
  });

  it('builds the path in the order points are added', () => {
    const s = store();
    s.add([0, 0, 0]);
    expect(s.hasPath()).toBe(false); // one point is not a path
    s.add([10, 0, 0]);
    s.add([20, 5, 0]);
    expect(s.points()).toEqual([
      [0, 0, 0],
      [10, 0, 0],
      [20, 5, 0],
    ]);
    expect(s.hasPath()).toBe(true);
  });

  it('moves and removes single points without touching the others', () => {
    const s = store();
    s.add([0, 0, 0]);
    s.add([10, 0, 0]);
    s.add([20, 0, 0]);
    s.move(1, [10, 7, 2]);
    expect(s.points()[1]).toEqual([10, 7, 2]);
    s.remove(0);
    expect(s.points()).toEqual([
      [10, 7, 2],
      [20, 0, 0],
    ]);
  });

  it('ignores an index outside the path', () => {
    const s = store();
    s.add([0, 0, 0]);
    const before = s.points();
    s.move(5, [1, 1, 1]);
    s.move(-1, [1, 1, 1]);
    s.remove(3);
    expect(s.points()).toEqual(before);
  });

  it('never mutates a previous value of the path', () => {
    const s = store();
    s.add([0, 0, 0]);
    const first = s.points();
    s.add([1, 1, 1]);
    expect(first).toEqual([[0, 0, 0]]);
    expect(s.points()).not.toBe(first);
  });

  it('keeps the cut settings within their limits', () => {
    const s = store();
    s.setHalfWidth(1);
    expect(s.halfWidthMm()).toBe(CPR_HALF_WIDTH_RANGE.min);
    s.setHalfWidth(1000);
    expect(s.halfWidthMm()).toBe(CPR_HALF_WIDTH_RANGE.max);
    s.setHalfWidth(Number.NaN);
    expect(s.halfWidthMm()).toBe(CPR_HALF_WIDTH_RANGE.max);
    s.setAngle(270);
    expect(s.angleDeg()).toBe(180);
    s.setAngle(-45);
    expect(s.angleDeg()).toBe(-45);
  });

  it('clears the path but keeps drawing, and resets everything', () => {
    const s = store();
    s.drawing.set(true);
    s.add([0, 0, 0]);
    s.add([1, 0, 0]);
    s.setHalfWidth(50);
    s.clearPath();
    expect(s.points()).toEqual([]);
    expect(s.drawing()).toBe(true);
    expect(s.halfWidthMm()).toBe(50);
    s.add([0, 0, 0]);
    s.reset();
    expect(s.points()).toEqual([]);
    expect(s.drawing()).toBe(false);
    expect(s.halfWidthMm()).toBe(CPR_HALF_WIDTH_RANGE.initial);
    expect(s.angleDeg()).toBe(0);
  });
});
