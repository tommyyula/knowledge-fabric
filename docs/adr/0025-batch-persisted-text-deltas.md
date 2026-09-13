# Batch persisted text deltas

Knowledge Fabric keeps `ontology_run_events` as the durable, ordered source for Run Replay, but persists consecutive `text-delta` events as bounded text segments rather than the model provider's original token fragments. The live SSE and replay contracts remain unchanged: a segment uses the existing `text-delta` shape, while event order and terminal outcome remain durable; segments flush at 250 ms, 4 KB, every non-text event, and every terminal or run-end boundary. This applies only to new runs, avoiding a risky historical rewrite or a second event store.

## Considered Options

- Persist every provider fragment: preserves token boundaries but creates excessive JSONB rows, index entries, round trips, and write latency.
- Add a separate transcript table or alter the API: reduces rows but introduces dual persistence and compatibility work without improving the replay contract.
- Rewrite historical events now: reclaims existing space but makes the delivery operationally risky; historic data remains readable and will be handled separately if retention requires it.
