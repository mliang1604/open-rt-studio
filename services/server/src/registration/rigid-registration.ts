/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The job that registers two image series rigidly (#80): it writes the two
// series from the PACS as volume files, runs `ors-register-rigid` on them
// (native/tools/register-rigid) and stores what the tool found as a DICOM
// Spatial Registration object.
//
// **Which way.** The tool gives `fixedToMoving`: where a point of the fixed
// image is in the moving one. The object that is stored is in the fixed
// image's frame of reference and holds the matrix that maps the moving
// image's frame into it, as such objects are usually written (the secondary
// image registered to the primary): the inverse of what the tool gave. The
// job's result has both, each under its name.
//
// The program is the one the server was configured with. A request names
// two series and nothing of a program or a place on the disk.

import { invertTransform, matrixTransform, writeSpatialRegistration } from '@open-rt-studio/dicom';

import type { Pacs } from '../core/core.js';
import { InvalidJobInputError, JobStepError, type JobKind, type JsonObject } from '../jobs/job.js';
import {
  checkPair,
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

export { DEFAULT_SEED } from './pair.js';

export const RIGID_REGISTRATION_KIND = 'rigid-registration';

/** The file name of the tool, beside the other native tools. */
export const RIGID_REGISTRATION_TOOL =
  process.platform === 'win32' ? 'ors-register-rigid.exe' : 'ors-register-rigid';

export interface RigidRegistrationParts {
  /**
   * The PACS the series are read from and the result is stored in. Asked for
   * when a job runs: the kinds of a server are named before its PACS is open.
   */
  readonly pacs: () => Pacs;
  /**
   * The program and what goes before its own arguments: from the server's
   * configuration, never from a request. One element for the tool itself.
   */
  readonly program: readonly [string, ...string[]];
  /**
   * How many threads the tool uses. One number for every job, so that one
   * seed gives one answer on this server. Default 4.
   */
  readonly threads?: number;
  /** How long a registration may take. Default half an hour. */
  readonly timeoutMs?: number;
  /** The clock, for tests. */
  readonly now?: () => Date;
}

const INPUT_NAMES = new Set(PAIR_INPUT_NAMES);

/** The inputs as the kind takes them. Throws {@link InvalidJobInputError}, which repeats no value. */
function readInputs(inputs: JsonObject): PairInputs {
  for (const name of Object.keys(inputs)) {
    if (!INPUT_NAMES.has(name)) {
      throw new InvalidJobInputError(
        'A rigid registration takes fixedSeriesUid, movingSeriesUid and, if wanted, initial, roi and seed.',
      );
    }
  }
  return readPairInputs(inputs);
}

/** The name the registration goes by where registrations are listed: what made it, and when. */
export const automaticRigidName = (now: Date): string => registrationName('Automatic rigid', now);

/**
 * The job kind `rigid-registration`.
 *
 * Inputs: `fixedSeriesUid` and `movingSeriesUid` (two CT, MR or PET series of
 * one patient, in two frames of reference); optionally `initial` (a matrix
 * of 16 numbers, row by row, to start from: where a point of the fixed
 * image is in the moving one), `roi` (a box in the fixed image's
 * coordinates, `[x0, y0, z0, x1, y1, z1]` in millimetres; only what is in it
 * is compared) and `seed` (the same seed gives the same answer).
 *
 * Result: the Spatial Registration object that was stored (`sopInstanceUid`,
 * `seriesInstanceUid`, `studyInstanceUid`: it is filed in the study of the
 * fixed series), the two frames, and the matrix both ways.
 *
 * The two volume files are in the job's directory while the job runs, and
 * the directory is removed when it has ended.
 */
export function rigidRegistrationKind(parts: RigidRegistrationParts): JobKind {
  const [program, ...leading] = parts.program;
  const threads = parts.threads ?? 4;
  const now = parts.now ?? (() => new Date());

  return {
    name: RIGID_REGISTRATION_KIND,
    description:
      'Finds the rigid registration between two image series (fixedSeriesUid, movingSeriesUid; optionally initial, roi, seed) and stores it as a Spatial Registration object.',
    timeoutMs: parts.timeoutMs ?? 30 * 60_000,
    removeWorkDir: true,

    command: (given, { workDir }) => ({
      file: program,
      args: [...leading, ...pairArguments(readInputs(given), workDir, threads)],
    }),
    check: (given) => checkPair(parts.pacs(), readInputs(given)),
    subject: (given) => subjectOfPair(parts.pacs(), readInputs(given)),
    prepare: (given, context) => preparePair(parts.pacs(), readInputs(given), context),

    async finish(given, { workDir }) {
      const inputs = readInputs(given);
      const pacs = parts.pacs();
      const fixedToMoving = rigidMatrix((await readResultFile(workDir))?.['fixedToMoving']);
      if (!fixedToMoving) throw new JobStepError('no-result');
      const pair = await pairForResult(pacs, inputs);

      // What the tool found maps the fixed frame to the moving one. The object
      // is in the fixed frame and maps the moving frame into it: the inverse.
      const movingToFixed = invertTransform(
        matrixTransform({
          id: 'automatic-rigid',
          from: pair.fixedFrame,
          to: pair.movingFrame,
          matrix: fixedToMoving,
        }),
      );
      const made = now();
      const bytes = writeSpatialRegistration(
        { registeredFrame: pair.fixedFrame, transforms: [movingToFixed] },
        {
          ...filedWith(pair.study),
          seriesDescription: 'Automatic rigid registration',
          description: automaticRigidName(made),
          createdAt: made,
        },
      );
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
        // Where a point of the moving image is in the fixed one: what the object holds.
        movingToFixed: [...movingToFixed.matrix],
        // Where a point of the fixed image is in the moving one: what the tool found.
        fixedToMoving,
        seed: inputs.seed,
      };
    },
  };
}
