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
const nullableNumber = { type: ['number', 'null'] } as const;
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
  frames: {
    ...nullableInteger,
    description: 'Number of Frames: the images in the one file. Null when the file does not say.',
  },
  derived: {
    type: ['boolean', 'null'],
    description:
      'Whether the object says it was made from others: an image whose Image Type begins DERIVED or that has a Derivation Description, a structure set that names a predecessor or has a resampled structure. It is the object’s own statement, not read from its name. Null for one filed before this was kept.',
  },
  size: { ...count, description: 'Bytes of the stored file.' },
  sha256: { type: 'string', pattern: '^[0-9a-f]{64}$', description: 'Of the stored file.' },
};

const account = object(
  {
    name: { type: 'string', pattern: '^[a-z0-9][a-z0-9._-]{0,63}$' },
    role: { type: 'string', enum: ['admin', 'user'] },
    disabled: { type: 'boolean', description: 'A disabled account is kept, and cannot log in.' },
    createdAt: { ...text, description: 'ISO 8601.' },
  },
  'An account. Its password is never part of an answer.',
);

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
  Account: account,
  AccountList: object({ accounts: { type: 'array', items: ref('Account') } }),
  Session: object(
    {
      account: {
        ...account,
        type: ['object', 'null'],
        description: 'Whose session it is. Null on a server without accounts.',
      },
      expiresAt: {
        ...nullableText,
        description:
          'When the session ends if it is not used again (ISO 8601). Null on a server without accounts.',
      },
    },
    'Who is logged in.',
  ),
  Login: object(
    {
      token: {
        type: 'string',
        description: 'Send it with every request, as `Authorization: Bearer <token>`.',
      },
      account,
      expiresAt: { ...text, description: 'When the session ends if it is not used again.' },
    },
    'A login: the token, told once, and the session it stands for.',
  ),
  AuditRecord: object(
    {
      id: count,
      time: { type: 'string', description: 'When, or when first: ISO 8601, UTC.' },
      until: { type: 'string', description: 'When last, for a record that counts several.' },
      count: { type: 'integer', minimum: 1, description: 'How often, from `time` to `until`.' },
      actor: {
        ...nullableText,
        description:
          'The account. Null when no one was logged in: a server without accounts, a command, a login with a name that is no account.',
      },
      origin: { type: 'string', enum: ['api', 'command', 'server'] },
      action: text,
      outcome: { type: 'string', enum: ['ok', 'refused', 'not-found', 'rejected', 'failed'] },
      patientId: nullableText,
      studyUid: nullableText,
      seriesUid: nullableText,
      object: {
        ...nullableText,
        description: 'What else it was done to: an account, a job, an instance that was not found.',
      },
      detail: {
        ...nullableText,
        description: 'What more there is to say: what was searched for, what was changed.',
      },
    },
    'Who did what, to what, and how it ended.',
  ),
  AuditPage: object({
    items: { type: 'array', items: ref('AuditRecord') },
    limit: count,
    offset: count,
    more: { type: 'boolean', description: 'Whether there are records after these.' },
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
    instances: { ...count, description: 'How many files the series holds.' },
    images: {
      ...count,
      description:
        'How many images those files hold: the frames of each, or one where a file does not say.',
    },
    structureSets: {
      ...count,
      description:
        'How many structure sets belong to the series: those that name it or its frame of reference. They are listed by /series/{uid}/related.',
    },
    derived: {
      type: ['boolean', 'null'],
      description:
        'Whether the series says it is derived: true when an instance of it does, false when every instance says it is not, null when none does and some were filed before this was kept.',
    },
  }),
  Instance: object(instance),
  Reference: reference,
  InstanceDetail: object(
    {
      ...instance,
      references: { type: 'array', items: ref('Reference') },
      plan: {
        ...object({
          label: nullableText,
          planName: nullableText,
          date,
          intent: nullableText,
          approvalStatus: nullableText,
          fractionGroups: {
            type: 'array',
            items: object({
              number: nullableInteger,
              fractionsPlanned: nullableInteger,
              beams: count,
              beamDoseGy: nullableNumber,
            }),
          },
          doseReferences: {
            type: 'array',
            items: object({
              number: nullableInteger,
              structureType: nullableText,
              type: nullableText,
              description: nullableText,
              roiNumber: nullableInteger,
              prescriptionGy: nullableNumber,
            }),
          },
        }),
        type: ['object', 'null'],
        description:
          'For an RT Plan, what it says of its fractions and prescriptions: every fraction group and dose reference as the file has it, doses in Gy. Null for anything else, and for a plan filed before this was kept.',
      },
      dose: {
        ...object({
          summationType: nullableText,
          beams: { type: 'array', items: { type: 'integer' } },
          fractionGroup: nullableInteger,
        }),
        type: ['object', 'null'],
        description:
          'For an RT Dose, what it says it is the dose of: its Dose Summation Type as written, and the beam numbers and the fraction group number it names under its plan. A series may hold several doses, and this tells them apart. Null for anything else, and for a dose filed before this was kept.',
      },
    },
    'An instance, what it refers to, and what a plan or a dose says.',
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
  Timepoint: object({
    id: {
      type: 'string',
      pattern: '^[A-Za-z0-9-]{1,64}$',
      description: 'Its own, and of no meaning: what it is told apart by when it is renamed.',
    },
    name: { type: 'string', maxLength: 64 },
    studyUids: { type: 'array', items: uid },
  }),
  Timepoints: object({ timepoints: { type: 'array', items: ref('Timepoint') } }),
  DicomLocal: object({
    enabled: { type: 'boolean', description: 'Whether the server listens for DICOM.' },
    port: { type: 'integer', minimum: 0, maximum: 65535 },
    aeTitle: { type: 'string', maxLength: 16 },
  }),
  DicomRemote: object({
    id: { type: 'string', description: 'The server’s own, and of no meaning.' },
    name: { type: 'string', maxLength: 64 },
    aeTitle: { type: 'string', maxLength: 16 },
    host: { type: ['string', 'null'], description: 'Null for a system that only calls.' },
    port: { type: ['integer', 'null'], minimum: 1, maximum: 65535 },
    mayStore: { type: 'boolean', description: 'Whether it may send objects to this server.' },
  }),
  DicomState: object({
    local: ref('DicomLocal'),
    remotes: { type: 'array', items: ref('DicomRemote') },
    listening: {
      type: ['object', 'null'],
      description: 'Where the listener is now.',
      properties: { host: text, port: { type: 'integer' } },
      required: ['host', 'port'],
      additionalProperties: false,
    },
  }),
  DicomDestination: object({
    id: { type: 'string', description: 'What a send names the system by.' },
    name: { type: 'string', maxLength: 64 },
    aeTitle: { type: 'string', maxLength: 16 },
  }),
  DicomDestinations: object({ items: { type: 'array', items: ref('DicomDestination') } }),
  DicomSendInstance: object({
    sopInstanceUid: uid,
    state: { type: 'string', enum: ['waiting', 'sent', 'failed'] },
    rewritten: {
      type: 'boolean',
      description:
        'Of one that was sent: whether it went in another transfer syntax than it is stored in.',
    },
    status: {
      type: ['integer', 'null'],
      description: 'The status the other system answered with, when it was not plain success.',
    },
    failure: {
      type: ['string', 'null'],
      enum: [
        ...['refused', 'kind-not-taken', 'transfer-syntax-not-taken', 'rejected'],
        ...['unreachable', 'broken', 'missing', 'stopped', null],
      ],
    },
  }),
  DicomSend: object({
    id: text,
    destination: ref('DicomDestination'),
    studyInstanceUid: uid,
    seriesInstanceUid: uid,
    state: { type: 'string', enum: ['waiting', 'running', 'done'] },
    askedAt: text,
    finishedAt: nullableText,
    retryOf: {
      type: ['string', 'null'],
      description: 'The send whose failures this one sends again.',
    },
    instances: { type: 'array', items: ref('DicomSendInstance') },
  }),
  DicomSends: object({ items: { type: 'array', items: ref('DicomSend') } }),
  DicomEcho: object({
    outcome: { type: 'string', enum: ['ok', 'rejected', 'unreachable', 'failed'] },
    status: { type: ['integer', 'null'], description: 'The status of an echo that failed.' },
  }),
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
