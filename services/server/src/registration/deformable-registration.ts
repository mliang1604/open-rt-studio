/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The job that registers two image series deformably (#81): it writes the
// two series from the PACS as volume files, runs `ors-register-deformable`
// on them with a preset (native/tools/register-deformable) and stores what
// the tool found as a DICOM Deformable Spatial Registration object.
//
// **Which way.** The tool gives a field of vectors over the fixed image and
// a matrix, which together say where a point of the fixed image is in the
// moving one:
//
//     moving = fixedToMovingAfterField · (fixed + field(fixed))
//
// A Deformable Spatial Registration object holds exactly that (PS3.3
// C.20.3): it is in the fixed image's frame of reference, its grid is laid
// out there, and it maps into the moving image's frame, with the matrix as
// its Post Deformation matrix. So nothing is turned round here, unlike the
// rigid job, whose object maps the other way.
//
// The program and the presets are the ones the server was configured with.
// A request names two series and a preset, and nothing of a program or a
// place on the disk.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  deformableTransform,
  readMetaImageField,
  RegistrationError,
  rightHandedGrid,
  writeDeformableRegistration,
  type DeformationGrid,
} from '@open-rt-studio/dicom';

import type { Pacs } from '../core/core.js';
import {
  InvalidJobInputError,
  JobStepError,
  type JobKind,
  type JsonObject,
  type JsonValue,
} from '../jobs/job.js';
import {
  checkPair,
  discardStored,
  filedWith,
  PAIR_INPUT_NAMES,
  pairArguments,
  pairForResult,
  preparePair,
  readPairInputs,
  readResultFile,
  registrationName,
  rigidMatrix,
  subjectOfPair,
  type PairInputs,
} from './pair.js';
import type { RegistrationPreset } from './presets.js';

export const DEFORMABLE_REGISTRATION_KIND = 'deformable-registration';

/** The file name of the tool, beside the other native tools. */
export const DEFORMABLE_REGISTRATION_TOOL =
  process.platform === 'win32' ? 'ors-register-deformable.exe' : 'ors-register-deformable';

const FIELD_FILE = 'field.mha';

export interface DeformableRegistrationParts {
  /** The PACS, asked for when a job runs. */
  readonly pacs: () => Pacs;
  /** The program and what goes before its own arguments: from the server's configuration. */
  readonly program: readonly [string, ...string[]];
  /** The presets a job may name. */
  readonly presets: readonly RegistrationPreset[];
  /** How many threads the tool uses. Default 4. */
  readonly threads?: number;
  /** How long a registration may take. Default an hour. */
  readonly timeoutMs?: number;
  /** The clock, for tests. */
  readonly now?: () => Date;
}

interface Inputs extends PairInputs {
  readonly preset: RegistrationPreset;
  /** Parameters set over the preset, each as the text the tool takes. */
  readonly parameters: readonly (readonly [key: string, value: string])[];
}

const INPUT_NAMES = new Set([...PAIR_INPUT_NAMES, 'preset', 'parameters']);
const PARAMETER_KEY = /^[A-Za-z][A-Za-z0-9]{0,79}$/;
const PARAMETER_WORD = /^[A-Za-z0-9.+_-]{1,64}$/;
const PARAMETERS_AT_MOST = 32;

/**
 * Whether a parameter is the tool's own to decide: the kind of transform
 * and how it is combined, the seed, and everything that names a file or
 * has elastix write one. The tool refuses these itself; this is the same
 * list, so that a job that sets one is refused before it is queued.
 */
export function isToolsOwnParameter(key: string): boolean {
  return (
    [
      ...['Transform', 'HowToCombineTransforms', 'RandomSeed'],
      ...['FixedImageDimension', 'MovingImageDimension'],
      ...['FixedInternalImagePixelType', 'MovingInternalImagePixelType'],
    ].includes(key) ||
    ['FileName', 'Write', 'Result', 'Directory', 'CompressResultImage'].some((part) =>
      key.includes(part),
    )
  );
}

