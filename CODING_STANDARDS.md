# Coding standards

## Review rules

- In Effect code, return an expected failure with `Effect.fail` and its typed
  error; do not `throw` it. A `throw` means a bug, and Effect reports it as a
  defect.
- Use `Effect.try` and `Effect.tryPromise` only around a call the project does
  not own that throws, such as file I/O, `JSON.parse`, or a library, and wrap
  only that call. The `catch` returns a new failure with a fixed message or
  narrows with `instanceof`. It never casts the caught value.
