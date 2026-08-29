// T-54: back-off for the judge client. Kept out of clients.baml on purpose:
// that file is part of the T-26 prompt hash, and a retry policy changes
// when the judge is asked, not what it is asked.
retry_policy JudgeRetry {
  max_retries 3
  strategy {
    type exponential_backoff
    delay_ms 500
    multiplier 2.0
    max_delay_ms 8000
  }
}
