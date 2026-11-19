/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// What the contouring tools remember (#346): the settings a tool was last
// used with for a structure of a name on a modality, so that "Heart" on CT
// starts the next time from where it ended. Counting, not a model: the last
// values used, and nothing derived from them
// (docs/learning-from-corrections.md).
//
// A structure's name is the user's own text, and may say something of a
// patient. So this is kept in the browser's profile only (for the desktop
// application, its own), is never sent to a server and never logged, and
// can be forgotten in one step.

import { Injectable, computed, signal, type WritableSignal } from '@angular/core';

/** localStorage key (versioned inside) under which the remembered settings are kept. */
export const REMEMBERED_SETTINGS_STORAGE_KEY = 'open-rt-studio.tool-settings';

/** No more structures (a name on a modality) than this; the one used longest ago goes first. */
export const REMEMBERED_STRUCTURES_AT_MOST = 200;

/** A structure's name is kept up to this length: what DICOM allows a name. */
const NAME_AT_MOST = 64;
/** A name of a tool, of a setting or of a choice: short and plain, so that nothing else can be put there. */
const WORD = /^[a-z0-9][a-z0-9-]{0,39}$/i;

/** A value a setting can have: a number, or one of a few words. */
export type SettingValue = number | string;

/** A setting of a tool that is remembered: how it is read, written and checked. */
export interface RememberedSetting {
  /** Its name among the tool's settings, which is what it is kept by. */
  readonly key: string;
  /** What it is now; null while what is typed is no value. */
  read(): SettingValue | null;
  write(value: SettingValue): void;
  /** Whether a value that was kept can still be one: what is kept is not trusted. */
  accepts(value: unknown): value is SettingValue;
  /** The tool's own default. */
  readonly initial: SettingValue;
}

/** A setting that is a number, at least `min` and at most `max` where given. */
export function numberSetting(
  key: string,
  held: WritableSignal<number | null>,
  range: { readonly min?: number; readonly max?: number } = {},
): RememberedSetting {
  const initial = held();
  if (initial === null) throw new Error(`The setting ${key} has no default.`);
  return {
    key,
    read: () => held(),
    write: (value) => held.set(value as number),
    accepts: (value): value is number =>
      typeof value === 'number' &&
      Number.isFinite(value) &&
      (range.min === undefined || value >= range.min) &&
      (range.max === undefined || value <= range.max),
    initial,
  };
}

/** A setting that is a number or nothing (a bound that may be left open). Nothing is kept as `none`. */
export function optionalNumberSetting(
  key: string,
  held: WritableSignal<number | null>,
): RememberedSetting {
  const NONE = 'none';
  const initial = held();
  return {
    key,
    read: () => held() ?? NONE,
    write: (value) => held.set(value === NONE ? null : (value as number)),
    accepts: (value): value is SettingValue =>
      value === NONE || (typeof value === 'number' && Number.isFinite(value)),
    initial: initial ?? NONE,
  };
}

/** A setting that is one of a few words. */
export function choiceSetting<T extends string>(
  key: string,
  held: WritableSignal<T>,
  choices: readonly T[],
): RememberedSetting {
  return {
    key,
    read: () => held(),
    write: (value) => held.set(value as T),
    accepts: (value): value is T => choices.includes(value as T),
    initial: held(),
  };
}

/** What is remembered for one structure on one modality. */
export interface RememberedStructure {
  /** The name as the user last wrote it, for showing. */
  readonly structure: string;
  readonly modality: string;
  /** When it was last used, as a count that only grows: the order, and no time of day. */
  readonly used: number;
  /** For each tool, by its id: its settings, by their keys. */
  readonly tools: Readonly<Record<string, Readonly<Record<string, SettingValue>>>>;
}

/** Everything remembered, by {@link rememberedKey}. */
export type Remembered = Readonly<Record<string, RememberedStructure>>;

/** A name the application gave a structure that the user did not name. */
const UNNAMED = /^structure \d+$/;

/**
 * What a structure on a modality is remembered by: its name without regard
 * to case or to spacing, and the modality. Null for what is not remembered:
 * no name, no modality, or a name the application gave (`Structure 3`),
 * which says nothing of what the structure is.
 */
export function rememberedKey(structure: string, modality: string | null): string | null {
  const name = structure.trim().replace(/\s+/g, ' ').slice(0, NAME_AT_MOST).toLowerCase();
  const kind = (modality ?? '').trim().toUpperCase();
  if (name === '' || UNNAMED.test(name) || !/^[A-Z0-9]{1,16}$/.test(kind)) return null;
  return `${kind}\n${name}`;
}

