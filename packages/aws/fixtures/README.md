# AWS payload fixtures

We copied these files from the AWS documentation on 2026-10-21 and 2026-10-22. Where the docs break
a long JSON header value across lines, the copies join the lines with a single space. Nothing else
changed. Contract tests decode these with the schemas in `src/`, and the emulators in `tools/` must
produce payloads the same schemas accept.

| File                             | Source                                                                               |
| -------------------------------- | ------------------------------------------------------------------------------------ |
| `ses-lambda-event.json`          | https://docs.aws.amazon.com/ses/latest/dg/receiving-email-action-lambda-event.html   |
| `function-url-request.json`      | https://docs.aws.amazon.com/lambda/latest/dg/urls-invocation.html (request payload)  |
| `function-url-response.json`     | https://docs.aws.amazon.com/lambda/latest/dg/urls-invocation.html (response payload) |
| `sesv2-raw-message.eml`          | https://docs.aws.amazon.com/ses/latest/dg/send-email-raw.html (example MIME message) |
| `sesv2-send-email-request.json`  | https://docs.aws.amazon.com/ses/latest/APIReference-V2/API_SendEmail.html (request)  |
| `sesv2-send-email-response.json` | https://docs.aws.amazon.com/ses/latest/APIReference-V2/API_SendEmail.html (response) |

`sesv2-raw-message.eml` is the multipart example exactly as printed, without the line numbers, with
its folded header lines and LF line endings.

`sesv2-send-email-request.json` follows the API reference's Request Syntax. The values come from the
boto3 example on the send-email-raw page, and `Content.Raw.Data` is the base64 of
`sesv2-raw-message.eml`, so the request carries that message byte for byte. Regenerate it from the
`.eml` with a script; don't edit the base64 by hand.

`sesv2-send-email-response.json` follows the Response Syntax. The docs show only `"string"` for
`MessageId`, so the value is the example message ID used across the SES documentation.

Payloads recorded from a real AWS account go next to these with a `recorded-` prefix (roadmap phase 2).
