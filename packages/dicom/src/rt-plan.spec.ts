/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';

import { readInstanceHeader } from './instance-header.js';
import { formatDicomDate } from './metadata.js';
import { concat, decimals, element, integers, p10File, sequence, text, uid } from './p10-encode.js';
import {
  parseRtPlan,
  PLAN_ITEMS_AT_MOST,
  PLAN_TEXT_AT_MOST,
  planBrief,
  planGroup,
  planSummary,
  planSummaryText,
  RTPLAN_SOP_CLASSES,
  type PlanSummary,
} from './rt-plan.js';
import type { Roi, StructureSet } from './types.js';

const [RTPLAN, RT_ION_PLAN] = RTPLAN_SOP_CLASSES;

interface Group {
  number?: number;
  fractions?: number | null;
  /** Beam Dose of each beam the group names; null for a beam that gives none. */
  beamDoses?: (number | null)[];
  numberOfBeams?: number;
}
interface Reference {
  number?: number;
  structureType?: string;
  type?: string;
  description?: string;
  roi?: number;
  prescription?: number | string;
}

/** An RT Plan with these fraction groups and dose references, and what else is given. */
function plan(
  more: {
    groups?: Group[];
    references?: Reference[];
    sopClass?: string;
    modality?: string | null;
    structureSets?: string[];
    whole?: boolean;
  } = {},
): ArrayBuffer {
  const { groups = [], references = [], sopClass = RTPLAN, modality = 'RTPLAN' } = more;
  const whole = more.whole ?? true;
  const body = concat([
    ...(modality === null ? [] : [element(0x0008, 0x0060, 'CS', text(modality))]),
    element(0x0008, 0x0018, 'UI', uid('1.2.3.90')),
    element(0x0010, 0x0020, 'LO', text('SYN-0001')),
    element(0x0020, 0x0052, 'UI', uid('1.2.3.50')),
    ...(whole
      ? [
          element(0x300a, 0x0002, 'SH', text('Plan A')),
          element(0x300a, 0x0003, 'LO', text('Lung, left')),
          element(0x300a, 0x0004, 'ST', text('Three fields')),
          element(0x300a, 0x0006, 'DA', text('20260107')),
          element(0x300a, 0x000a, 'CS', text('curative')),
        ]
      : []),
    ...(references.length === 0
      ? []
      : [
          sequence(
            0x300a,
            0x0010,
            references.map((one) =>
              concat([
                ...(one.number === undefined
                  ? []
                  : [element(0x300a, 0x0012, 'IS', integers([one.number]))]),
                ...(one.structureType
                  ? [element(0x300a, 0x0014, 'CS', text(one.structureType))]
                  : []),
                ...(one.description ? [element(0x300a, 0x0016, 'LO', text(one.description))] : []),
                ...(one.type ? [element(0x300a, 0x0020, 'CS', text(one.type))] : []),
                ...(one.prescription === undefined
                  ? []
                  : [
                      element(
                        0x300a,
                        0x0026,
                        'DS',
                        typeof one.prescription === 'string'
                          ? text(one.prescription)
                          : decimals([one.prescription]),
                      ),
                    ]),
                ...(one.roi === undefined
                  ? []
                  : [element(0x3006, 0x0084, 'IS', integers([one.roi]))]),
              ]),
            ),
          ),
        ]),
    ...(groups.length === 0
      ? []
      : [
          sequence(
            0x300a,
            0x0070,
            groups.map((one) =>
              concat([
                ...(one.number === undefined
                  ? []
                  : [element(0x300a, 0x0071, 'IS', integers([one.number]))]),
                ...(one.fractions === null || one.fractions === undefined
                  ? []
                  : [element(0x300a, 0x0078, 'IS', integers([one.fractions]))]),
                ...(one.numberOfBeams === undefined
                  ? []
                  : [element(0x300a, 0x0080, 'IS', integers([one.numberOfBeams]))]),
                ...(one.beamDoses
                  ? [
                      sequence(
                        0x300c,
                        0x0004,
                        one.beamDoses.map((gy, at) =>
                          concat([
                            ...(gy === null ? [] : [element(0x300a, 0x0084, 'DS', decimals([gy]))]),
                            element(0x300c, 0x0006, 'IS', integers([at + 1])),
                          ]),
                        ),
                      ),
                    ]
                  : []),
              ]),
            ),
          ),
        ]),
    ...((more.structureSets ?? ['1.2.3.80']).length === 0
      ? []
      : [
          sequence(
            0x300c,
            0x0060,
            (more.structureSets ?? ['1.2.3.80']).map((one) =>
              concat([
                element(0x0008, 0x1150, 'UI', uid('1.2.840.10008.5.1.4.1.1.481.3')),
                element(0x0008, 0x1155, 'UI', uid(one)),
              ]),
            ),
          ),
        ]),
    ...(whole ? [element(0x300e, 0x0002, 'CS', text('APPROVED'))] : []),
  ]);
  return p10File(body, sopClass, '1.2.3.90');
}

