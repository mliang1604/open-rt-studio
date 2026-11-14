/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  REDACTED,
  SILENT_LOGGER,
  createLogger,
  errorFields,
  identifies,
  type LogLevel,
} from './logger.js';

const AT = new Date('2026-11-13T12:00:00.000Z');

function capture(level: LogLevel = 'debug') {
  const lines: string[] = [];
  const logger = createLogger({ level, write: (line) => lines.push(line), now: () => AT });
  return { logger, lines, parsed: () => lines.map((line) => JSON.parse(line) as object) };
}

describe('createLogger', () => {
  it('writes one JSON object per line: time, level, event, then the fields', () => {
    const { logger, lines } = capture();
    logger.info('listening', { host: '127.0.0.1', port: 4300 });
    expect(lines).toEqual([
      '{"time":"2026-11-13T12:00:00.000Z","level":"info","event":"listening","host":"127.0.0.1","port":4300}',
    ]);
  });

  it('logs at its level and above', () => {
    const { logger, parsed } = capture('warn');
    logger.debug('a');
    logger.info('b');
    logger.warn('c');
    logger.error('d');
    expect(parsed()).toMatchObject([
      { level: 'warn', event: 'c' },
      { level: 'error', event: 'd' },
    ]);
  });

  it('logs nothing when silent', () => {
    const { logger, lines } = capture('silent');
    logger.error('failed');
    expect(lines).toEqual([]);
    expect(() => SILENT_LOGGER.error('failed', { count: 1 })).not.toThrow();
  });

  it("a child adds its fields to every line; a line's own field wins", () => {
    const { logger, parsed } = capture();
    const child = logger.child({ job: 7, kind: 'ingest' });
    child.info('began');
    child.child({ step: 2 }).info('progress', { kind: 'index' });
    expect(parsed()).toMatchObject([
      { event: 'began', job: 7, kind: 'ingest' },
      { event: 'progress', job: 7, kind: 'index', step: 2 },
    ]);
  });

  it('keeps a field from replacing the time, the level or the event', () => {
    const { logger, parsed } = capture();
    logger.info('request', { time: 'never', level: 'error', event: 'other', status: 200 });
    expect(parsed()).toEqual([
      { time: AT.toISOString(), level: 'info', event: 'request', status: 200 },
    ]);
  });

  it('leaves out a field that is undefined, and keeps one that is null', () => {
    const { logger, parsed } = capture();
    logger.info('request', { method: undefined, status: null });
    expect(parsed()).toEqual([
      { time: AT.toISOString(), level: 'info', event: 'request', status: null },
    ]);
  });

  it('never writes what a field that identifies a person holds', () => {
    const { logger, lines } = capture();
    logger.child({ patientId: 'SYN-0001' }).warn('stored', {
      PatientName: 'SYNTHETIC^PHANTOM',
      patient_birth_date: '19700101',
      accessionNumber: 'A-42',
      mrn: '0001',
      instances: 12,
    });
    expect(JSON.parse(lines[0])).toEqual({
      time: AT.toISOString(),
      level: 'warn',
      event: 'stored',
      patientId: REDACTED,
      PatientName: REDACTED,
      patient_birth_date: REDACTED,
      accessionNumber: REDACTED,
      mrn: REDACTED,
      instances: 12,
    });
    expect(lines[0]).not.toMatch(/SYN-0001|SYNTHETIC|19700101|A-42/);
  });
});

describe('identifies', () => {
  it.each([
    'patientName',
    'PatientID',
    'patient_id',
    'patient-birth-date',
    'otherPatientIds',
    'accessionNumber',
    'birthDate',
    'mrn',
    'referringPhysicianName',
    'operatorsName',
    'personName',
  ])('%s identifies a person', (field) => expect(identifies(field)).toBe(true));

  it.each(['port', 'status', 'route', 'instances', 'ms', 'modality', 'count', 'signal'])(
    '%s does not',
    (field) => expect(identifies(field)).toBe(false),
  );
});

describe('errorFields', () => {
  it("logs an error's kind and message, and nothing else of it", () => {
    expect(errorFields(new RangeError('too far'))).toEqual({
      errorName: 'RangeError',
      errorMessage: 'too far',
    });
    expect(errorFields('just text')).toEqual({
      errorName: 'NotAnError',
      errorMessage: 'just text',
    });
  });
});
