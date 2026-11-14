/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// What the API's answers look like, as JSON Schema, for the API description.
// The specs hold every answer of the API against these, so that the
// description and the server cannot drift apart.

type Schema = Readonly<Record<string, unknown>>;

const text = { type: 'string' } as const;
const nullableText = { type: ['string', 'null'] } as const;
const count = { type: 'integer', minimum: 0 } as const;
const nullableInteger = { type: ['integer', 'null'] } as const;
const uid = { type: 'string', pattern: '^[0-9]+(\\.[0-9]+)*$', maxLength: 64 } as const;
const nullableUid = { ...uid, type: ['string', 'null'] } as const;
const date = { type: ['string', 'null'], description: 'YYYYMMDD' } as const;

/** An object in which every listed property is always present. */
function object(properties: Record<string, unknown>, description?: string): Schema {
  return {
    type: 'object',
    ...(description ? { description } : {}),
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  };
}

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });

/** A part of a longer list, and whether there is more after it. */
function page(item: string): Schema {
  return object({
    items: { type: 'array', items: ref(item) },
    limit: count,
    offset: count,
    more: { type: 'boolean', description: 'Whether there are items after these.' },
  });
}

const instance = {
  sopInstanceUid: uid,
  sopClassUid: uid,
  seriesInstanceUid: uid,
  studyInstanceUid: uid,
  modality: text,
  number: nullableInteger,
  size: { ...count, description: 'Bytes of the stored file.' },
  sha256: { type: 'string', pattern: '^[0-9a-f]{64}$', description: 'Of the stored file.' },
};

const reference = object({
  relation: {
    type: 'string',
    enum: [
      'structure-set.series',
      'structure-set.frame',
      'plan.structure-set',
      'dose.plan',
      'dose.structure-set',
      'registration.frame',
      'registration.series',
    ],
    description: 'What refers to what; the target is a UID of the kind after the dot.',
  },
  targetUid: uid,
});

export const SCHEMAS: Readonly<Record<string, Schema>> = {
  Error: object({
    error: { type: 'string', description: 'A fixed word for what is wrong.' },
    message: text,
  }),
  Health: object({
    status: { type: 'string', enum: ['ok', 'stopping'] },
    version: text,
    uptimeSeconds: count,
    inFlight: { ...count, description: 'Pieces of work that have begun and not ended.' },
  }),
  Counts: object({ patients: count, studies: count, series: count, instances: count }),
  Patient: object({
    patientKey: { type: 'integer', description: "The index's own number for the patient." },
    patientId: text,
    issuer: text,
    name: nullableText,
    birthDate: date,
    sex: nullableText,
    studies: count,
  }),
  Study: object({
    studyInstanceUid: uid,
    patientKey: { type: 'integer' },
    patientId: text,
    patientName: nullableText,
    patientBirthDate: date,
    patientSex: nullableText,
    date,
    time: nullableText,
    description: nullableText,
    accessionNumber: nullableText,
    modalities: { type: 'array', items: text },
    series: count,
    instances: count,
  }),
  Series: object({
    seriesInstanceUid: uid,
    studyInstanceUid: uid,
    modality: text,
    number: nullableInteger,
    description: nullableText,
    frameOfReferenceUid: nullableUid,
    instances: count,
  }),
  Instance: object(instance),
  Reference: reference,
  InstanceDetail: object(
    { ...instance, references: { type: 'array', items: ref('Reference') } },
    'An instance and what it refers to.',
  ),
  Related: object(
    {
      structureSets: { type: 'array', items: ref('Instance') },
      plans: { type: 'array', items: ref('Instance') },
      doses: { type: 'array', items: ref('Instance') },
      registrations: { type: 'array', items: ref('Instance') },
      sameFrame: { type: 'array', items: ref('Series') },
    },
    'The radiotherapy objects that belong to an image series, and the series that say they are in its frame.',
  ),
  PatientPage: page('Patient'),
  StudyPage: page('Study'),
  SeriesPage: page('Series'),
  InstancePage: page('Instance'),
  JobKind: object({ name: text, description: text }),
  JobKinds: object({ items: { type: 'array', items: ref('JobKind') } }),
  Job: object({
    id: text,
    kind: text,
    status: { type: 'string', enum: ['queued', 'running', 'succeeded', 'failed', 'cancelled'] },
    inputs: { type: 'object', description: 'As they were submitted.' },
    progress: {
      type: ['number', 'null'],
      minimum: 0,
      maximum: 1,
      description: 'From 0 to 1, as the worker last said.',
    },
    message: { type: ['string', 'null'], description: 'What the worker last said it was doing.' },
    result: { type: ['object', 'null'], description: 'What the worker reported as its result.' },
    failure: {
      type: ['string', 'null'],
      enum: ['exit-code', 'timed-out', 'interrupted', 'could-not-start', null],
      description: 'Why the job failed; null unless it did.',
    },
    exitCode: nullableInteger,
    createdAt: text,
    startedAt: nullableText,
    endedAt: nullableText,
  }),
  JobPage: page('Job'),
  JobLogLine: object({
    sequence: { type: 'integer', minimum: 1 },
    stream: { type: 'string', enum: ['out', 'err'] },
    text,
  }),
  JobLog: object({ items: { type: 'array', items: ref('JobLogLine') } }),
  Upload: object({
    outcome: { type: 'string', enum: ['stored', 'unchanged', 'replaced'] },
    sopInstanceUid: uid,
  }),
};
