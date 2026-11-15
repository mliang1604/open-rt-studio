/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// A file read as text by the test runner (`?raw`), for a test that holds a
// document to what the code does.
declare module '*?raw' {
  const text: string;
  export default text;
}