/** What was kept, as far as it can be believed; nothing for what cannot be read. */
export function parseRemembered(raw: string | null): Remembered {
  if (raw === null) return {};
  let read: unknown;
  try {
    read = JSON.parse(raw);
  } catch {
    return {};
  }
  const kept = read as { version?: unknown; structures?: unknown } | null;
  if (kept?.version !== 1 || !Array.isArray(kept.structures)) return {};
  const out: Record<string, RememberedStructure> = {};
  for (const one of kept.structures as unknown[]) {
    const entry = one as Partial<Record<keyof RememberedStructure, unknown>> | null;
    if (typeof entry?.structure !== 'string' || typeof entry.modality !== 'string') continue;
    const key = rememberedKey(entry.structure, entry.modality);
    if (key === null || typeof entry.tools !== 'object' || entry.tools === null) continue;
    const tools: Record<string, Record<string, SettingValue>> = {};
    for (const [tool, settings] of Object.entries(entry.tools)) {
      if (!WORD.test(tool) || typeof settings !== 'object' || settings === null) continue;
      const values: Record<string, SettingValue> = {};
      for (const [name, value] of Object.entries(settings as Record<string, unknown>)) {
        const plain =
          (typeof value === 'number' && Number.isFinite(value)) ||
          (typeof value === 'string' && WORD.test(value));
        if (WORD.test(name) && plain) values[name] = value as SettingValue;
      }
      if (Object.keys(values).length > 0) tools[tool] = values;
    }
    if (Object.keys(tools).length === 0) continue;
    out[key] = {
      structure: entry.structure.trim().replace(/\s+/g, ' ').slice(0, NAME_AT_MOST),
      modality: entry.modality.trim().toUpperCase(),
      used: typeof entry.used === 'number' && Number.isFinite(entry.used) ? entry.used : 0,
      tools,
    };
  }
  return atMost(out);
}

/** As it is kept. */
export function serializeRemembered(remembered: Remembered): string {
  return JSON.stringify({ version: 1, structures: Object.values(remembered) });
}

/** No more than there may be: those used longest ago are let go. */
function atMost(remembered: Record<string, RememberedStructure>): Remembered {
  const keys = Object.keys(remembered);
  if (keys.length <= REMEMBERED_STRUCTURES_AT_MOST) return remembered;
  const newest = keys
    .sort((a, b) => remembered[b].used - remembered[a].used)
    .slice(0, REMEMBERED_STRUCTURES_AT_MOST);
  return Object.fromEntries(newest.map((key) => [key, remembered[key]]));
}

/**
 * The settings the contouring tools remember, by structure and modality
 * (#346), kept in the browser. It knows nothing of the tools: a tool's
 * settings are given and taken as they are named, and whoever takes them
 * checks them again (`RememberedSetting.accepts`).
 */
@Injectable()
export class RememberedToolSettings {
  private readonly kept = signal<Remembered>(parseRemembered(readRaw()));

  /** How many structures (a name on a modality) something is remembered for. */
  readonly count = computed(() => Object.keys(this.kept()).length);

  /** What a tool was last used with for a structure on a modality; null for nothing. */
  recall(
    tool: string,
    structure: string,
    modality: string | null,
  ): Readonly<Record<string, SettingValue>> | null {
    const key = rememberedKey(structure, modality);
    return key === null ? null : (this.kept()[key]?.tools[tool] ?? null);
  }

  /**
   * Keep what a tool was used with. False, and nothing is kept, for a
   * structure that is not remembered ({@link rememberedKey}).
   */
  remember(
    tool: string,
    structure: string,
    modality: string | null,
    settings: Readonly<Record<string, SettingValue>>,
  ): boolean {
    const key = rememberedKey(structure, modality);
    if (key === null || !WORD.test(tool) || Object.keys(settings).length === 0) return false;
    const now = this.kept();
    const used = Math.max(0, ...Object.values(now).map((one) => one.used)) + 1;
    this.set(
      atMost({
        ...now,
        [key]: {
          structure: structure.trim().replace(/\s+/g, ' ').slice(0, NAME_AT_MOST),
          modality: modality!.trim().toUpperCase(),
          used,
          tools: { ...now[key]?.tools, [tool]: { ...settings } },
        },
      }),
    );
    return true;
  }

  /** Forget what one tool remembers for a structure on a modality. */
  forget(tool: string, structure: string, modality: string | null): void {
    const key = rememberedKey(structure, modality);
    const entry = key === null ? undefined : this.kept()[key];
    if (key === null || !entry?.tools[tool]) return;
    const tools = Object.fromEntries(Object.entries(entry.tools).filter(([id]) => id !== tool));
    const rest = Object.fromEntries(Object.entries(this.kept()).filter(([one]) => one !== key));
    this.set(Object.keys(tools).length > 0 ? { ...rest, [key]: { ...entry, tools } } : rest);
  }

  /** Forget everything, here and where it is kept. */
  forgetAll(): void {
    this.kept.set({});
    try {
      localStorage.removeItem(REMEMBERED_SETTINGS_STORAGE_KEY);
    } catch {
      // No storage, or none that may be written: nothing was kept there.
    }
  }

  private set(next: Remembered): void {
    this.kept.set(next);
    try {
      localStorage.setItem(REMEMBERED_SETTINGS_STORAGE_KEY, serializeRemembered(next));
    } catch {
      // No storage, or it is full: remembered until the page is closed.
    }
  }
}

function readRaw(): string | null {
  try {
    return localStorage.getItem(REMEMBERED_SETTINGS_STORAGE_KEY);
  } catch {
    return null;
  }
}
