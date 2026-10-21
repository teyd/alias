# AWS payload fixtures

We copied these files from the AWS documentation on 2026-10-21. Where the docs break a long header
value across lines, the copies join the lines with a single space. Nothing else changed. Contract tests
decode these with the schemas in `src/`, and the emulators in `tools/` must produce payloads the same
schemas accept.

| File                         | Source                                                                               |
| ---------------------------- | ------------------------------------------------------------------------------------ |
| `ses-lambda-event.json`      | https://docs.aws.amazon.com/ses/latest/dg/receiving-email-action-lambda-event.html   |
| `function-url-request.json`  | https://docs.aws.amazon.com/lambda/latest/dg/urls-invocation.html (request payload)  |
| `function-url-response.json` | https://docs.aws.amazon.com/lambda/latest/dg/urls-invocation.html (response payload) |

Payloads recorded from a real AWS account go next to these with a `recorded-` prefix (roadmap phase 2).
