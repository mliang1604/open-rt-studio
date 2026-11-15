/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { Injectable, computed, signal } from '@angular/core';
import {
  GENERIC_ALPHA_BETA_DEFAULTS,
  alphaBetaEntries,
  alphaBetaSettingsOf,
  isAlphaBeta,
  parseAlphaBetaSettings,
  serializeAlphaBetaSettings,
  type AlphaBetaDefault,
  type AlphaBetaEntry,
  type AlphaBetaSettings,
  type Roi,
} from '@open-rt-studio/dicom';

/** localStorage key (versioned inside) under which the user's rules and outside value are kept. */
export const ALPHA_BETA_STORAGE_KEY = 'open-rt-studio.alpha-beta';

/** No more rules than this. */
export const ALPHA_BETA_RULES_AT_MOST = 64;

/** A structure in the list of priority, with its α/β and where that came from. */
export interface AlphaBetaLine extends AlphaBetaEntry {
  /** Whether the user gave the value (or took it away); false when a rule did, or none is for it. */
  readonly set: boolean;
  /** What the rules give this structure; null when no rule is for it. */
  readonly byRule: number | null;
}

/**
 * The α/β values a summation converts with (#100): the structures in the
 * order of their priority, each with its value; the value outside every
 * structure; and the user's rules for the values structures start with.
 *
 * The rules and the outside value are the user's own and are kept in the
 * browser: they hold what the user typed (a structure's type or name, a
 * number) and nothing of a patient. The list of structures is of the
 * structure set in hand and is kept only while the viewer is open; a
 * summation keeps it with its own settings ({@link settings},
 * {@link restore}).
 */
@Injectable()
export class AlphaBetaStore {
  private readonly rois = signal<readonly Roi[]>([]);
  /** The structures the user has moved, first to last; the rest follow in the set's order. */
  private readonly order = signal<readonly Roi[]>([]);
  /** The values the user gave: null for a structure they left without one. */
  private readonly values = signal<ReadonlyMap<Roi, number | null>>(new Map());

  /** The rules that give structures their starting values. */
  readonly defaults = signal<readonly AlphaBetaDefault[]>(GENERIC_ALPHA_BETA_DEFAULTS);
  /** The α/β outside every structure, in gray; null for none. */
  readonly outsideGy = signal<number | null>(null);

  /** The structures that bound an area, in the order of their priority. */
  readonly lines = computed<AlphaBetaLine[]>(() => {
    const [defaults, order, values] = [this.defaults(), this.order(), this.values()];
    // Every structure that can be filled, in the set's order, by the rules.
    const fillable = alphaBetaEntries(this.rois(), { defaults, structures: [], outsideGy: null });
    const moved = order.flatMap((roi) => fillable.filter((one) => one.roi === roi));
    const rest = fillable.filter((one) => !order.includes(one.roi));
    return [...moved, ...rest].map(({ roi, alphaBetaGy }) => ({
      roi,
      alphaBetaGy: values.has(roi) ? values.get(roi)! : alphaBetaGy,
      set: values.has(roi),
      byRule: alphaBetaGy,
    }));
  });

  /** How many structures have no value, and take no part. */
  readonly without = computed(() => this.lines().filter((one) => one.alphaBetaGy === null).length);

  /** Everything as it would be kept with a summation's settings. */
  readonly settings = computed<AlphaBetaSettings>(() =>
    alphaBetaSettingsOf(this.lines(), this.defaults(), this.outsideGy()),
  );

  constructor() {
    const kept = parseAlphaBetaSettings(readRaw());
    if (kept) {
      this.defaults.set(kept.defaults.slice(0, ALPHA_BETA_RULES_AT_MOST));
      this.outsideGy.set(kept.outsideGy);
    }
  }

  /**
   * The structures to give values to. What the user said of a structure
   * that is still among them stays; what they said of the others goes.
   */
  setStructures(rois: readonly Roi[]): void {
    this.rois.set(rois);
    this.order.update((order) => order.filter((roi) => rois.includes(roi)));
    this.values.update((values) => new Map([...values].filter(([roi]) => rois.includes(roi))));
  }