const roi = (number: number, name: string): Roi => ({
  number,
  name,
  color: null,
  interpretedType: null,
  contours: [],
});
const STRUCTURES: StructureSet = {
  name: 'rt.dcm',
  label: 'Plan A structures',
  frameOfReferenceUid: '1.2.3.50',
  referencedSeriesUids: [],
  sopInstanceUid: '1.2.3.80',
  rois: [roi(1, 'Heart'), roi(3, 'PTV 60'), roi(4, '')],
};

describe('an RT Plan, read', () => {
  it('gives its fractions, its prescription, what it is of, and the structure set it names', () => {
    const read = parseRtPlan(
      'plan.dcm',
      plan({
        groups: [{ number: 1, fractions: 30, beamDoses: [0.7, 0.65, 0.65] }],
        references: [
          {
            number: 1,
            structureType: 'VOLUME',
            type: 'TARGET',
            description: 'Primary',
            roi: 3,
            prescription: 60,
          },
        ],
      }),
    )!;
    expect(read).toMatchObject({
      name: 'plan.dcm',
      sopInstanceUid: '1.2.3.90',
      label: 'Plan A',
      planName: 'Lung, left',
      description: 'Three fields',
      date: '20260107',
      intent: 'CURATIVE',
      approvalStatus: 'APPROVED',
      patientId: 'SYN-0001',
      frameOfReferenceUid: '1.2.3.50',
      structureSetUids: ['1.2.3.80'],
    });
    expect(read.fractionGroups).toHaveLength(1);
    expect(read.fractionGroups[0]).toMatchObject({ number: 1, fractionsPlanned: 30, beams: 3 });
    expect(read.fractionGroups[0].beamDoseGy).toBeCloseTo(2, 9);
    expect(read.doseReferences).toEqual([
      {
        number: 1,
        structureType: 'VOLUME',
        type: 'TARGET',
        description: 'Primary',
        roiNumber: 3,
        prescriptionGy: 60,
      },
    ]);
  });

  it('is a plan by its SOP class or by its modality, an ion plan among them, and nothing else is', () => {
    expect(parseRtPlan('ion.dcm', plan({ sopClass: RT_ION_PLAN, modality: null }))).not.toBeNull();
    expect(
      parseRtPlan('plan.dcm', plan({ sopClass: '1.2.840.10008.5.1.4.1.1.2', modality: 'rtplan' })),
    ).not.toBeNull();
    expect(
      parseRtPlan('ct.dcm', plan({ sopClass: '1.2.840.10008.5.1.4.1.1.2', modality: 'CT' })),
    ).toBeNull();
    expect(parseRtPlan('junk.bin', new TextEncoder().encode('not DICOM').buffer)).toBeNull();
  });

  it('is a plan with nothing said, when nothing that is read is there', () => {
    const bare = parseRtPlan('plan.dcm', plan({ whole: false, structureSets: [] }))!;
    expect(bare).toMatchObject({
      label: null,
      planName: null,
      description: null,
      date: null,
      intent: null,
      approvalStatus: null,
      structureSetUids: [],
      fractionGroups: [],
      doseReferences: [],
    });
  });

  it('reads every fraction group and every dose reference as it stands', () => {
    const read = parseRtPlan(
      'plan.dcm',
      plan({
        groups: [
          { number: 1, fractions: 25, beamDoses: [1, 1] },
          // No number of fractions; a beam without a dose; beams counted, not named.
          { number: 2, fractions: null, beamDoses: [1, null] },
          { number: 3, fractions: 5, numberOfBeams: 4 },
        ],
        references: [
          { number: 1, type: 'TARGET', roi: 3, prescription: 50 },
          { number: 2, type: 'ORGAN_AT_RISK', roi: 1 },
          { number: 3, type: 'TARGET', structureType: 'POINT', description: 'Isocentre' },
        ],
      }),
    )!;
    expect(read.fractionGroups).toEqual([
      { number: 1, fractionsPlanned: 25, beams: 2, beamDoseGy: 2 },
      { number: 2, fractionsPlanned: null, beams: 2, beamDoseGy: null },
      { number: 3, fractionsPlanned: 5, beams: 4, beamDoseGy: null },
    ]);
    expect(
      read.doseReferences.map((one) => [one.number, one.roiNumber, one.prescriptionGy]),
    ).toEqual([
      [1, 3, 50],
      [2, 1, null],
      [3, null, null],
    ]);
  });

  it('takes for no number what is none: no fractions, a negative dose, words', () => {
    const read = parseRtPlan(
      'plan.dcm',
      plan({
        groups: [{ fractions: 0 }, { fractions: -3 }],
        references: [{ prescription: -2 }, { prescription: 'sixty' }, { prescription: 0 }],
      }),
    )!;
    expect(read.fractionGroups.map((one) => one.fractionsPlanned)).toEqual([null, null]);
    expect(read.doseReferences.map((one) => one.prescriptionGy)).toEqual([null, null, 0]);
  });
});