/** One value of a parameter as the text the tool takes, or null. */
function word(value: JsonValue): string | null {
  const text =
    typeof value === 'number' && Number.isFinite(value)
      ? String(value)
      : typeof value === 'string'
        ? value
        : null;
  return text !== null && PARAMETER_WORD.test(text) ? text : null;
}

function readParameters(given: JsonValue | undefined): Inputs['parameters'] {
  if (given === undefined || given === null) return [];
  const wrong = (): never => {
    throw new InvalidJobInputError(
      'parameters must be an object of elastix parameters, each a word or a number or a short list of them.',
    );
  };
  if (typeof given !== 'object' || Array.isArray(given)) return wrong();
  const entries = Object.entries(given);
  if (entries.length > PARAMETERS_AT_MOST) return wrong();
  return entries.map(([key, value]) => {
    if (!PARAMETER_KEY.test(key)) return wrong();
    if (isToolsOwnParameter(key)) {
      throw new InvalidJobInputError(
        'parameters may not set what the tool decides itself: the kind of transform, the seed, and what is written where.',
      );
    }
    const values = Array.isArray(value) ? value : [value];
    if (values.length < 1 || values.length > 16) return wrong();
    const words = values.map(word);
    if (words.some((one) => one === null)) return wrong();
    return [key, words.join(' ')] as const;
  });
}

/** How far the field moves a point at most, and such numbers of the tool's: a number that is one, or null. */
const measure = (value: JsonValue | undefined): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;

/**
 * The job kind `deformable-registration`.
 *
 * Inputs: `fixedSeriesUid` and `movingSeriesUid` (two CT, MR or PET series
 * of one patient, in two frames of reference) and `preset` (the name of one
 * of the server's presets); optionally `initial` (a matrix of 16 numbers
 * that only turns and moves, to start from: where a point of the fixed
 * image is in the moving one, such as a rigid registration's
 * `fixedToMoving`), `roi`, `seed`, and `parameters` (elastix parameters set
 * over the preset, for whoever knows them).
 *
 * Result: the Deformable Spatial Registration object that was stored
 * (`sopInstanceUid`, `seriesInstanceUid`, `studyInstanceUid`: it is filed
 * in the study of the fixed series), the two frames, the matrix after the
 * field, and what the tool said of the field: its size, the longest vector
 * (`largestMm`), and at how many of its points it folds space over
 * (`foldedPoints`), which no anatomy does. The field covers the air around
 * what was imaged too, where nothing holds it, so the tool also says what
 * it is inside the fixed image's outline (#351): how many of its points
 * are (`insidePoints`), and the longest and the mean vector there
 * (`largestInsideMm`, `meanInsideMm`; null when no point is, or when the
 * tool is one that does not say).
 */