  /**
   * Give a structure a value, or leave it without one (null). False, and
   * nothing changes, for what is not a number of gray more than 0.
   */
  setValue(roi: Roi, alphaBetaGy: number | null): boolean {
    if (alphaBetaGy !== null && !isAlphaBeta(alphaBetaGy)) return false;
    this.values.update((values) => new Map(values).set(roi, alphaBetaGy));
    return true;
  }

  /** Give a structure back to the rules. */
  clearValue(roi: Roi): void {
    this.values.update((values) => {
      const next = new Map(values);
      next.delete(roi);
      return next;
    });
  }

  /** Move a structure one place up the priority (`-1`) or down (`1`). */
  move(roi: Roi, by: -1 | 1): void {
    const now = this.lines().map((one) => one.roi);
    const from = now.indexOf(roi);
    const to = from + by;
    if (from < 0 || to < 0 || to >= now.length) return;
    [now[from], now[to]] = [now[to], now[from]];
    this.order.set(now);
  }

  /** The outside value; null for none. False for what is no ratio. */
  setOutside(alphaBetaGy: number | null): boolean {
    if (alphaBetaGy !== null && !isAlphaBeta(alphaBetaGy)) return false;
    this.outsideGy.set(alphaBetaGy);
    this.keep();
    return true;
  }

  /**
   * Add a rule, before the others of its kind for the same structures so
   * that it is the one followed. Says why not, when it is not taken.
   */
  addDefault(rule: AlphaBetaDefault): string | null {
    const match = rule.match.trim();
    if (!match) return rule.by === 'name' ? 'Type a structure name.' : 'Type a structure type.';
    if (!isAlphaBeta(rule.alphaBetaGy)) return 'The α/β must be a number of gray more than 0.';
    const others = this.defaults().filter(
      (one) => !(one.by === rule.by && one.match.trim().toLowerCase() === match.toLowerCase()),
    );
    if (others.length >= ALPHA_BETA_RULES_AT_MOST) {
      return `No more than ${ALPHA_BETA_RULES_AT_MOST} rules: take one away first.`;
    }
    this.defaults.set([{ by: rule.by, match, alphaBetaGy: rule.alphaBetaGy }, ...others]);
    this.keep();
    return null;
  }

  /** Give the rule at `index` another value. False for what is no ratio. */
  setDefaultValue(index: number, alphaBetaGy: number): boolean {
    if (!isAlphaBeta(alphaBetaGy)) return false;
    this.defaults.update((rules) =>
      rules.map((rule, at) => (at === index ? { ...rule, alphaBetaGy } : rule)),
    );
    this.keep();
    return true;
  }

  removeDefault(index: number): void {
    this.defaults.update((rules) => rules.filter((_, at) => at !== index));
    this.keep();
  }

  /** The generic rules again, in place of the user's. */
  resetDefaults(): void {
    this.defaults.set(GENERIC_ALPHA_BETA_DEFAULTS);
    this.keep();
  }

  /**
   * Take a summation's settings as they were kept: its rules, its outside
   * value, and its structures in their order with their values, for those
   * of them that are among the structures in hand.
   */
  restore(settings: AlphaBetaSettings): void {
    this.defaults.set(settings.defaults.slice(0, ALPHA_BETA_RULES_AT_MOST));
    this.outsideGy.set(settings.outsideGy);
    const named = (roi: Roi): boolean =>
      settings.structures.some((one) => one.number === roi.number && one.name === roi.name);
    const entries = alphaBetaEntries(this.rois(), settings).filter((one) => named(one.roi));
    this.order.set(entries.map((one) => one.roi));
    this.values.set(new Map(entries.map((one) => [one.roi, one.alphaBetaGy])));
    this.keep();
  }

  /** Keep the rules and the outside value, and nothing of the structures. */
  private keep(): void {
    writeRaw(
      serializeAlphaBetaSettings({
        defaults: this.defaults(),
        structures: [],
        outsideGy: this.outsideGy(),
      }),
    );
  }
}

function readRaw(): string | null {
  try {
    return localStorage.getItem(ALPHA_BETA_STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeRaw(value: string): void {
  try {
    localStorage.setItem(ALPHA_BETA_STORAGE_KEY, value);
  } catch {
    // Storage is unavailable; the signals still serve this session.
  }
}