describe('what is read of a plan with a file’s header', () => {
  it('is in the header of a plan, and of nothing else', () => {
    const bytes = (buffer: ArrayBuffer): Uint8Array => new Uint8Array(buffer);
    const identity = concat([
      element(0x0020, 0x000d, 'UI', uid('1.2.3.10')),
      element(0x0020, 0x000e, 'UI', uid('1.2.3.20')),
    ]);
    const of = (buffer: ArrayBuffer) => {
      // The fixture has no study or series: put them after the file's own elements.
      const whole = concat([bytes(buffer), identity]);
      const read = readInstanceHeader(whole);
      if (!read.ok) throw new Error(read.reason);
      return read.header;
    };
    const header = of(
      plan({
        groups: [{ number: 1, fractions: 30, beamDoses: [2] }],
        references: [{ number: 1, type: 'TARGET', roi: 3, prescription: 60 }],
      }),
    );
    expect(header.plan).toEqual({
      label: 'Plan A',
      planName: 'Lung, left',
      date: '20260107',
      intent: 'CURATIVE',
      approvalStatus: 'APPROVED',
      fractionGroups: [{ number: 1, fractionsPlanned: 30, beams: 1, beamDoseGy: 2 }],
      doseReferences: [
        {
          number: 1,
          structureType: null,
          type: 'TARGET',
          description: null,
          roiNumber: 3,
          prescriptionGy: 60,
        },
      ],
    });
    expect(header.references).toEqual([{ relation: 'plan.structure-set', targetUid: '1.2.3.80' }]);
    // By its SOP class: a file of another class that calls itself a plan is not read as one.
    expect(of(plan({ sopClass: '1.2.840.10008.5.1.4.1.1.2', modality: 'RTPLAN' })).plan).toBeNull();
  });

  it('cuts a label, a name or a description that is longer than the standard lets it be', () => {
    const long = 'x'.repeat(PLAN_TEXT_AT_MOST + 40);
    const read = parseRtPlan(
      'plan.dcm',
      plan({ references: [{ description: long, type: long, prescription: 2 }] }),
    )!;
    expect(read.doseReferences[0].description).toBe('x'.repeat(PLAN_TEXT_AT_MOST));
    expect(read.doseReferences[0].type).toBe('X'.repeat(PLAN_TEXT_AT_MOST));
    // So that what is kept of the largest plan read is well within what an index takes.
    const most = Array.from({ length: PLAN_ITEMS_AT_MOST }, (_, at) => at + 1);
    const largest = parseRtPlan(
      'plan.dcm',
      plan({
        groups: most.map((number) => ({ number, fractions: 30, beamDoses: [1.234567] })),
        references: most.map((number) => ({
          number,
          structureType: long,
          type: long,
          description: long,
          roi: number,
          prescription: 60.123456,
        })),
      }),
    )!;
    const { fractionGroups, doseReferences } = largest;
    expect(JSON.stringify({ fractionGroups, doseReferences }).length).toBeLessThan(32_768);
  });

  it('is the first of a plan’s groups and references, and no more than the limit', () => {
    const many = Array.from({ length: PLAN_ITEMS_AT_MOST + 5 }, (_, at) => at + 1);
    const read = parseRtPlan(
      'plan.dcm',
      plan({
        groups: many.map((number) => ({ number, fractions: number })),
        references: many.map((number) => ({ number, prescription: number })),
      }),
    )!;
    expect(read.fractionGroups.map((one) => one.number)).toEqual(many.slice(0, PLAN_ITEMS_AT_MOST));
    expect(read.doseReferences.map((one) => one.number)).toEqual(many.slice(0, PLAN_ITEMS_AT_MOST));
  });
});

