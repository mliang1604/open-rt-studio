/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// For specs only; not exported from the package.

type Schema = Readonly<Record<string, unknown>>;

const typeOf = (value: unknown): string =>
  value === null
    ? 'null'
    : Array.isArray(value)
      ? 'array'
      : Number.isInteger(value)
        ? 'integer'
        : typeof value;

/**
 * What is wrong with a value against a JSON Schema, as a list of sentences;
 * empty when nothing is. It knows the keywords the API's schemas use (type,
 * properties, required, additionalProperties, items, enum, pattern,
 * minimum, maximum, maxLength, $ref into `schemas`) and refuses any other, so
 * that a schema cannot say something this does not check.
 */
export function violations(
  value: unknown,
  schema: Schema,
  schemas: Readonly<Record<string, Schema>>,
  at = 'value',
): string[] {
  const known = new Set([
    ...['type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'pattern'],
    ...['minimum', 'maximum', 'maxLength', '$ref', 'description', 'default'],
  ]);
  for (const keyword of Object.keys(schema)) {
    if (!known.has(keyword)) return [`${at}: the schema uses "${keyword}", which is not checked`];
  }
  if (typeof schema['$ref'] === 'string') {
    const name = schema['$ref'].replace('#/components/schemas/', '');
    const target = schemas[name];
    return target ? violations(value, target, schemas, at) : [`${at}: no schema named ${name}`];
  }
  const wrong: string[] = [];
  const type = typeOf(value);
  if (schema['type'] !== undefined) {
    const allowed = ([] as unknown[]).concat(schema['type']);
    // An integer is a number too.
    if (!allowed.includes(type) && !(type === 'integer' && allowed.includes('number'))) {
      return [`${at}: is ${type}, not ${allowed.join(' or ')}`];
    }
  }
  if (Array.isArray(schema['enum']) && !schema['enum'].includes(value)) {
    wrong.push(`${at}: is not one of ${schema['enum'].join(', ')}`);
  }
  if (typeof value === 'string') {
    if (typeof schema['pattern'] === 'string' && !new RegExp(schema['pattern']).test(value)) {
      wrong.push(`${at}: does not match ${schema['pattern']}`);
    }
    if (typeof schema['maxLength'] === 'number' && value.length > schema['maxLength']) {
      wrong.push(`${at}: is longer than ${schema['maxLength']}`);
    }
  }
  if (typeof value === 'number') {
    if (typeof schema['minimum'] === 'number' && value < schema['minimum']) {
      wrong.push(`${at}: is below ${schema['minimum']}`);
    }
    if (typeof schema['maximum'] === 'number' && value > schema['maximum']) {
      wrong.push(`${at}: is above ${schema['maximum']}`);
    }
  }
  if (type === 'array' && schema['items']) {
    (value as unknown[]).forEach((item, i) => {
      wrong.push(...violations(item, schema['items'] as Schema, schemas, `${at}[${i}]`));
    });
  }
  if (type === 'object') {
    const properties = (schema['properties'] ?? {}) as Record<string, Schema>;
    const given = value as Record<string, unknown>;
    for (const name of (schema['required'] ?? []) as string[]) {
      if (!(name in given)) wrong.push(`${at}: has no ${name}`);
    }
    for (const [name, inner] of Object.entries(given)) {
      if (properties[name])
        wrong.push(...violations(inner, properties[name], schemas, `${at}.${name}`));
      else if (schema['additionalProperties'] === false)
        wrong.push(`${at}: has an unknown ${name}`);
    }
  }
  return wrong;
}
