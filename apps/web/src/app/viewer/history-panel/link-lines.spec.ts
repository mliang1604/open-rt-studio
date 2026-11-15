/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { LANES_BELOW_PX, LANE_PX, bracketPath, laneY, lanesHeight } from './link-lines';

describe('the lines of registrations under the timeline', () => {
  it('take no room when there is none, and a lane each when there are some', () => {
    expect(lanesHeight(0)).toBe(0);
    expect(lanesHeight(1)).toBe(LANES_BELOW_PX + LANE_PX);
    expect(lanesHeight(3)).toBe(LANES_BELOW_PX + 3 * LANE_PX);
  });

  it('run each in a lane of its own, under the tiles and within the room kept', () => {
    const first = laneY(100, 0);
    const second = laneY(100, 1);
    expect(first).toBeGreaterThan(100);
    expect(second - first).toBe(LANE_PX);
    expect(laneY(100, 2)).toBeLessThan(100 + lanesHeight(3));
  });

  it('are a bracket: down from one end, along the lane, up to the other', () => {
    expect(bracketPath({ x: 10, y: 50 }, { x: 210.26, y: 20 }, 64.5)).toBe('M10 50V64.5H210.3V20');
  });
});