describe('a plan’s summary', () => {
  const summaryOf = (
    more: Parameters<typeof plan>[0],
    sets: readonly StructureSet[] = [STRUCTURES],
  ): PlanSummary => planSummary(parseRtPlan('plan.dcm', plan(more))!, sets);

  it('is the fractions planned and the dose prescribed, to a structure by its name', () => {
    const summary = summaryOf({
      groups: [{ number: 1, fractions: 30 }],
      references: [{ type: 'TARGET', roi: 3, prescription: 60 }],
    });
    expect(summary).toEqual({
      label: 'Plan A',
      planName: 'Lung, left',
      date: '20260107',
      intent: 'CURATIVE',
      approvalStatus: 'APPROVED',
      fractions: [30],
      fractionGroups: 1,
      prescriptions: [{ gy: 60, type: 'TARGET', to: 'PTV 60' }],
    });
    expect(planSummaryText(summary)).toBe('30 fractions · 60 Gy to “PTV 60”');
    expect(planGroup(summary)).toEqual({
      title: 'Plan',
      fields: [
        { label: 'Label', value: 'Plan A · Lung, left' },
        { label: 'Fractions', value: '30 fractions' },
        { label: 'Prescription', value: '60 Gy to “PTV 60”' },
        { label: 'Intent', value: 'CURATIVE' },
        { label: 'Approval', value: 'APPROVED' },
        { label: 'Plan date', value: formatDicomDate('20260107') },
      ],
    });
    // What a plan does not give has no row; what it does not say of its dose is said.
    expect(planGroup(summaryOf({ whole: false })).fields).toEqual([
      { label: 'Fractions', value: 'fractions not said' },
      { label: 'Prescription', value: 'no prescription said' },
    ]);
  });

  it('names a structure by its number when the plan’s structure set is not at hand, or has no name for it', () => {
    const more = {
      groups: [{ fractions: 1 }],
      references: [
        { type: 'TARGET', roi: 3, prescription: 20 },
        { type: 'TARGET', roi: 4, prescription: 18.123 },
        { type: 'TARGET', roi: 9, prescription: 16 },
      ],
    };
    expect(
      planSummary(parseRtPlan('plan.dcm', plan(more))!).prescriptions.map((one) => one.to),
    ).toEqual(['ROI 3', 'ROI 4', 'ROI 9']);
    // A structure set the plan does not name is not asked, though it has an ROI 3.
    const other = { ...STRUCTURES, sopInstanceUid: '1.2.3.81' };
    expect(summaryOf(more, [other]).prescriptions[0].to).toBe('ROI 3');
    const summary = summaryOf(more);
    expect(summary.prescriptions.map((one) => one.to)).toEqual(['PTV 60', 'ROI 4', 'ROI 9']);
    expect(planSummaryText(summary)).toBe(
      '1 fraction · 20 Gy to “PTV 60”, 18.12 Gy to “ROI 4”, 16 Gy to “ROI 9”',
    );
  });

  it('gives every fraction group and every prescription, and picks none', () => {
    const summary = summaryOf({
      groups: [{ fractions: 25 }, { fractions: 5 }, { fractions: null }],
      references: [
        { type: 'TARGET', roi: 3, prescription: 50 },
        { type: 'TARGET', description: 'Boost', prescription: 10 },
        { type: 'ORGAN_AT_RISK', roi: 1, prescription: 20 },
        { type: 'ORGAN_AT_RISK', roi: 1 },
        { prescription: 5 },
      ],
    });
    expect(summary.fractions).toEqual([25, 5]);
    expect(summary.fractionGroups).toBe(3);
    expect(summary.prescriptions).toEqual([
      { gy: 50, type: 'TARGET', to: 'PTV 60' },
      { gy: 10, type: 'TARGET', to: 'Boost' },
      { gy: 20, type: 'ORGAN_AT_RISK', to: 'Heart' },
      { gy: 5, type: null, to: null },
    ]);
    expect(planSummaryText(summary)).toBe(
      '3 fraction groups: 25, 5 fractions · 50 Gy to “PTV 60”, 10 Gy to “Boost”, 20 Gy to “Heart” (organ at risk), 5 Gy',
    );
  });

  it('says what the plan does not say, so that nothing is taken for it', () => {
    expect(planSummaryText(summaryOf({}))).toBe('fractions not said · no prescription said');
    expect(planSummaryText(summaryOf({ groups: [{ fractions: null }] }))).toBe(
      'fractions not said · no prescription said',
    );
    expect(
      planSummaryText(summaryOf({ references: [{ type: 'TARGET', roi: 3, prescription: 60 }] })),
    ).toBe('fractions not said · 60 Gy to “PTV 60”');
  });
});

