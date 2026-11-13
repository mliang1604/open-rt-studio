#!/usr/bin/env bash
# Diagnosis only (#173). Not for merging.
npm run e2e -- --repeat-each 3 2>&1 | tee e2e.log | grep -v 'pw:browser'
echo "factory errors: $(grep -c 'Could not find SharedImageBackingFactory' e2e.log) | device lost: $(grep -c 'external Instance reference' e2e.log) | adapter available: $(grep -c 'WebGPU in this browser: adapter available' e2e.log) | no adapter: $(grep -c 'WebGPU in this browser: no adapter' e2e.log)"
grep -E 'pw:browser' e2e.log | grep -E 'ERROR|FATAL' | sed -E 's/^.*pw:browser \[pid=[0-9]+\]\[err\] \[[0-9:/.]+://; s/ \+[0-9]+m?s$//' | cut -c1-230 | sed -E 's/[0-9]{3,}/N/g' | sort | uniq -c | sort -rn | head -15
grep -E '^ +[0-9]+ (failed|passed|skipped)' e2e.log
! grep -q -E '^ +[0-9]+ failed' e2e.log
