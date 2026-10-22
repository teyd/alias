# AWS payload fixtures

We copied these files from the AWS documentation on 2026-10-21 and 2026-10-22. Where the docs break
a long JSON header value across lines, the copies join the lines with a single space. Nothing else
changed. Contract tests decode these with the schemas in `src/`, and the emulators in `tools/` must
produce payloads the same schemas accept.

| File                                        | Source                                                                                                        |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `ses-lambda-event.json`                     | https://docs.aws.amazon.com/ses/latest/dg/receiving-email-action-lambda-event.html                            |
| `function-url-request.json`                 | https://docs.aws.amazon.com/lambda/latest/dg/urls-invocation.html (request payload)                           |
| `function-url-response.json`                | https://docs.aws.amazon.com/lambda/latest/dg/urls-invocation.html (response payload)                          |
| `sesv2-raw-message.eml`                     | https://docs.aws.amazon.com/ses/latest/dg/send-email-raw.html (example MIME message)                          |
| `sesv2-send-email-request.json`             | https://docs.aws.amazon.com/ses/latest/APIReference-V2/API_SendEmail.html (request)                           |
| `sesv2-send-email-response.json`            | https://docs.aws.amazon.com/ses/latest/APIReference-V2/API_SendEmail.html (response)                          |
| `sns-lambda-event.json`                     | https://docs.aws.amazon.com/lambda/latest/dg/with-sns.html (example SNS event)                                |
| `sns-http-notification.json`                | https://docs.aws.amazon.com/sns/latest/dg/http-notification-json.html (body)                                  |
| `sns-http-subscription-confirmation.json`   | https://docs.aws.amazon.com/sns/latest/dg/http-subscription-confirmation-json.html (body)                     |
| `ses-event-bounce.json`                     | https://docs.aws.amazon.com/ses/latest/dg/event-publishing-retrieving-sns-examples.html (Bounce record)       |
| `ses-event-complaint.json`                  | https://docs.aws.amazon.com/ses/latest/dg/event-publishing-retrieving-sns-examples.html (Complaint record)    |
| `ssm-get-parameter-response.json`           | https://docs.aws.amazon.com/systems-manager/latest/APIReference/API_GetParameter.html (sample response)       |
| `sesv2-create-email-identity-response.json` | https://docs.aws.amazon.com/ses/latest/APIReference-V2/API_CreateEmailIdentity.html (response)                |
| `sesv2-get-email-identity-response.json`    | https://docs.aws.amazon.com/ses/latest/APIReference-V2/API_GetEmailIdentity.html (response)                   |
| `sqs-lambda-event.json`                     | https://docs.aws.amazon.com/lambda/latest/dg/with-sqs.html (example standard queue message event)             |
| `sqs-batch-response.json`                   | https://docs.aws.amazon.com/lambda/latest/dg/services-sqs-errorhandling.html (`batchItemFailures` example)    |
| `sqs-receive-message-response.json`         | https://docs.aws.amazon.com/AWSSimpleQueueService/latest/APIReference/API_ReceiveMessage.html (JSON response) |

`sesv2-raw-message.eml` is the multipart example exactly as printed, without the line numbers, with
its folded header lines and LF line endings.

`sesv2-send-email-request.json` follows the API reference's Request Syntax. The values come from the
boto3 example on the send-email-raw page, and `Content.Raw.Data` is the base64 of
`sesv2-raw-message.eml`, so the request carries that message byte for byte. Regenerate it from the
`.eml` with a script; don't edit the base64 by hand.

`sesv2-send-email-response.json` follows the Response Syntax. The docs show only `"string"` for
`MessageId`, so the value is the example message ID used across the SES documentation.

The SNS HTTP fixtures are the JSON bodies of the documented POST requests, without the HTTP head.
`sns-lambda-event.json` keeps the page's `&amp;` inside `UnsubscribeUrl` as printed (the page
escapes the ampersand twice) and its mixed spelling: `SigningCertURL` but `UnsubscribeUrl`.

`ssm-get-parameter-response.json` is the API reference's sample response as printed. Its request
has no `WithDecryption`, so `Value` is the ciphertext; a decrypted response differs only there (KMS
developer guide, "AWS KMS encryption for Parameter Store SecureString parameters").

The SQS fixtures were copied on 2026-10-22. `sqs-receive-message-response.json` is the body of the
first "AWS JSON protocol" sample response, without the HTTP head.

The two `sesv2-*-email-identity-response.json` files follow the Response Syntax, field for field and
in its order, with values the reference allows but doesn't print (it shows only `"string"`, `number`
and `boolean`): a domain with Easy DKIM pending right after creation, then verified, with a custom
MAIL FROM domain still pending. The DKIM tokens are made up in the shape SES uses (lowercase base32),
`SigningHostedZone` is a guess at eu-west-1's zone (the identity guide's only example is
`token.dkim.us-west-2.amazonses.com`; production uses whatever SES returns, `dkim.amazonses.com` if nothing),
and `VerificationInfo` leaves out the optional `ErrorType` and `SOARecord`. Record real ones in phase 2.

Payloads recorded from a real AWS account go next to these with a `recorded-` prefix (roadmap phase 2).
