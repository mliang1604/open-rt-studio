/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';

import {
  REMEMBERED_SETTINGS_STORAGE_KEY,
  REMEMBERED_STRUCTURES_AT_MOST,
  RememberedToolSettings,
  choiceSetting,
  numberSetting,
  optionalNumberSetting,
  parseRemembered,
  rememberedKey,
  serializeRemembered,
} from './remembered-settings';

function store(): RememberedToolSettings {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ providers: [RememberedToolSettings] });
  return TestBed.inject(RememberedToolSettings);
}

describe('what the contouring tools remember (#346)', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    TestBed.resetTestingModule();
    localStorage.clear();
  });

  it('knows a structure by its name and the modality, whatever the case and the spacing', () => {
    expect(rememberedKey('Heart', 'CT')).toBe(rememberedKey('  heart ', 'ct'));
    expect(rememberedKey('Left  Lung', 'CT')).toBe(rememberedKey('left lung', 'CT'));
    expect(rememberedKey('Heart', 'CT')).not.toBe(rememberedKey('Heart', 'MR'));
    expect(rememberedKey('Heart', 'CT')).not.toBe(rememberedKey('Hearts', 'CT'));
  });

  it('remembers nothing for a structure nobody named, or without a name or a modality', () => {
    for (const [name, modality] of [
      ['Structure 3', 'CT'],
      ['structure 12', 'CT'],
      ['', 'CT'],
      ['   ', 'CT'],
      ['Heart', null],
      ['Heart', ''],
      ['Heart', 'not a modality'],
    ] as const) {
      expect(rememberedKey(name, modality), `${name} on ${modality}`).toBeNull();
    }
    // A name that only begins like one the application gives is the user's own.
    expect(rememberedKey('Structure 3 boost', 'CT')).not.toBeNull();
    const memory = store();
    expect(memory.remember('wand', 'Structure 3', 'CT', { tolerance: 30 })).toBe(false);
    expect(memory.count()).toBe(0);
    expect(localStorage.getItem(REMEMBERED_SETTINGS_STORAGE_KEY)).toBeNull();
  });

  it('gives back what a tool was last used with, for that structure on that modality only', () => {
    const memory = store();
    expect(memory.recall('wand', 'Heart', 'CT')).toBeNull();
    expect(memory.remember('wand', 'Heart', 'CT', { tolerance: 30, dimension: '3d' })).toBe(true);
    expect(memory.recall('wand', 'heart', 'CT')).toEqual({ tolerance: 30, dimension: '3d' });
    expect(memory.recall('wand', 'Heart', 'MR')).toBeNull();
    expect(memory.recall('wand', 'Lung', 'CT')).toBeNull();
    expect(memory.recall('quick', 'Heart', 'CT')).toBeNull();
    // The last use is what counts, and another tool's settings are beside it.
    memory.remember('wand', 'HEART', 'CT', { tolerance: 12 });
    memory.remember('quick', 'Heart', 'CT', { 'margin-mm': 20 });
    expect(memory.recall('wand', 'Heart', 'CT')).toEqual({ tolerance: 12 });
    expect(memory.recall('quick', 'Heart', 'CT')).toEqual({ 'margin-mm': 20 });
    expect(memory.count()).toBe(1);
  });

  it('is there after a restart: kept in the browser, and read again', () => {
    store().remember('wand', 'Heart', 'CT', { tolerance: 30 });
    const again = store();
    expect(again.recall('wand', 'Heart', 'CT')).toEqual({ tolerance: 30 });
    expect(again.count()).toBe(1);
  });

  it('forgets one tool for one structure, or everything in one step', () => {
    const memory = store();
    memory.remember('wand', 'Heart', 'CT', { tolerance: 30 });
    memory.remember('quick', 'Heart', 'CT', { beta: 2 });
    memory.remember('wand', 'Lung', 'CT', { tolerance: 200 });
    memory.forget('wand', 'Heart', 'CT');
    expect(memory.recall('wand', 'Heart', 'CT')).toBeNull();
    expect(memory.recall('quick', 'Heart', 'CT')).toEqual({ beta: 2 });
    memory.forget('quick', 'Heart', 'CT');
    expect(memory.count()).toBe(1);

    memory.forgetAll();
    expect(memory.count()).toBe(0);
    expect(memory.recall('wand', 'Lung', 'CT')).toBeNull();
    expect(localStorage.getItem(REMEMBERED_SETTINGS_STORAGE_KEY)).toBeNull();
    expect(store().count()).toBe(0);
  });

  it('keeps no more structures than it may, and lets go of those used longest ago', () => {
    const memory = store();
    for (let n = 0; n < REMEMBERED_STRUCTURES_AT_MOST + 5; n++) {
      memory.remember('wand', `Organ ${n}`, 'CT', { tolerance: n });
    }
    expect(memory.count()).toBe(REMEMBERED_STRUCTURES_AT_MOST);
    expect(memory.recall('wand', 'Organ 0', 'CT')).toBeNull();
    expect(memory.recall('wand', 'Organ 4', 'CT')).toBeNull();
    expect(memory.recall('wand', 'Organ 5', 'CT')).toEqual({ tolerance: 5 });
    // Used again, an old one is the newest.
    memory.remember('wand', 'Organ 5', 'CT', { tolerance: 55 });
    memory.remember('wand', 'One more', 'CT', { tolerance: 1 });
    expect(memory.recall('wand', 'Organ 5', 'CT')).toEqual({ tolerance: 55 });
    expect(memory.recall('wand', 'Organ 6', 'CT')).toBeNull();
  });

  it('believes of what was kept only what can be a setting', () => {
    expect(parseRemembered(null)).toEqual({});
    expect(parseRemembered('not json')).toEqual({});
    expect(parseRemembered('{"version":2,"structures":[]}')).toEqual({});
    const read = parseRemembered(
      JSON.stringify({
        version: 1,
        structures: [
          {
            structure: 'Heart',
            modality: 'CT',
            used: 3,
            tools: {
              wand: { tolerance: 30, dimension: '3d', nested: { a: 1 }, text: 'two words' },
              '<script>': { tolerance: 1 },
              quick: 'no settings',
            },
          },
          { structure: 'Structure 1', modality: 'CT', used: 4, tools: { wand: { tolerance: 1 } } },
          { structure: 'Lung', modality: 'CT', used: 5, tools: {} },
          { structure: 7, modality: 'CT', tools: { wand: { tolerance: 1 } } },
          null,
        ],
      }),
    );
    expect(Object.values(read)).toEqual([
      {
        structure: 'Heart',
        modality: 'CT',
        used: 3,
        tools: { wand: { tolerance: 30, dimension: '3d' } },
      },
    ]);
    expect(parseRemembered(serializeRemembered(read))).toEqual(read);
  });

  it('works where the browser keeps nothing', () => {
    const real = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')!;
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get: () => {
        throw new Error('no storage');
      },
    });
    try {
      const memory = store();
      expect(memory.remember('wand', 'Heart', 'CT', { tolerance: 30 })).toBe(true);
      expect(memory.recall('wand', 'Heart', 'CT')).toEqual({ tolerance: 30 });
      memory.forgetAll();
      expect(memory.count()).toBe(0);
    } finally {
      Object.defineProperty(globalThis, 'localStorage', real);
    }
  });
});