export function deformableRegistrationKind(parts: DeformableRegistrationParts): JobKind {
  const [program, ...leading] = parts.program;
  const threads = parts.threads ?? 4;
  const now = parts.now ?? (() => new Date());
  const presets = new Map(parts.presets.map((preset) => [preset.name, preset]));

  /** The inputs as the kind takes them. Throws {@link InvalidJobInputError}, which repeats no value. */
  const readInputs = (inputs: JsonObject): Inputs => {
    for (const name of Object.keys(inputs)) {
      if (!INPUT_NAMES.has(name)) {
        throw new InvalidJobInputError(
          'A deformable registration takes fixedSeriesUid, movingSeriesUid, preset and, if wanted, initial, roi, seed and parameters.',
        );
      }
    }
    const pair = readPairInputs(inputs);
    const named = inputs['preset'];
    const preset = typeof named === 'string' ? presets.get(named) : undefined;
    if (!preset) {
      throw new InvalidJobInputError(
        `preset must be one of this server's presets: ${[...presets.keys()].join(', ')}.`,
      );
    }
    return { ...pair, preset, parameters: readParameters(inputs['parameters']) };
  };

  return {
    name: DEFORMABLE_REGISTRATION_KIND,
    description:
      'Finds the deformable registration between two image series (fixedSeriesUid, movingSeriesUid, preset; optionally initial, roi, seed, parameters) and stores it as a Deformable Spatial Registration object.',
    timeoutMs: parts.timeoutMs ?? 60 * 60_000,
    removeWorkDir: true,
    discard: (_inputs, result) => discardStored(parts.pacs(), result),

    command(given, { workDir }) {
      const inputs = readInputs(given);
      const args = [
        ...leading,
        ...pairArguments(inputs, workDir, threads),
        ...['--preset', inputs.preset.file],
        ...['--field', join(workDir, FIELD_FILE)],
      ];
      for (const [key, value] of inputs.parameters) args.push('--set', `${key}=${value}`);
      return { file: program, args };
    },
    check: (given) => checkPair(parts.pacs(), readInputs(given)),
    subject: (given) => subjectOfPair(parts.pacs(), readInputs(given)),
    prepare: (given, context) => preparePair(parts.pacs(), readInputs(given), context),

    async finish(given, { workDir }) {
      const inputs = readInputs(given);
      const pacs = parts.pacs();
      const result = await readResultFile(workDir);
      const after = rigidMatrix(result?.['fixedToMovingAfterField']);
      if (!result || !after) throw new JobStepError('no-result');
      let grid: DeformationGrid;
      try {
        // A DICOM object lays its grid out right-handed; a volume's slices may run either way.
        grid = rightHandedGrid(
          readMetaImageField(new Uint8Array(await readFile(join(workDir, FIELD_FILE)))),
        );
      } catch {
        // Not there, or not a field as the tool writes one.
        throw new JobStepError('no-field');
      }
      const pair = await pairForResult(pacs, inputs);

      const made = now();
      let bytes: ArrayBuffer;
      try {
        // As the tool gave it: from the fixed frame to the moving one, the
        // field first and the matrix after it. The object holds that as it is.
        const transform = deformableTransform({
          id: 'automatic-deformable',
          from: pair.fixedFrame,
          to: pair.movingFrame,
          grid,
          post: after,
        });
        bytes = writeDeformableRegistration(
          { registeredFrame: pair.fixedFrame, transforms: [transform] },
          {
            ...filedWith(pair.study),
            seriesDescription: 'Automatic deformable registration',
            description: registrationName(`Automatic deformable ${inputs.preset.name}`, made),
            createdAt: made,
          },
        );
      } catch (error) {
        // A field with a vector without end, say: nothing to store.
        if (error instanceof RegistrationError) throw new JobStepError('bad-field');
        throw error;
      }
      const stored = await pacs.ingest.ingest(new Uint8Array(bytes));
      if (stored.outcome === 'refused') throw new JobStepError('not-stored');
      const instance = await pacs.index.getInstance(stored.sopInstanceUid);
      if (!instance) throw new JobStepError('not-stored');
      return {
        sopInstanceUid: instance.sopInstanceUid,
        seriesInstanceUid: instance.seriesInstanceUid,
        studyInstanceUid: instance.studyInstanceUid,
        fixedFrameOfReferenceUid: pair.fixedFrame,
        movingFrameOfReferenceUid: pair.movingFrame,
        preset: inputs.preset.name,
        seed: inputs.seed,
        // moving = fixedToMovingAfterField · (fixed + field(fixed))
        fixedToMovingAfterField: after,
        fieldSize: [...grid.dims],
        largestMm: measure(result['largestMm']),
        insidePoints: measure(result['insidePoints']),
        largestInsideMm: measure(result['largestInsideMm']),
        meanInsideMm: measure(result['meanInsideMm']),
        foldedPoints: measure(result['foldedPoints']),
      };
    },
  };
}
