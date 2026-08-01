# Local wake capability spike

This loopback-only harness tests Chrome's built-in, on-device Web Speech API
without loading the TODOMD board, calling board APIs, or adding a wake-engine
dependency.

Run it with:

```sh
npm run voice:spike
```

Open `http://127.0.0.1:41731/` in the target browser. The server exposes only
the four static harness files, binds to loopback, sends a Content Security
Policy with `connect-src 'none'`, and has no mutation routes.

Use the protocol shown on the page for at least four armed hours. Cover quiet
speech, normal room noise, ordinary conversation, nearby media, tab
backgrounding, and Mac sleep/wake. Download the JSON metrics at the end.

The Chrome path passes only with:

- at least 95% intended wakes in quiet conditions;
- at least 90% intended wakes in normal room noise;
- no more than one false wake in four armed hours; and
- automatic recovery after ordinary recognition ends and Mac sleep/wake.

The report retains event types, counters, user agent, capability result, and
bounded errors. It does not retain audio or transcript history.