describe('a setting that is remembered (#346)', () => {
  it('is a number within its bounds, with the default it had when it was declared', () => {
    const held = signal<number | null>(50);
    const setting = numberSetting('tolerance', held, { min: 0, max: 100 });
    expect(setting.initial).toBe(50);
    held.set(30);
    expect(setting.read()).toBe(30);
    for (const wrong of [-1, 101, Number.NaN, Infinity, '30', null, undefined, {}]) {
      expect(setting.accepts(wrong), String(wrong)).toBe(false);
    }
    expect(setting.accepts(0)).toBe(true);
    setting.write(7);
    expect(held()).toBe(7);
    expect(() => numberSetting('none', signal<number | null>(null))).toThrow();
  });

  it('is a bound that may be left open', () => {
    const held = signal<number | null>(null);
    const setting = optionalNumberSetting('min', held);
    expect(setting.initial).toBe('none');
    expect(setting.read()).toBe('none');
    setting.write(-200);
    expect(held()).toBe(-200);
    expect(setting.read()).toBe(-200);
    setting.write('none');
    expect(held()).toBeNull();
    expect(setting.accepts('none')).toBe(true);
    expect(setting.accepts('open')).toBe(false);
    expect(setting.accepts(Number.NaN)).toBe(false);
  });

  it('is one of a few words', () => {
    const held = signal<'2d' | '3d'>('2d');
    const setting = choiceSetting('dimension', held, ['2d', '3d']);
    expect(setting.initial).toBe('2d');
    expect(setting.accepts('3d')).toBe(true);
    expect(setting.accepts('4d')).toBe(false);
    expect(setting.accepts(3)).toBe(false);
    setting.write('3d');
    expect(held()).toBe('3d');
  });
});