describe('a plan’s summary in a few characters', () => {
  const brief = (summary: Partial<PlanSummary>): string =>
    planBrief({
      label: null,
      planName: null,
      date: null,
      intent: null,
      approvalStatus: null,
      fractions: [],
      fractionGroups: 0,
      prescriptions: [],
      ...summary,
    });

  it('is the fractions and the dose prescribed to the targets', () => {
    expect(brief({ fractions: [30], prescriptions: [{ gy: 60, type: 'TARGET', to: 'PTV' }] })).toBe(
      '30 fx · 60 Gy',
    );
    expect(
      brief({
        fractions: [25, 5],
        prescriptions: [
          { gy: 50, type: 'TARGET', to: 'PTV' },
          { gy: 20, type: 'ORGAN_AT_RISK', to: 'Heart' },
          { gy: 10.126, type: null, to: null },
        ],
      }),
    ).toBe('25+5 fx · 50, 10.13 Gy');
  });

  it('leaves out what the plan does not say, and is empty when it says neither', () => {
    expect(brief({ fractions: [5] })).toBe('5 fx');
    expect(brief({ prescriptions: [{ gy: 8, type: 'TARGET', to: null }] })).toBe('8 Gy');
    expect(brief({ prescriptions: [{ gy: 20, type: 'ORGAN_AT_RISK', to: 'Cord' }] })).toBe('');
    expect(brief({})).toBe('');
  });
});
