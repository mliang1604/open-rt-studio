# Security policy

Open RT Studio is research and education software and is **not for clinical
use**. It is in early development and no version is supported for production.
Fixes go to `main`.

## Reporting a vulnerability

Please report privately, not in a public issue:

1. Open the repository's **Security** tab and choose **Report a
   vulnerability** (GitHub private vulnerability reporting).
2. Describe what you found, how to reproduce it and what an attacker could do.

You should get a reply within a week. Please give the maintainer reasonable
time to fix the problem before you publish details.

## Patient data in the repository

If you find something that looks like real patient data in this repository,
its history, an issue, a pull request or a release, report it the same private
way and do not copy or quote the data. See the
[test data policy](docs/test-data.md).

## Scope

Things worth reporting include:

- Code execution or file access through a crafted DICOM file
- Problems in the Electron shell (bridge, sandbox, update mechanism)
- Authentication, authorization or audit-log problems in the server
- Unauthenticated DIMSE or HTTP access to stored data
- Dependencies with known vulnerabilities that affect the application

Open RT Studio must never be the only safeguard for patient data. Deployments
that hold real data are outside what this project supports.
