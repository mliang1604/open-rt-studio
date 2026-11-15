/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The lines that join the two ends of a registration on the timeline (#38):
// a bracket under the tiles, from the bottom of one end down to a lane of its
// own, along it, and up to the bottom of the other.

/** Where a line leaves an end: the middle of its bottom edge, in the timeline's own pixels. */
export interface Anchor {
  readonly x: number;
  readonly y: number;
}

/** The room each registration's lane takes under the tiles, in pixels. */
export const LANE_PX = 9;
/** The room between the tiles and the first lane. */
export const LANES_BELOW_PX = 5;

/** How much room the lanes of `count` registrations take under the tiles. */
export function lanesHeight(count: number): number {
  return count > 0 ? LANES_BELOW_PX + count * LANE_PX : 0;
}

/** The height a lane runs at: `below` is the bottom of the tiles. */
export function laneY(below: number, lane: number): number {
  return below + LANES_BELOW_PX + lane * LANE_PX + LANE_PX / 2;
}

const px = (value: number): string => String(Math.round(value * 10) / 10);

/** The bracket from one end to the other along a lane, as the `d` of an SVG path. */
export function bracketPath(a: Anchor, b: Anchor, y: number): string {
  return `M${px(a.x)} ${px(a.y)}V${px(y)}H${px(b.x)}V${px(b.y)}`;
}
