/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Levels from least to most severe; `silent` logs nothing. */
export const LOG_LEVELS = ['debug', 'info', 'warn', 'error', 'silent'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/** What a log field may hold: plain values only, so a whole object cannot be logged by accident. */
export type LogValue = string | number | boolean | null | undefined;
export type LogFields = Readonly<Record<string, LogValue>>;

/**
 * Structured logging: one JSON object per line, with a time, a level, an event
 * and fields.
 *
 * **Logs carry no patient identifiers.** The event is a fixed word for what
 * happened, never a sentence built from data; what varies goes into fields,
 * and a field says how many, how long or which kind, not who. As a net under
 * that rule, a field whose name says it identifies a person is written as
 * `[redacted]` whatever it holds (see {@link identifies}). The net does not
 * make it right to pass such a field.
 */
export interface Logger {
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
  /** A logger that adds these fields to every line. */
  child(fields: LogFields): Logger;
}

export interface LoggerOptions {
  readonly level: LogLevel;
  /** Where a finished line goes; standard output by default. */
  readonly write?: (line: string) => void;
  /** The clock, for tests. */
  readonly now?: () => Date;
}

export const REDACTED = '[redacted]';

/** Parts of a field name that say the field identifies a person. */
const IDENTIFYING = ['patient', 'accession', 'birth', 'mrn', 'physician', 'operator', 'personname'];

/**
 * Whether a field's name says it identifies a person: `patientName`,
 * `patient_id`, `PatientBirthDate`, `accessionNumber`, `mrn` and the like.
 */
export function identifies(field: string): boolean {
  const name = field.toLowerCase().replace(/[^a-z]/g, '');
  return IDENTIFYING.some((part) => name.includes(part));
}

/** What to log of something caught: its kind and message, and no more. */
export function errorFields(error: unknown): LogFields {
  return error instanceof Error
    ? { errorName: error.name, errorMessage: error.message }
    : { errorName: 'NotAnError', errorMessage: String(error) };
}

/** A logger that writes nothing, for tests and for an embedder that does not want logs. */
export const SILENT_LOGGER: Logger = createLogger({ level: 'silent' });

export function createLogger(options: LoggerOptions, bound: LogFields = {}): Logger {
  const threshold = LOG_LEVELS.indexOf(options.level);
  const write = options.write ?? ((line: string) => void process.stdout.write(line + '\n'));
  const now = options.now ?? (() => new Date());

  const log = (level: Exclude<LogLevel, 'silent'>, event: string, fields?: LogFields): void => {
    if (LOG_LEVELS.indexOf(level) < threshold) return;
    const line: Record<string, LogValue> = { time: now().toISOString(), level, event };
    for (const [key, value] of Object.entries({ ...bound, ...fields })) {
      // The three names every line has are the logger's own.
      if (key === 'time' || key === 'level' || key === 'event' || value === undefined) continue;
      line[key] = identifies(key) ? REDACTED : value;
    }
    write(JSON.stringify(line));
  };

  return {
    debug: (event, fields) => log('debug', event, fields),
    info: (event, fields) => log('info', event, fields),
    warn: (event, fields) => log('warn', event, fields),
    error: (event, fields) => log('error', event, fields),
    child: (fields) => createLogger(options, { ...bound, ...fields }),
  };
}
