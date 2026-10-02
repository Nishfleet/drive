---
title: Benchmarks
description: Measured speed numbers, including where we lose.
---

# Benchmarks

Every figure on this page is measured, or it says it is not yet measured. A
loss is labelled a loss. Nothing here is estimated.

Linux numbers are from real storage on a VPS, with the date, the region, the
link speed and the commit. A stand-in on the same machine is not a published
number. Mac numbers from the spec (first frame of a 5 GB video under 3 s, a
1 GB save within 10 s) stay not yet measured until they are run on a Mac.

The suite is Go tests in the repository: `go test ./cmd/drive` with `-bench`.
There is no helper script.

{{BENCHMARKS}}
